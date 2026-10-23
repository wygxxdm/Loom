import type { TaskProgress, TaskSpec } from './planning.ts'

/**
 * 除消息之外需要持久化的事实。
 *
 * 规划与进度必须落盘：否则恢复会话时任务规格丢失，
 * 进度条变成一堆指向不存在任务的孤行。
 */
export type JournalRecord =
  | { readonly kind: 'plan'; readonly at: number; readonly spec: TaskSpec }
  | { readonly kind: 'progress'; readonly at: number; readonly progress: TaskProgress }

export interface JournalPort {
  /** 与 SessionPort.append 区分开：一个是消息批次，一个是结构化记录。 */
  appendRecord(record: JournalRecord): void
  records(): readonly JournalRecord[]
}
