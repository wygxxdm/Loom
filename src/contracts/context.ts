import type { ChatMessage } from './model.ts'
import type { ToolSpec } from './tools.ts'

export interface ContextRequest {
  readonly system?: string
  readonly signal?: AbortSignal
}

/** 交给模型的一次视图。它是投影，不是事实。 */
export interface ContextView {
  readonly system?: string
  readonly messages: readonly ChatMessage[]
  readonly tools: readonly ToolSpec[]
  /** 本次是压缩后的视图，还是全量历史。 */
  readonly compacted: boolean
}

/** 用量观测。`scale` 是估算器的自校准系数，越大说明此前低估得越多。 */
export interface UsageStats {
  readonly estTokens: number
  readonly maxTokens: number
  readonly ratio: number
  readonly scale: number
  readonly entriesTotal: number
  readonly entriesSent: number
  readonly compacted: boolean
}

export interface CompactorPort {
  build(request: ContextRequest): Promise<ContextView>
  /**
   * 立即压缩一次，不看阈值。
   *
   * 与 build 的区别：build 会先判断用量，compact 是“现在就把历史收掉”。
   * 摘要会缓存下来，后续 build 命中阈值时直接复用。
   */
  compact(signal?: AbortSignal): Promise<UsageStats>
  stats(): UsageStats | undefined
  /** 用服务端返回的真实 prompt token 校准估算器。 */
  observe(actualPromptTokens: number): void
}
