import type { ToolRisk } from './tools.ts'

/** 一次授权询问。 */
export interface PermissionQuery {
  readonly runId: string
  readonly taskId: string
  readonly tool: string
  readonly risk: ToolRisk
  readonly args: Record<string, unknown>
}

/** 用户/策略给出的授权范围。`once` 只覆盖当前这一次调用。 */
export type GrantScope = 'once' | 'run' | 'task' | 'session'

export type Verdict = 'allow' | 'deny'

/** 交互层实现这个接口；没有交互层时不提供，权限插件会默认拒绝。 */
export interface Approver {
  ask(query: PermissionQuery, signal?: AbortSignal): Promise<GrantScope | 'deny'>
}

export interface PermissionPort {
  check(query: PermissionQuery, signal?: AbortSignal): Promise<Verdict>
  /** run 结束必须调用；预算耗尽时可以保留 task 级授权以支持续跑。 */
  dropRun(runId: string): void
  dropTask(taskId: string): void
}
