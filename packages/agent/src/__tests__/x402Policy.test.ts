import { describe, it, expect } from '@jest/globals'
import { affordableOptions, refusalReason, type X402Policy } from '../x402Policy.js'

/**
 * The agent pays x402 demands from one key that every user shares. These pin
 * down that it pays only what it should — the client it replaced paid anything.
 */

const USDC = 'CUSDCCONTRACT'
const policy: X402Policy = {
  maxAutoPayUsdc: 0.01,
  network: 'stellar:pubnet',
  usdcContractId: USDC,
  allowedPayTo: [],
}

// 0.001 USDC in base units (7 decimals).
const ok = { network: 'stellar:pubnet', asset: USDC, payTo: 'GLENS', amount: '10000' }

describe('x402 payment policy', () => {
  it('pays a small USDC demand on the right network', () => {
    expect(refusalReason(ok, policy)).toBeNull()
  })

  it('pays exactly the cap, and refuses one base unit more', () => {
    expect(refusalReason({ ...ok, amount: '100000' }, policy)).toBeNull()
    expect(refusalReason({ ...ok, amount: '100001' }, policy)).toMatch(/over the 0.01 USDC limit/)
  })

  it('refuses a demand far above the cap without losing precision', () => {
    expect(refusalReason({ ...ok, amount: '9'.repeat(30) }, policy)).toMatch(/over/)
  })

  it('reads the v1 field name too', () => {
    const { amount, ...v1 } = ok
    expect(refusalReason({ ...v1, maxAmountRequired: amount }, policy)).toBeNull()
  })

  it('refuses the wrong network', () => {
    expect(refusalReason({ ...ok, network: 'stellar:testnet' }, policy)).toMatch(/wrong network/)
  })

  it('refuses any asset that is not USDC', () => {
    expect(refusalReason({ ...ok, asset: 'CSOMETHINGELSE' }, policy)).toBe('not USDC')
  })

  it('refuses an amount it cannot read — failing open is not a policy', () => {
    for (const amount of [undefined, '', '-5', '1.5', 'lots']) {
      expect(refusalReason({ ...ok, amount }, policy)).toBe('unreadable amount')
    }
  })

  it('pays nothing when the cap is zero', () => {
    expect(refusalReason(ok, { ...policy, maxAutoPayUsdc: 0 })).toMatch(/turned off/)
  })

  it('honours a recipient allow list when one is set', () => {
    const listed = { ...policy, allowedPayTo: ['GLENS'] }
    expect(refusalReason(ok, listed)).toBeNull()
    expect(refusalReason({ ...ok, payTo: 'GATTACKER' }, listed)).toMatch(/allow list/)
  })

  it('keeps only the options it may pay, so the client cannot pick another', () => {
    const expensive = { ...ok, amount: '50000000' }
    const { allowed, refused } = affordableOptions([expensive, ok], policy)
    expect(allowed).toEqual([ok])
    expect(refused).toHaveLength(1)
  })
})
