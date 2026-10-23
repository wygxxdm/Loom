/** 一次工具调用。`id` 由模型给出，用于把结果回填到对应位置。 */
export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly args: Record<string, unknown>
}

/** 发给模型的工具描述——只有元数据，没有实现。 */
export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly schema: Record<string, unknown>
}

/**
 * 副作用等级。
 *
 * 分六级而不是三级：三级只能回答“要不要问”，六级能回答“问得多严”。
 * - `read-only` / `agent-state` / `shell-low`：自动放行
 * - `workspace-write`：只改工作区内文件
 * - `shell`：外部命令，不改变工作区
 * - `shell-high`：可能越界或不可逆，必须确认
 */
export type ToolRisk =
  | 'read-only'
  | 'agent-state'
  | 'workspace-write'
  | 'shell-low'
  | 'shell'
  | 'shell-high'

/** 自动放行的等级；其余一律走授权。 */
export const AUTO_ALLOWED: ReadonlySet<ToolRisk> = new Set<ToolRisk>([
  'read-only',
  'agent-state',
  'shell-low',
])

export interface Tool {
  readonly spec: ToolSpec
  readonly risk: ToolRisk
  /** 按参数细化等级：同一工具，`ls` 与 `rm -rf` 不该是同一档。 */
  readonly riskOf?: (args: Record<string, unknown>) => ToolRisk
  run(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>
}

export interface ToolsPort {
  /** 注册；返回注销函数。同名重复注册必须失败，不做静默覆盖。 */
  register(tool: Tool): () => void
  /** 模型可见的工具清单。 */
  specs(): readonly ToolSpec[]
  /** 本次调用的实际副作用等级。 */
  riskOf(name: string, args: Record<string, unknown>): ToolRisk
  /** 执行；未知工具必须抛错而不是静默返回空串。 */
  invoke(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>
}
