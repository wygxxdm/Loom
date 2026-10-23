import type { Approver, GrantScope, PermissionPort, PermissionQuery, Verdict } from '../contracts/permission.ts'
import { PermissionKey } from '../contracts/keys.ts'
import { AUTO_ALLOWED } from '../contracts/tools.ts'
import type { Plugin } from '../kernel/plugin.ts'

const SCOPES: ReadonlySet<string> = new Set(['once', 'run', 'task', 'session'])

/**
 * 三层授权缓存。
 *
 * 授权键是 `tool:risk` 而非 `tool:risk:args`——这是可用的妥协，但会把
 * 「允许一次 git push」放大成「允许同类 shell」。因此自动放行的只有
 * `read-only` / `agent-state` / `shell-low` 三档，放大的范围被限制在
 * 已经判定为低风险的命令上。
 */
export class GrantStore implements PermissionPort {
  readonly #session = new Set<string>()
  readonly #runs = new Map<string, Set<string>>()
  readonly #tasks = new Map<string, Set<string>>()
  readonly #approver: Approver | undefined

  constructor(approver?: Approver) {
    this.#approver = approver
  }

  async check(query: PermissionQuery, signal?: AbortSignal): Promise<Verdict> {
    signal?.throwIfAborted()

    if (AUTO_ALLOWED.has(query.risk)) {
      return 'allow'
    }

    const key = `${query.tool}:${query.risk}`

    if (this.#session.has(key)) return 'allow'
    if (this.#tasks.get(query.taskId)?.has(key) === true) return 'allow'
    if (this.#runs.get(query.runId)?.has(key) === true) return 'allow'

    if (this.#approver === undefined) {
      // 没有交互层时默认拒绝：CI 里不该因为缺一个确认函数就放开写权限。
      return 'deny'
    }

    const decision = await this.#approver.ask(query, signal)
    signal?.throwIfAborted()

    if (decision === 'deny' || !SCOPES.has(decision)) {
      return 'deny'
    }

    this.#remember(decision, query, key)
    return 'allow'
  }

  /** 当前生效的授权键，供 `/permissions` 之类的诊断使用。 */
  snapshot(): { session: string[]; runs: string[][]; tasks: string[][] } {
    return {
      session: [...this.#session],
      runs: [...this.#runs.values()].map((set) => [...set]),
      tasks: [...this.#tasks.values()].map((set) => [...set]),
    }
  }

  dropRun(runId: string): void {
    this.#runs.delete(runId)
  }

  dropTask(taskId: string): void {
    this.#tasks.delete(taskId)
  }

  #remember(scope: GrantScope, query: PermissionQuery, key: string): void {
    if (scope === 'session') {
      this.#session.add(key)
      return
    }
    if (scope === 'task') {
      const set = this.#tasks.get(query.taskId) ?? new Set<string>()
      set.add(key)
      this.#tasks.set(query.taskId, set)
      return
    }
    if (scope === 'run') {
      const set = this.#runs.get(query.runId) ?? new Set<string>()
      set.add(key)
      this.#runs.set(query.runId, set)
    }
  }
}

export function permissionPlugin(approver?: Approver): Plugin {
  return {
    name: 'permission',
    provides: [PermissionKey],
    setup(scope) {
      scope.provide(PermissionKey, new GrantStore(approver))
    },
  }
}
