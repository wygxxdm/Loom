/** 规划层里的一条可验证任务。只描述目标，不描述实现。 */
export interface PlanTask {
  readonly id: string
  readonly objective: string
}

/**
 * 结构化任务规格。
 *
 * 关键在 `acceptance` 与 `outOfScope`：前者让“做完”可判定，
 * 后者防止模型顺手扩大改动范围。这两项是 spec-driven 的实际价值，
 * 不是文档装饰。
 */
export interface TaskSpec {
  readonly goal: string
  readonly deliverables: readonly string[]
  readonly tasks: readonly PlanTask[]
  readonly constraints: readonly string[]
  readonly acceptance: readonly string[]
  readonly outOfScope: readonly string[]
}

export type TaskStatus = 'pending' | 'active' | 'done' | 'blocked'

export interface TaskProgress {
  readonly taskId: string
  readonly status: TaskStatus
  readonly note: string
}

export interface PlanPort {
  current(): TaskSpec | undefined
  save(spec: TaskSpec): void
  progress(): readonly TaskProgress[]
  update(progress: TaskProgress): void
  /** 渲染成可注入 system prompt 的文本；没有规格时返回 undefined。 */
  render(): string | undefined
}

export interface PlannerPort {
  /** 规划失败返回 undefined，调用方应继续执行而不是中断。 */
  plan(task: string, signal?: AbortSignal): Promise<TaskSpec | undefined>
}

const STATUSES: ReadonlySet<string> = new Set(['pending', 'active', 'done', 'blocked'])

/**
 * 从模型输出解析任务规格。
 *
 * 严格但宽容：字段缺失用空数组补齐，类型不对则抛错。规格是要进入
 * system prompt 的，宁可拒绝也不要注入半截 JSON。
 */
export function parseSpec(value: unknown): TaskSpec {
  if (typeof value !== 'object' || value === null) {
    throw new Error('task spec must be an object')
  }
  const raw = value as Record<string, unknown>

  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : ''
  if (goal.length === 0) {
    throw new Error('task spec requires a non-empty goal')
  }

  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map((item, index) => {
        const task = item as Record<string, unknown>
        const objective = typeof task.objective === 'string' ? task.objective.trim() : ''
        if (objective.length === 0) {
          throw new Error(`task spec tasks[${index}] requires an objective`)
        }
        return {
          id: typeof task.id === 'string' && task.id.trim().length > 0 ? task.id.trim() : `t${index + 1}`,
          objective,
        }
      })
    : []

  return {
    goal,
    deliverables: strings(raw.deliverables),
    tasks,
    constraints: strings(raw.constraints),
    acceptance: strings(raw.acceptance),
    outOfScope: strings(raw.outOfScope),
  }
}

export function parseProgress(value: unknown): TaskProgress {
  if (typeof value !== 'object' || value === null) {
    throw new Error('task progress must be an object')
  }
  const raw = value as Record<string, unknown>
  const taskId = typeof raw.taskId === 'string' ? raw.taskId.trim() : ''
  if (taskId.length === 0) {
    throw new Error('task progress requires a taskId')
  }
  const status = typeof raw.status === 'string' ? raw.status : ''
  if (!STATUSES.has(status)) {
    throw new Error(`invalid task status "${status}"`)
  }
  return {
    taskId,
    status: status as TaskStatus,
    note: typeof raw.note === 'string' ? raw.note : '',
  }
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
}
