export interface RunOptions {
  readonly signal?: AbortSignal
  /** 续跑上一次因预算耗尽而中断的任务：不追加新的用户消息。 */
  readonly resume?: boolean
  /** 同一任务的稳定标识，续跑时必须复用，否则 task 级授权会失效。 */
  readonly taskId?: string
  readonly system?: string
}

export interface RunReport {
  readonly text: string
  readonly runId: string
  readonly rounds: number
  readonly calls: number
  readonly failures: number
  readonly ms: number
  /** 是否因预算耗尽而停在检查点（可用 resume 继续）。 */
  readonly checkpoint: boolean
}

export type BudgetReason = 'rounds' | 'calls' | 'deadline'

export class BudgetExceeded extends Error {
  readonly reason: BudgetReason
  readonly limit: number

  constructor(reason: BudgetReason, limit: number) {
    super(
      reason === 'deadline'
        ? `run exceeded deadline (${limit}ms)`
        : `run exceeded ${reason} budget (${limit})`,
    )
    this.name = 'BudgetExceeded'
    this.reason = reason
    this.limit = limit
  }
}

export interface LoopPort {
  run(task: string, options?: RunOptions): Promise<RunReport>
}
