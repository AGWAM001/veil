import Anthropic from '@anthropic-ai/sdk'

/**
 * The model behind the agent, behind one small interface.
 *
 * Two providers:
 *
 * - **Anthropic** (default when an Anthropic credential is present): Claude via
 *   the official SDK. Best tool use; paid.
 * - **OpenRouter** (when `OPENROUTER_API_KEY` is set): free open-weight models
 *   through OpenRouter's chat-completions API, with automatic failover across
 *   several models, because the free list changes daily and any one model can
 *   vanish or rate-limit. Free tier: 20 requests/minute, and 50 a day — 1,000 a
 *   day once $10 of credit has been bought. A chat turn costs 2–4 requests.
 *
 * Each provider keeps its own native message list for the turn, so nothing is
 * lost in translation — Claude's thinking and fallback blocks go back exactly as
 * they came, and OpenRouter's tool calls keep their ids.
 */

/** A tool definition, in the JSON-Schema shape both providers accept. */
export type ToolSpec = Anthropic.Tool

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface LlmTurn {
  /** Text the model produced this turn (may be empty when it only calls tools). */
  text: string
  /** Tools it wants run. Empty means the turn is finished. */
  toolCalls: ToolCall[]
}

/** Earlier turns, as plain text — what the server keeps per wallet. */
export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

/** One user message's worth of conversation with the model. */
export interface LlmSession {
  next(): Promise<LlmTurn>
  addToolResults(results: { id: string; content: string }[]): void
}

export interface LlmProvider {
  /** For logs and /health — which provider and model(s) answer. */
  readonly label: string
  start(system: string, history: ChatTurn[], userMessage: string, tools: ToolSpec[]): LlmSession
}

// ── Anthropic ────────────────────────────────────────────────────────────────

/**
 * Claude Opus 5 unless CLAUDE_MODEL says otherwise. Thinking is on by default on
 * this model, which is why max_tokens is 16,000: thinking shares the output
 * budget, and the old 1,024 would cut a turn off before its tool call.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5'

/** Where a declined request is re-run. Only used when the primary model refuses. */
const CLAUDE_FALLBACK_MODEL = 'claude-opus-4-8'

export function anthropicProvider(options: { apiKey?: string; model?: string } = {}): LlmProvider {
  const client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {})
  const model = options.model ?? process.env.CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL

  return {
    label: `anthropic:${model}`,
    start(system, history, userMessage, tools) {
      const messages: Anthropic.Beta.BetaMessageParam[] = [
        ...history.map((t) => ({ role: t.role, content: t.content })),
        { role: 'user', content: userMessage },
      ]

      return {
        async next() {
          for (;;) {
            const response = await client.beta.messages.create({
              model,
              max_tokens: 16_000,
              // If a safety classifier declines, the API re-runs the request on
              // the fallback model instead of refusing. The array form, because
              // the pinned SDK (0.113) types only this form; the newer
              // `fallbacks: 'default'` needs a newer SDK.
              betas: ['server-side-fallback-2026-06-01'],
              fallbacks: [{ model: CLAUDE_FALLBACK_MODEL }],
              system,
              tools,
              messages,
            })

            // The full content goes back — thinking and fallback blocks included.
            messages.push({ role: 'assistant', content: response.content })

            // A server-side pause: re-send so the model can carry on.
            if (response.stop_reason === 'pause_turn') continue

            if (response.stop_reason === 'refusal') {
              return {
                text: "I can't help with that request. Try rephrasing what you need.",
                toolCalls: [],
              }
            }

            const text = response.content
              .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
              .map((b) => b.text)
              .join('')

            // Hitting max_tokens mid-tool-call leaves an incomplete call; do not run it.
            if (response.stop_reason !== 'tool_use') return { text, toolCalls: [] }

            const toolCalls = response.content
              .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
              .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }))
            return { text, toolCalls }
          }
        },

        addToolResults(results) {
          // All results in one user message: splitting them teaches the model to
          // stop making parallel calls.
          messages.push({
            role: 'user',
            content: results.map((r) => ({
              type: 'tool_result' as const,
              tool_use_id: r.id,
              content: r.content,
            })),
          })
        },
      }
    },
  }
}

