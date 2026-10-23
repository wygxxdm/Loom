import type { ChatMessage, ModelInput, ModelPort, ModelReply, TokenUsage } from '../contracts/model.ts'
import type { ToolCall } from '../contracts/tools.ts'
import { ModelKey } from '../contracts/keys.ts'
import type { Plugin } from '../kernel/plugin.ts'

/**
 * HTTP 层错误。带上状态码，让上层能区分“值得重试”和“重试也没用”。
 * 429 是限流、5xx 是服务端抖动，这两种退避重试有意义；4xx 其余情况没有。
 */
export class ModelHttpError extends Error {
  readonly status: number

  constructor(status: number, detail: string) {
    super(`model http ${status}: ${detail}`)
    this.name = 'ModelHttpError'
    this.status = status
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500
  }
}

export interface DeepSeekOptions {
  readonly apiKey: string
  readonly baseUrl?: string
  readonly model?: string
  readonly temperature?: number
  readonly maxTokens?: number
}

interface WireMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string | null
  readonly tool_calls?: readonly {
    readonly id: string
    readonly type: 'function'
    readonly function: { readonly name: string; readonly arguments: string }
  }[]
  readonly tool_call_id?: string
}

/**
 * DeepSeek / OpenAI 兼容 Chat Completions 适配器。
 *
 * 只做协议转换，不做任何“提示词层面的兼容”——工具调用一律走原生
 * `tools` / `tool_calls` 字段，不用文本约定伪造。
 */
export class DeepSeekModel implements ModelPort {
  readonly #options: Required<Omit<DeepSeekOptions, 'apiKey'>> & { apiKey: string }

  constructor(options: DeepSeekOptions) {
    this.#options = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? process.env.LOOM_BASE_URL ?? 'https://api.deepseek.com',
      model: options.model ?? process.env.LOOM_MODEL ?? 'deepseek-flash',
      temperature: options.temperature ?? 0,
      maxTokens: options.maxTokens ?? 8_192,
    }
  }

  async run(input: ModelInput): Promise<ModelReply> {
    const messages: WireMessage[] = [
      ...(input.system === undefined ? [] : [{ role: 'system' as const, content: input.system }]),
      ...input.messages.map(toWire),
    ]

    const body: Record<string, unknown> = {
      model: this.#options.model,
      messages,
      temperature: this.#options.temperature,
      max_tokens: this.#options.maxTokens,
    }
    if (input.tools.length > 0) {
      body.tools = input.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.schema },
      }))
      body.tool_choice = 'auto'
    }

    const response = await fetch(`${this.#options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#options.apiKey}`,
      },
      body: JSON.stringify(body),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new ModelHttpError(response.status, detail.slice(0, 400))
    }

    return parseReply(await response.json())
  }
}

function toWire(message: ChatMessage): WireMessage {
  if (message.role === 'user') {
    return { role: 'user', content: message.text }
  }
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.callId, content: message.output }
  }
  if (message.calls.length === 0) {
    return { role: 'assistant', content: message.text }
  }
  return {
    role: 'assistant',
    content: message.text.length > 0 ? message.text : null,
    tool_calls: message.calls.map((call) => ({
      id: call.id,
      type: 'function' as const,
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    })),
  }
}

function parseReply(payload: unknown): ModelReply {
  const root = payload as { choices?: { message?: Record<string, unknown> }[]; usage?: Record<string, unknown> }
  const message = root.choices?.[0]?.message
  if (message === undefined) {
    throw new Error('model response has no choices[0].message')
  }

  const usage = toUsage(root.usage)
  const rawCalls = message.tool_calls

  if (Array.isArray(rawCalls) && rawCalls.length > 0) {
    const calls: ToolCall[] = rawCalls.map((item, index) => {
      const wire = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
      const name = wire.function?.name
      const rawArgs = wire.function?.arguments
      if (typeof name !== 'string') {
        throw new Error(`model tool call ${index} has no function.name`)
      }
      let args: Record<string, unknown> = {}
      if (typeof rawArgs === 'string' && rawArgs.trim().length > 0) {
        try {
          const parsed: unknown = JSON.parse(rawArgs)
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>
          } else {
            throw new Error('not an object')
          }
        } catch {
          throw new Error(`model tool call "${name}" returned unparsable arguments`)
        }
      }
      return {
        id: typeof wire.id === 'string' ? wire.id : `call_${index}`,
        name,
        args,
      }
    })

    return {
      kind: 'calls',
      calls,
      ...(typeof message.content === 'string' ? { text: message.content } : {}),
      ...(usage === undefined ? {} : { usage }),
    }
  }

  return {
    kind: 'message',
    text: typeof message.content === 'string' ? message.content : '',
    ...(usage === undefined ? {} : { usage }),
  }
}

function toUsage(raw: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (raw === undefined) return undefined
  const prompt = raw.prompt_tokens
  const completion = raw.completion_tokens
  if (typeof prompt !== 'number' || typeof completion !== 'number') return undefined
  return { prompt, completion }
}

export function deepseekPlugin(options: DeepSeekOptions): Plugin {
  return {
    name: 'model-deepseek',
    provides: [ModelKey],
    setup(scope) {
      scope.provide(ModelKey, new DeepSeekModel(options))
    },
  }
}
