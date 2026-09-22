import { HORIZON_URL, USDC_ISSUER } from './network.js'

/**
 * Asset prices from Stellar's own DEX, via Horizon path-finding.
 *
 * This replaced the Lens oracle, which charged per call over x402 and made the
 * agent hold a funded key of its own. Horizon's strict-send paths answer the
 * question a user is actually asking — "if I sold one of these now, how many of
 * those would I get?" — including multi-hop routes through the order books and
 * liquidity pools, and it is free.
 */

export interface ResolvedAsset {
  /** Horizon's query form: "native" or "CODE:ISSUER". */
  horizon: string
  /** What to show a person: "XLM" or the code. */
  label: string
}

/**
 * Accepts "XLM", "native", "USDC" (resolved to the network's USDC issuer) or
 * "CODE:ISSUER". Anything else is refused: a bare code like "EURC" names no
 * particular asset on Stellar, where anyone can issue one with that code.
 */
export function resolveAsset(input: string): ResolvedAsset {
  const value = input.trim()
  const upper = value.toUpperCase()
  if (upper === 'XLM' || upper === 'NATIVE') return { horizon: 'native', label: 'XLM' }
  if (upper === 'USDC') return { horizon: `USDC:${USDC_ISSUER}`, label: 'USDC' }

  const [code, issuer] = value.split(':')
  if (code && issuer && /^G[A-Z2-7]{55}$/.test(issuer)) {
    return { horizon: `${code}:${issuer}`, label: code }
  }
  throw new Error(`Unknown asset "${input}". Use XLM, USDC, or CODE:ISSUER.`)
}

function sourceParams(asset: ResolvedAsset): Record<string, string> {
  if (asset.horizon === 'native') return { source_asset_type: 'native' }
  const [code, issuer] = asset.horizon.split(':')
  return {
    source_asset_type: code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
    source_asset_code: code,
    source_asset_issuer: issuer,
  }
}

export interface PriceQuote {
  pair: string
  /** Units of asset_b received for one unit of asset_a, at current liquidity. */
  price: number
  /** How many hops the best route takes (0 = direct). */
  hops: number
  source: 'stellar-dex'
}

export async function getPrice(assetA: string, assetB: string): Promise<PriceQuote> {
  const a = resolveAsset(assetA)
  const b = resolveAsset(assetB)
  if (a.horizon === b.horizon) return { pair: `${a.label}/${b.label}`, price: 1, hops: 0, source: 'stellar-dex' }

  const params = new URLSearchParams({
    ...sourceParams(a),
    source_amount: '1',
    destination_assets: b.horizon,
  })
  const res = await fetch(`${HORIZON_URL}/paths/strict-send?${params}`, {
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Price lookup failed (${res.status})`)

  const records: { destination_amount: string; path: unknown[] }[] =
    ((await res.json()) as any)?._embedded?.records ?? []
  if (records.length === 0) throw new Error(`No market between ${a.label} and ${b.label} right now`)

  const best = records.reduce((top, r) =>
    Number(r.destination_amount) > Number(top.destination_amount) ? r : top,
  )
  return {
    pair: `${a.label}/${b.label}`,
    price: Number(best.destination_amount),
    hops: best.path.length,
    source: 'stellar-dex',
  }
}
