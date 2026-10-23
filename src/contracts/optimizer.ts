export interface OptimizeInput {
  readonly task: string
  readonly workspace: string
  readonly signal?: AbortSignal
}

/**
 * 需求改写。
 *
 * 只做「澄清」，不做「规划」——一旦优化器开始指定文件和步骤，
 * 消融实验归因的就不是 harness，而是另一个更强的 agent。
 */
export interface OptimizerPort {
  rewrite(input: OptimizeInput): Promise<string>
}
