/**
 * 重复调用护栏。
 *
 * 真实模型很容易在同一个失败上打转：反复读同一个文件、反复跑同一条
 * 失败命令。只靠总预算兜底太浪费——等到 128 次调用耗尽，代价已经付完。
 * 这个端口让 Loop 在「同一指纹第 N 次出现」时就插入提醒。
 */
export interface GuardVerdict {
  readonly repeats: number
  readonly tripped: boolean
  /** 触发时建议注入的提示文本。 */
  readonly nudge?: string
}

export interface GuardPort {
  /** 记录一次调用，返回当前指纹的重复次数。 */
  observe(tool: string, args: Record<string, unknown>): GuardVerdict
  reset(): void
}
