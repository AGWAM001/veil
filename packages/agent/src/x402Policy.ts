/**
 * What the agent may pay for without asking anyone.
 *
 * The agent pays x402 demands from its own key, which every user shares. The
 * client used to pay any 402 in full — any amount, any asset, any recipient, any
 * network — and `maxAutoPayUsdc` was declared but never read. So a single
 * conversation could loop paid tool calls, or be pointed at a server demanding
 * a large sum, and drain the key.
 *
 * Now a payment option is acceptable only if it is on this network, in USDC, to
 * an allowed recipient (when a list is set), and at or under the per-call cap.
 * Anything that cannot be read as such is refused: a payment policy that fails
 * open is not a policy.
 */

/** USDC on Stellar has 7 decimal places; x402 amounts are in base units. */
const USDC_DECIMALS = 7

export interface X402Policy {
  /** Most the agent pays for one request, in USDC. 0 disables auto-pay. */
  maxAutoPayUsdc: number
  /** CAIP-2 style network id this agent pays on, e.g. `stellar:pubnet`. */
  network: string
  /** USDC's Stellar Asset Contract id on that network. */
  usdcContractId: string
  /** If non-empty, the only recipients the agent pays. */
  allowedPayTo: string[]
}

/** One payment option from a 402 response. x402 v1 says maxAmountRequired, v2 says amount. */
export interface PaymentOption {
  network?: string
  asset?: string
  payTo?: string
  amount?: string | number
  maxAmountRequired?: string | number
  [key: string]: unknown
}

/** Why an option was refused, for the error the caller sees. */
export function refusalReason(option: PaymentOption, policy: X402Policy): string | null {
  if (!(policy.maxAutoPayUsdc > 0)) return 'automatic payments are turned off'
  if (option.network !== policy.network) return `wrong network (${String(option.network)})`
  if (option.asset !== policy.usdcContractId) return 'not USDC'
  if (policy.allowedPayTo.length && !policy.allowedPayTo.includes(String(option.payTo))) {
    return 'recipient not on the allow list'
  }

  const raw = option.amount ?? option.maxAmountRequired
  if (raw === undefined || raw === null || !/^\d+$/.test(String(raw))) return 'unreadable amount'

  // Compare in base units with BigInt: a floating-point comparison of a large
  // demand can round in the payer's disfavour.
  const capBaseUnits = BigInt(Math.floor(policy.maxAutoPayUsdc * 10 ** USDC_DECIMALS))
  if (BigInt(String(raw)) > capBaseUnits) return `over the ${policy.maxAutoPayUsdc} USDC limit`

  return null
}

/**
 * The options the agent may pay, and a summary of why the rest were refused.
 * Callers hand only `allowed` to the x402 client, so it cannot pick another.
 */
export function affordableOptions<T extends PaymentOption>(
  options: T[],
  policy: X402Policy,
): { allowed: T[]; refused: string[] } {
  const allowed: T[] = []
  const refused: string[] = []
  for (const option of options) {
    const reason = refusalReason(option, policy)
    if (reason) refused.push(reason)
    else allowed.push(option)
  }
  return { allowed, refused }
}

/** The policy from the environment, with a conservative default cap. */
export function policyFromEnv(defaults: { network: string; usdcContractId: string }): X402Policy {
  const raw = process.env.X402_MAX_AUTOPAY_USDC?.trim()
  const parsed = raw === undefined || raw === '' ? 0.01 : Number(raw)
  return {
    maxAutoPayUsdc: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0,
    network: defaults.network,
    usdcContractId: defaults.usdcContractId,
    allowedPayTo: (process.env.X402_ALLOWED_PAYTO ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}
