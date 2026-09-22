import type { Keypair } from '@stellar/stellar-sdk'
import { usdcContractId, X402_NETWORK } from './network.js'
import { affordableOptions, policyFromEnv } from './x402Policy.js'

export interface FetchWithPaymentOptions {
  /** Per-request payment cap in USDC; overrides X402_MAX_AUTOPAY_USDC. 0 disables auto-pay. */
  maxAutoPayUsdc?: number
}

/**
 * Creates an x402-aware fetch wrapper for the agent.
 * Attempts plain fetch first. If a 402 is returned, handles the payment
 * challenge using x402HTTPClient and retries with the payment header.
 */
export function createX402Fetch(_agentKeypair: Keypair, _options: FetchWithPaymentOptions = {}) {
  const envPolicy = policyFromEnv({ network: X402_NETWORK, usdcContractId: usdcContractId() })
  const policy =
    _options.maxAutoPayUsdc === undefined
      ? envPolicy
      : { ...envPolicy, maxAutoPayUsdc: _options.maxAutoPayUsdc }

  async function fetchWithPayment(url: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(url, init)

    // No payment required — return directly
    if (response.status !== 402) {
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Request failed ${response.status}: ${text}`)
      }
      return response.json()
    }

    // 402 received — attempt x402 payment
    try {
      // @ts-ignore — @x402 packages ship ESM-only types
      const { createEd25519Signer } = await import('@x402/stellar')
      // @ts-ignore
      const { ExactStellarScheme } = await import('@x402/stellar/exact/client')
      // @ts-ignore
      const { x402Client: CoreX402Client, x402HTTPClient } = await import('@x402/core/client')

      const network = X402_NETWORK

      const signer = createEd25519Signer(_agentKeypair.secret(), network)
      const scheme = new ExactStellarScheme(signer)
      const coreClient = new CoreX402Client().register(network, scheme)
      const httpClient = new x402HTTPClient(coreClient)

      // Parse 402 body (v1 puts requirements in body, v2 in headers)
      let body: unknown
      try { body = await response.clone().json() } catch { body = undefined }

      const paymentRequired = httpClient.getPaymentRequiredResponse(
        (name: string) => response.headers.get(name),
        body,
      )

      // Keep only the options this agent is allowed to pay, so the client cannot
      // choose another. Nothing left means no payment is made at all.
      const { allowed, refused } = affordableOptions(paymentRequired.accepts ?? [], policy)
      if (allowed.length === 0) {
        throw new Error(`payment refused: ${refused.join('; ') || 'no payment options offered'}`)
      }
      paymentRequired.accepts = allowed

      const paymentPayload = await httpClient.createPaymentPayload(paymentRequired)
      const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload)

      const retryResponse = await fetch(url, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> ?? {}),
          ...paymentHeaders,
        },
      })

      if (!retryResponse.ok) {
        const text = await retryResponse.text()
        throw new Error(`x402 request failed ${retryResponse.status}: ${text}`)
      }
      return retryResponse.json()
    } catch (err) {
      throw new Error(`Payment required and x402 failed: ${(err as Error).message}`)
    }
  }

  return { fetchWithPayment }
}
