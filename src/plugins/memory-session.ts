import { JournalKey, SessionKey } from '../contracts/keys.ts'
import type { JournalPort, JournalRecord } from '../contracts/journal.ts'
import type { Entry, SessionPort } from '../contracts/session.ts'
import type { Plugin } from '../kernel/plugin.ts'

/**
 * 内存 Session：与 JSONL 版行为一致，但不落盘。
 *
 * 两个用途：单元测试不必建临时目录；`--ephemeral` 跑一次性任务不留痕迹。
 * 与 JSONL 版的唯一差别是**没有孤儿修复**——没有崩溃恢复的场景，
 * 也就不存在“写到一半”的批次。
 */
export class MemorySession implements SessionPort, JournalPort {
  readonly id: string
  readonly cwd: string

  readonly #entries: Entry[] = []
  readonly #records: JournalRecord[] = []

  constructor(id: string, cwd: string) {
    this.id = id
    this.cwd = cwd
  }

  entries(): readonly Entry[] {
    return this.#entries
  }

  append(entries: readonly Entry[]): void {
    // 深拷贝：调用方后续改动 args 不应影响已入账的历史。
    for (const entry of entries) {
      this.#entries.push(structuredClone(entry))
    }
  }

  records(): readonly JournalRecord[] {
    return this.#records
  }

  appendRecord(record: JournalRecord): void {
    this.#records.push(structuredClone(record))
  }

  flush(): void {}
}

export function memorySessionPlugin(id: string, cwd: string): Plugin {
  return {
    name: 'session',
    provides: [SessionKey, JournalKey],
    setup(scope) {
      const session = new MemorySession(id, cwd)
      scope.provide(SessionKey, session)
      scope.provide(JournalKey, session)
    },
  }
}
