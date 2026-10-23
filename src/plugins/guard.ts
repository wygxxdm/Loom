import type { GuardPort, GuardVerdict } from '../contracts/guard.ts'
import { GuardKey } from '../contracts/keys.ts'
import type { Plugin } from '../kernel/plugin.ts'

/** 稳定的参数指纹：键排序后再序列化，避免对象字面量顺序影响判断。 */
export function fingerprint(tool: string, args: Record<string, unknown>): string {
  return `${tool}(${stableJson(args)})`
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`

  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

/**
 * 重复调用护栏。
 *
 * 只对「完全相同的工具 + 完全相同的参数」计数。同一文件读两次通常是
 * 合理的（改完再看），所以阈值设 3 而不是 2，只在明显打转时介入。
 */
export class RepeatGuard implements GuardPort {
  readonly #window: number
  readonly #threshold: number
  readonly #history: string[] = []
  readonly #nudged = new Set<string>()

  constructor(window = 12, threshold = 3) {
    this.#window = window
    this.#threshold = threshold
  }

  observe(tool: string, args: Record<string, unknown>): GuardVerdict {
    const key = fingerprint(tool, args)
    this.#history.push(key)
    if (this.#history.length > this.#window) {
      this.#history.shift()
    }

    const repeats = this.#history.filter((item) => item === key).length
    const tripped = repeats >= this.#threshold && !this.#nudged.has(key)

    if (tripped) {
      this.#nudged.add(key)
      return {
        repeats,
        tripped: true,
        nudge:
          `你已经用完全相同的参数调用 ${tool} ${repeats} 次，结果不会改变。` +
          '请换一种做法：读取相关代码、改变参数，或者直接给出结论。',
      }
    }

    return { repeats, tripped: false }
  }

  reset(): void {
    this.#history.length = 0
    this.#nudged.clear()
  }
}

export function guardPlugin(): Plugin {
  return {
    name: 'guard',
    provides: [GuardKey],
    setup(scope) {
      scope.provide(GuardKey, new RepeatGuard())
    },
  }
}
