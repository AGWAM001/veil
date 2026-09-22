import { describe, it, expect } from '@jest/globals'
import { runAgent } from '../agent.js'
import type { LlmProvider, LlmTurn } from '../llm.js'

/**
 * The agent loop, against a scripted provider — no model, no key, no network.
 *
 * Covers what the provider change must not break (tool results reach the model,
 * a transaction reaches the user) and the bound that was missing: the loop used
 * to run for as long as the model kept asking for tools.
 */

function scripted(turns: LlmTurn[]): LlmProvider & { results: { id: string; content: string }[][] } {
  const results: { id: string; content: string }[][] = []
  return {
    label: 'scripted',
    results,
    start() {
      let i = 0
      return {
        async next() {
          return turns[Math.min(i++, turns.length - 1)]
        },
        addToolResults(r) {
          results.push(r)
        },
      }
    },
  }
}

const wallet = 'CWALLET'

describe('runAgent', () => {
  it('returns the model text when no tools are called', async () => {
    const llm = scripted([{ text: 'Hello!', toolCalls: [] }])
    const result = await runAgent('hi', wallet, [], undefined, undefined, llm)
    expect(result.response).toBe('Hello!')
    expect(result.pendingTxXdr).toBeUndefined()
  })

  it('hands a transaction to the user for approval, with the tool result threaded back', async () => {
    const llm = scripted([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'request_user_approval',
            input: { transaction_xdr: 'AAAA', summary: 'Send 1 XLM' },
          },
        ],
      },
      { text: 'Approve the payment in your wallet.', toolCalls: [] },
    ])

    const result = await runAgent('send 1 xlm', wallet, [], undefined, undefined, llm)

    expect(result.pendingTxXdr).toBe('AAAA')
    expect(result.pendingTxSummary).toBe('Send 1 XLM')
    expect(result.response).toBe('Approve the payment in your wallet.')
    expect(llm.results).toEqual([[{ id: 'call_1', content: JSON.stringify({ status: 'awaiting_approval' }) }]])
  })

  it('reports an unknown tool to the model instead of throwing', async () => {
    const llm = scripted([
      { text: '', toolCalls: [{ id: 'c', name: 'drain_wallet', input: {} }] },
      { text: 'Sorry, I cannot do that.', toolCalls: [] },
    ])
    const result = await runAgent('x', wallet, [], undefined, undefined, llm)
    expect(result.response).toBe('Sorry, I cannot do that.')
    expect(llm.results[0][0].content).toMatch(/Unknown tool/)
  })

  it('stops a model that never stops calling tools', async () => {
    const forever: LlmTurn = {
      text: '',
      toolCalls: [{ id: 'loop', name: 'request_user_approval', input: { transaction_xdr: 'X', summary: 's' } }],
    }
    const llm = scripted([forever])
    const result = await runAgent('loop', wallet, [], undefined, undefined, llm)

    expect(result.response).toMatch(/couldn't finish/)
    // Bounded: eight rounds of tool results, then it gives up.
    expect(llm.results).toHaveLength(8)
  })
})
