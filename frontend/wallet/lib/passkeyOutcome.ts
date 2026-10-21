/**
 * A passkey ceremony has three outcomes, not two.
 *
 *   - `cancelled` — the user closed the prompt or it timed out. This is a
 *     decision, and a spend screen should return to where they were without an
 *     error banner or a half-built transaction.
 *   - `refused` — the authenticator could not answer: no credential here, no
 *     passkey support, or the page's origin does not match the wallet's relying
 *     party. Each has a specific next step.
 *   - `failed` — anything else. Worth a retry, with the real reason.
 *
 * WebAuthn reports cancellation, timeout and "this credential is not on this
 * device" through overlapping DOMExceptions, so the mapping lives here once
 * rather than in each money screen's catch block.
 */

export type PasskeyOutcome = 'cancelled' | 'refused' | 'failed'

export const PASSKEY_CANCELLED_MESSAGE = 'Passkey cancelled. Nothing was sent.'

export const PASSKEY_REFUSED_MESSAGE =
  "Your device's authenticator refused the passkey check. Make sure a passkey for this wallet is available on this device, then try again."

export const PASSKEY_UNSUPPORTED_MESSAGE =
  "This browser or device does not support passkeys. Try a browser and device that do, then try again."

export const PASSKEY_SECURITY_MESSAGE =
  "The passkey can't be used on this page. Open Veil from the same address you created the wallet with, then try again."

export const PASSKEY_NO_CREDENTIAL_MESSAGE =
  'No passkey for this wallet is available on this device. Use a device that has it, or add a passkey in Settings → Security, then try again.'

export class PasskeyCeremonyError extends Error {
  readonly outcome: PasskeyOutcome

  constructor(outcome: PasskeyOutcome, message: string) {
    super(message)
    this.name = 'PasskeyCeremonyError'
    this.outcome = outcome
  }
}

function errorName(error: unknown): string {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) return error.name
  if (error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string') {
    return (error as { name: string }).name
  }
  return ''
}

/** The most useful prose a thrown value carries, without leaking a spec URL. */
export function passkeyRawMessage(error: unknown): string {
  let raw = ''
  if (typeof error === 'string') raw = error
  else if (error instanceof Error) raw = error.message
  else if (error && typeof error === 'object') {
    const source = error as Record<string, unknown>
    raw = [source.message, source.error, source.description, source.reason]
      .find((value): value is string => typeof value === 'string' && value.trim() !== '')
      ?.trim() ?? ''
  }
  return raw.replace(/https?:\/\/\S+/g, '').replace(/\s*see:\s*$/i, '').trim()
}

export function isPasskeyCancellation(error: unknown): boolean {
  if (error instanceof PasskeyCeremonyError) return error.outcome === 'cancelled'
  const blob = `${errorName(error)} ${passkeyRawMessage(error)}`.toLowerCase()
  return (
    blob.includes('notallowederror') ||
    blob.includes('aborterror') ||
    blob.includes('cancel') ||
    blob.includes('timed out') ||
    blob.includes('timeout') ||
    blob.includes('dismiss') ||
    blob.includes('the operation was denied')
  )
}

export function classifyPasskeyError(error: unknown): PasskeyOutcome {
  if (error instanceof PasskeyCeremonyError) return error.outcome
  if (isPasskeyCancellation(error)) return 'cancelled'

  const blob = `${errorName(error)} ${passkeyRawMessage(error)}`.toLowerCase()
  if (
    blob.includes('notsupportederror') ||
    blob.includes('not supported') ||
    blob.includes('does not support') ||
    blob.includes('unsupported') ||
    blob.includes('securityerror') ||
    blob.includes('secure page') ||
    blob.includes('relying party') ||
    blob.includes('rp id') ||
    blob.includes('different domain') ||
    blob.includes('invalidstateerror') ||
    blob.includes('no credentials') ||
    blob.includes('no matching credential') ||
    blob.includes('no passkey')
  ) {
    return 'refused'
  }
  return 'failed'
}

function refusalMessage(error: unknown): string {
  const blob = `${errorName(error)} ${passkeyRawMessage(error)}`.toLowerCase()
  if (blob.includes('notsupportederror') || blob.includes('not supported') || blob.includes('does not support') || blob.includes('unsupported')) {
    return PASSKEY_UNSUPPORTED_MESSAGE
  }
  if (blob.includes('securityerror') || blob.includes('secure page') || blob.includes('relying party') || blob.includes('rp id') || blob.includes('different domain')) {
    return PASSKEY_SECURITY_MESSAGE
  }
  if (blob.includes('invalidstateerror') || blob.includes('no credentials') || blob.includes('no matching credential') || blob.includes('no passkey')) {
    return PASSKEY_NO_CREDENTIAL_MESSAGE
  }
  return PASSKEY_REFUSED_MESSAGE
}

export function toPasskeyCeremonyError(error: unknown): PasskeyCeremonyError {
  if (error instanceof PasskeyCeremonyError) return error

  const outcome = classifyPasskeyError(error)
  if (outcome === 'cancelled') {
    return new PasskeyCeremonyError('cancelled', PASSKEY_CANCELLED_MESSAGE)
  }
  if (outcome === 'refused') {
    return new PasskeyCeremonyError('refused', refusalMessage(error))
  }

  const detail = passkeyRawMessage(error)
  return new PasskeyCeremonyError(
    'failed',
    detail ? `${detail} Nothing was sent. Please try again.` : 'The passkey check failed. Nothing was sent — please try again.',
  )
}

/** What a screen should show; null means there is no error state to set. */
export function passkeyFailureMessage(error: unknown): string | null {
  const outcome = classifyPasskeyError(error)
  if (outcome === 'cancelled') return null
  return error instanceof PasskeyCeremonyError ? error.message : toPasskeyCeremonyError(error).message
}
