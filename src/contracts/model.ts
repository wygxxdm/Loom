import type { ToolCall, ToolSpec } from './tools.ts'

/**
 * 发给模型的单条消息。
 *
 * 与 Session 中的记录不同，这里已经是「可以直连 API」的形态：
 * assistant 允许同时带文本与工具调用（模型经常边想边调）。
 */
export type ChatMessage =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly text: string; readonly calls: readonly ToolCall[] }
  | { readonly role: 'tool'; readonly callId: string; readonly name: string; readonly output: string }

/** 服务端返回的真实用量。这是唯一可信的 token 来源。 */
export interface TokenUsage {
  readonly prompt: number
  readonly completion: number
}

export type ModelReply =
  | { readonly kind: 'message'; readonly text: string; readonly usage?: TokenUsage }
  | { readonly kind: 'calls'; readonly calls: readonly ToolCall[]; readonly text?: string; readonly usage?: TokenUsage }

export interface ModelInput {
  readonly system?: string
  readonly messages: readonly ChatMessage[]
  readonly tools: readonly ToolSpec[]
  readonly signal?: AbortSignal
}

export interface ModelPort {
  run(input: ModelInput): Promise<ModelReply>
}
