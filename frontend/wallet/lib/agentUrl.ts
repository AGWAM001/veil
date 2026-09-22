/** The hosted agent — the default once V152 lands. */
export const PRODUCTION_AGENT_URL = 'wss://veil-agent.onrender.com'

/** Hosts where a plaintext socket is fine: this machine or the LAN. */
function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || /^192\.168\./.test(host) || /^10\./.test(host)
}

/**
 * Which agent server to connect to.
 *
 * **Deliberately not defaulted to the hosted agent in production.** The web
 * agent page does not yet verify the transactions it is asked to approve the
 * way the mobile app does (tracked as V152). Until it does, production web stays
 * disconnected unless NEXT_PUBLIC_AGENT_WS_URL is set on purpose; when V152
 * lands, default to PRODUCTION_AGENT_URL here as mobile does.
 *
 * A plaintext ws:// URL to anything but a local host is upgraded to wss://: the
 * socket carries transaction XDR, which must not cross the internet readable and
 * modifiable by anything on the path. Same rule as frontend/mobile/lib/agentSocket.ts.
 */
export function resolveAgentUrl(configured: string | undefined): string {
  const url = configured?.trim()
  if (!url) return 'ws://localhost:3001'
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'ws:' && !isLocalHost(parsed.hostname)) {
      return 'wss:' + url.slice('ws:'.length)
    }
  } catch {
    return 'ws://localhost:3001'
  }
  return url
}