// ── OpenRouter (OpenAI-compatible chat completions) ──────────────────────────

/**
 * Free models that support tool calling, checked 2026-09-22 against
 * `openrouter.ai/api/v1/models` (19 of 21 free models did). Order is preference;
 * OpenRouter falls through the list when one is down or rate-limited. The free
 * catalogue changes daily — override with AGENT_MODELS rather than editing this.
 */
export const DEFAULT_FREE_MODELS = [
  'qwen/qwen3.8-27b:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
]

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export function openRouterProvider(options: { apiKey: string; models?: string[] }): LlmProvider {
  const models = options.models?.length ? options.models : DEFAULT_FREE_MODELS

  return {
    label: `openrouter:${models.join(',')}`,
    start(system, history, userMessage, tools) {
      const messages: OpenAiMessage[] = [
        { role: 'system', content: system },
        ...history.map((t) => ({ role: t.role, content: t.content }) as OpenAiMessage),
        { role: 'user', content: userMessage },
      ]
      const functions = tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description ?? '', parameters: t.input_schema },
      }))

      return {
        async next() {
          const res = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              'Content-Type': 'application/json',
              // Attribution OpenRouter asks for; shows on their app rankings.
              'HTTP-Referer': 'https://www.useveilapp.xyz',
              'X-Title': 'Veil Agent',
            },
            body: JSON.stringify({
              model: models[0],
              models,
              messages,
              tools: functions,
              tool_choice: 'auto',
              max_tokens: 2_048,
            }),
            signal: AbortSignal.timeout(60_000),
          })

          const body = (await res.json().catch(() => ({}))) as any
          if (!res.ok || body?.error) {
            const status = body?.error?.code ?? res.status
            if (status === 429) {
              throw new Error('The assistant is busy right now. Try again in a minute.')
            }
            throw new Error(`Model provider error (${status})`)
          }

          const message = body?.choices?.[0]?.message ?? {}
          const rawCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : []
          messages.push({
            role: 'assistant',
            content: message.content ?? null,
            ...(rawCalls.length ? { tool_calls: rawCalls } : {}),
          })

          const toolCalls: ToolCall[] = rawCalls.map((c) => {
            let input: Record<string, unknown> = {}
            try {
              input = JSON.parse(c?.function?.arguments || '{}')
            } catch {
              // Malformed arguments from a weaker model: let the tool report it
              // rather than guessing what was meant.
              input = { __invalid_arguments: c?.function?.arguments ?? '' }
            }
            return { id: String(c.id), name: String(c?.function?.name ?? ''), input }
          })

          return { text: typeof message.content === 'string' ? message.content : '', toolCalls }
        },

        addToolResults(results) {
          for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content })
        },
      }
    },
  }
}

// ── Selection ────────────────────────────────────────────────────────────────

/**
 * The provider for this deployment, from the environment.
 *
 * LLM_PROVIDER=anthropic|openrouter forces a choice. Otherwise OpenRouter is
 * used when OPENROUTER_API_KEY is set, and Claude when it is not.
 */
export function providerFromEnv(): LlmProvider {
  const forced = process.env.LLM_PROVIDER?.trim().toLowerCase()
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim()

  if (forced === 'openrouter' || (!forced && openRouterKey)) {
    if (!openRouterKey) throw new Error('LLM_PROVIDER=openrouter needs OPENROUTER_API_KEY')
    const models = process.env.AGENT_MODELS?.split(',').map((m) => m.trim()).filter(Boolean)
    return openRouterProvider({ apiKey: openRouterKey, models })
  }
  return anthropicProvider()
}
