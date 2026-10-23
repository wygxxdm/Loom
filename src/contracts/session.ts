import type { ToolCall } from './tools.ts'

/**
 * Session 里的一条事实记录。
 *
 * 三种来源分开建模，不共用 "message"：
 * - `user`  人说的；
 * - `assistant` 模型说的（可能同时带工具调用）；
 * - `tool`  工具返回的（带 `failed` 标记，便于统计失败率）；
 * - `notice` 由 harness 注入的提示（如重复调用警告），与用户输入区分开。
 */
export type Entry =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string; readonly calls: readonly ToolCall[] }
  | { readonly kind: 'tool'; readonly callId: string; readonly name: string; readonly output: string; readonly failed: boolean }
  | { readonly kind: 'notice'; readonly text: string }

export interface SessionPort {
  /**
   * 批量追加。
   *
   * 一次 run 的一轮（assistant + 全部工具结果）必须作为一个批次写入，
   * 这样崩溃时最多丢整批，不会留下“有调用无结果”的残局。
   */
  append(entries: readonly Entry[]): void
  entries(): readonly Entry[]
  flush(): void
}

/** 把一轮的 assistant 与工具结果整理成批次。 */
export function turnBatch(assistant: Entry, results: readonly Entry[]): readonly Entry[] {
  return [assistant, ...results]
}
