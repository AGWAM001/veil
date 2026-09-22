import { Asset, Networks } from '@stellar/stellar-sdk'

/**
 * Which Stellar network this agent serves, and every endpoint that follows
 * from it — decided in one place.
 *
 * Each module used to read its own env vars with its own testnet default. So
 * STELLAR_NETWORK=mainnet signed transactions for mainnet while balances,
 * history and account loads still came from testnet Horizon. Now one variable
 * picks the network and the endpoints come with it; the URL variables only
 * override individual endpoints.
 *
 * Mainnet by default, because that is where Veil's users are. Run a second
 * instance with STELLAR_NETWORK=testnet for testnet.
 */
export type StellarNetwork = 'mainnet' | 'testnet'

export const NETWORK: StellarNetwork =
  process.env.STELLAR_NETWORK?.trim().toLowerCase() === 'testnet' ? 'testnet' : 'mainnet'

const DEFAULTS = {
  mainnet: {
    passphrase: Networks.PUBLIC,
    horizonUrl: 'https://horizon.stellar.org',
    // SDF runs no public mainnet RPC. This is Veil's own proxy, which fails over
    // across several providers — the same one the web and mobile apps use.
    sorobanRpcUrl: 'https://app.useveilapp.xyz/api/rpc/mainnet',
    x402Network: 'stellar:pubnet',
    usdcIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  },
  testnet: {
    passphrase: Networks.TESTNET,
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    x402Network: 'stellar:testnet',
    usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  },
} as const

const d = DEFAULTS[NETWORK]

export const NETWORK_PASSPHRASE: string = d.passphrase
export const HORIZON_URL = process.env.HORIZON_URL?.trim() || d.horizonUrl
export const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL?.trim() || d.sorobanRpcUrl
export const X402_NETWORK = d.x402Network

/**
 * USDC's Stellar Asset Contract on this network, derived rather than
 * hard-coded: the contract id is a function of the asset and the passphrase.
 * A function, not a constant, so importing this module has no side effects.
 */
export function usdcContractId(): string {
  return new Asset('USDC', d.usdcIssuer).contractId(NETWORK_PASSPHRASE)
}
