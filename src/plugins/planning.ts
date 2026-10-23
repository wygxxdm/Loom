import { JournalKey, ModelKey, PlanKey, PlannerKey, ToolsKey } from '../contracts/keys.ts'
import type { JournalPort } from '../contracts/journal.ts'
import type { ModelPort } from '../contracts/model.ts'
import {
  parseProgress,
  parseSpec,
  type PlannerPort,
  type PlanPort,
  type TaskProgress,
  type TaskSpec,
} from '../contracts/planning.ts'
import type { Tool } from '../contracts/tools.ts'
import type { Plugin } from '../kernel/plugin.ts'

const PLANNER_SYSTEM = [
  'You turn a coding request into a structured task spec for another agent.',
  'Return STRICT JSON only, no prose, no code fences.',
  'Shape: {"goal":string,"deliverables":string[],"tasks":[{"id":string,"objective":string}],',
  '"constraints":string[],"acceptance":string[],"outOfScope":string[]}',
  'Rules: goal is one sentence. tasks are 2-5 verifiable objectives, no file paths, no code.',
  'acceptance must be checkable by a human or a test. outOfScope lists what must NOT be changed.',
  'If the request is ambiguous, state the most reasonable interpretation in goal.',
].join('\n')

/**
 * 规划状态：规格 + 进度。
 *
 * 两者都写 journal，因此恢复会话时任务规格还在，进度条不会指向
 * 一堆不存在的任务。
 */
export class PlanStore implements PlanPort {
  readonly #journal: JournalPort
  #spec: TaskSpec | undefined
  readonly #progress = new Map<string, TaskProgress>()

  constructor(journal: JournalPort) {
    this.#journal = journal

    for (const record of journal.records()) {
      if (record.kind === 'plan') {
        // 新规格意味着旧进度作废。
        this.#spec = record.spec
        this.#progress.clear()
        continue
      }
      this.#progress.set(record.progress.taskId, record.progress)
    }
  }

  current(): TaskSpec | undefined {
    return this.#spec
  }

  save(spec: TaskSpec): void {
    const validated = parseSpec(spec)
    this.#spec = validated
    this.#progress.clear()
    this.#journal.appendRecord({ kind: 'plan', at: Date.now(), spec: validated })
  }

  progress(): readonly TaskProgress[] {
    return [...this.#progress.values()]
  }

  update(progress: TaskProgress): void {
    const validated = parseProgress(progress)
    this.#progress.set(validated.taskId, validated)
    this.#journal.appendRecord({ kind: 'progress', at: Date.now(), progress: validated })
  }

  render(): string | undefined {
    const spec = this.#spec
    if (spec === undefined) return undefined

    const status = this.#progress
    const lines: string[] = ['[TASK SPEC]', `goal: ${spec.goal}`]

    if (spec.deliverables.length > 0) {
      lines.push(`deliverables: ${spec.deliverables.join(' | ')}`)
    }
    if (spec.tasks.length > 0) {
      lines.push('tasks:')
      for (const task of spec.tasks) {
        const state = status.get(task.id)
        const mark = state === undefined ? 'pending' : `${state.status}${state.note.length > 0 ? `: ${state.note}` : ''}`
        lines.push(`  - [${task.id}] ${task.objective} (${mark})`)
      }
    }
    if (spec.constraints.length > 0) lines.push(`constraints: ${spec.constraints.join(' | ')}`)
    if (spec.acceptance.length > 0) lines.push(`acceptance: ${spec.acceptance.join(' | ')}`)
    if (spec.outOfScope.length > 0) lines.push(`do not touch: ${spec.outOfScope.join(' | ')}`)
    lines.push('Update task status with the update_task tool as you complete each objective.')

    return lines.join('\n')
  }
}

/** 基于模型的规划器：只产出规格，不执行、不选文件。 */
export class ModelPlanner implements PlannerPort {
  readonly #model: ModelPort

  constructor(model: ModelPort) {
    this.#model = model
  }

  async plan(task: string, signal?: AbortSignal): Promise<TaskSpec | undefined> {
    try {
      const reply = await this.#model.run({
        system: PLANNER_SYSTEM,
        messages: [{ role: 'user', text: `REQUEST:\n${task}` }],
        tools: [],
        ...(signal === undefined ? {} : { signal }),
      })
      if (reply.kind !== 'message') return undefined
      return parseSpec(extractJson(reply.text))
    } catch {
      // 规划是可选的加速器：失败就退化成“无规格直接干”。
      return undefined
    }
  }
}

/** 从可能带围栏或前后缀的文本里取出第一个 JSON 对象。 */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('planner returned no JSON object')
  }
  return JSON.parse(cleaned.slice(start, end + 1))
}

function updateTaskTool(plan: PlanPort): Tool {
  return {
    risk: 'agent-state',
    spec: {
      name: 'update_task',
      description: 'Record progress for one planned task. Call it when an objective is finished or blocked.',
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'id from the task spec' },
          status: { type: 'string', enum: ['pending', 'active', 'done', 'blocked'] },
          note: { type: 'string', description: 'what changed, one short line' },
        },
        required: ['taskId', 'status'],
      },
    },
    async run(args) {
      const progress = parseProgress(args)
      plan.update(progress)
      return `task ${progress.taskId} → ${progress.status}`
    },
  }
}

export function planningPlugin(options: { withPlanner?: boolean } = {}): Plugin {
  const withPlanner = options.withPlanner ?? true

  return {
    name: 'planning',
    needs: [JournalKey, ToolsKey, ...(withPlanner ? [ModelKey] : [])],
    provides: withPlanner ? [PlanKey, PlannerKey] : [PlanKey],
    setup(scope) {
      const plan = new PlanStore(scope.require(JournalKey))
      scope.provide(PlanKey, plan)

      if (withPlanner) {
        scope.provide(PlannerKey, new ModelPlanner(scope.require(ModelKey)))
      }

      const tools = scope.require(ToolsKey)
      scope.onDispose(tools.register(updateTaskTool(plan)))
    },
  }
}

/**
 * 关掉规划层时用的替身。
 *
 * 仍然提供 PlanKey，这样压缩器不需要“可选依赖”——可选依赖在装配顺序
 * 上是不确定的，属于隐蔽的坑。
 */
export function nullPlanningPlugin(): Plugin {
  return {
    name: 'planning',
    // 仍然挂真实 journal：关掉规划层只该关掉“生成规格”，不该让规格写不进去。
    needs: [JournalKey],
    provides: [PlanKey],
    setup(scope) {
      scope.provide(PlanKey, new PlanStore(scope.require(JournalKey)))
    },
  }
}
