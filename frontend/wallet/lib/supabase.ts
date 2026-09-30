import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey) : null

/** Client-side data access that cannot degrade silently; throws when unconfigured. */
export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error(
      'Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY',
    )
  }
  return supabase
}

/** Track a newly deployed wallet. Fire-and-forget — never blocks the UI. */
export async function trackWalletCreated(
  contractAddress: string,
  feePayerAddress: string,
) {
  if (!supabase) return
  try {
    await supabase.from('wallets').insert({
      contract_address: contractAddress,
      fee_payer_address: feePayerAddress,
    })
  } catch {
    // Silent — analytics must never break the wallet flow
  }
}
