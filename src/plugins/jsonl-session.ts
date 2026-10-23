import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { JournalKey, SessionKey } from '../contracts/keys.ts'
import type { JournalPort, JournalRecord } from '../contracts/journal.ts'
import { parseProgress, parseSpec } from '../contracts/planning.ts'
import type { Entry, SessionPort } from '../contracts/session.ts'
import type { Plugin } from '../kernel/plugin.ts'

/** 2：新增 journal 行（规划与进度）。1 的旧文件仍可读。 */
export const FORMAT = 2
const SUPPORTED = new Set([1, 2])

interface Header {
  readonly type: 'loom.session'
  readonly format: number
  readonly id: string
  readonly cwd: string
  readonly createdAt: number
}

interface EntryRow {
  readonly type: 'entry'
  readonly seq: number
  readonly at: number
  readonly entry: Entry
}

interface JournalRow {
  readonly type: 'journal'
  readonly at: number
  readonly record: JournalRecord
}

type Row = EntryRow | JournalRow

/**
 * 追加式 JSONL 会话。
 *
 * 三条关键行为：
 * 1. 一批 entry 合并成一次 write + 一次 fsync，崩溃时最多丢整批；
 * 2. 载入时修复「有调用、无结果」的残局（补一条 interrupted 结果），
 *    否则续跑时 API 会因为没有对应 tool 消息而 400；
 * 3. 只截断「没有换行符收尾的半行」，已经以换行提交的坏行必须报错——
 *    自动跳过等于静默丢数据。
 */
export class JsonlSession implements SessionPort, JournalPort {
  readonly path: string
  readonly id: string
  readonly cwd: string

  readonly #entries: Entry[] = []
  readonly #journal: JournalRecord[] = []
  #materialized = false

  constructor(path: string, id: string, cwd: string) {
    this.path = path
    this.id = id
    this.cwd = cwd

    if (existsSync(path)) {
      this.#load()
      this.#repairOrphans()
    }
  }

  entries(): readonly Entry[] {
    return this.#entries
  }

  records(): readonly JournalRecord[] {
    return this.#journal
  }

  append(entries: readonly Entry[]): void {
    if (entries.length === 0) return

    const base = this.#entries.length
    const batch: EntryRow[] = entries.map((entry, index) => ({
      type: 'entry',
      seq: base + index + 1,
      at: Date.now(),
      entry,
    }))

    this.#persist(batch.map((row) => `${JSON.stringify(row)}\n`).join(''))
    this.#entries.push(...entries)
  }

  appendRecord(record: JournalRecord): void {
    const row: JournalRow = { type: 'journal', at: Date.now(), record }
    this.#persist(`${JSON.stringify(row)}\n`)
    this.#journal.push(record)
  }

  /** 写入已是同步落盘，这里保持接口一致。 */
  flush(): void {}

  #persist(payload: string): void {
    mkdirSync(dirname(this.path), { recursive: true })

    if (!this.#materialized) {
      const header: Header = {
        type: 'loom.session',
        format: FORMAT,
        id: this.id,
        cwd: this.cwd,
        createdAt: Date.now(),
      }
      this.#write(`${JSON.stringify(header)}\n${payload}`, 'wx')
      this.#materialized = true
      return
    }

    this.#write(payload, 'a')
  }

  #write(payload: string, flag: 'wx' | 'a'): void {
    const fd = openSync(this.path, flag)
    try {
      writeSync(fd, payload)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  #load(): void {
    let content = readFileSync(this.path, 'utf8')

    if (!content.endsWith('\n')) {
      const lastBreak = content.lastIndexOf('\n')
      if (lastBreak >= 0) {
        const tail = content.slice(lastBreak + 1)
        try {
          JSON.parse(tail)
        } catch {
          content = content.slice(0, lastBreak + 1)
          truncateSync(this.path, Buffer.byteLength(content, 'utf8'))
        }
      }
    }

    const lines = content.split('\n')
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop()
    }
    if (lines.length === 0) {
      throw new Error(`session file ${this.path} is empty`)
    }

    const header = JSON.parse(lines[0] ?? '') as Header
    if (header.type !== 'loom.session' || !SUPPORTED.has(header.format)) {
      throw new Error(`session file ${this.path} has unsupported format`)
    }

    for (let index = 1; index < lines.length; index += 1) {
      const row = JSON.parse(lines[index] ?? '') as Row
      if (row.type === 'journal') {
        this.#journal.push(validateRecord(row.record, index + 1))
        continue
      }
      if (row.type !== 'entry') {
        throw new Error(`session file ${this.path} line ${index + 1}: unknown row type`)
      }
      if (row.seq !== this.#entries.length + 1) {
        throw new Error(
          `session file ${this.path} line ${index + 1}: expected seq ${this.#entries.length + 1}, got ${row.seq}`,
        )
      }
      this.#entries.push(validateEntry(row.entry, index + 1))
    }
    this.#materialized = true
  }

  /**
   * 补齐孤儿工具调用。
   *
   * 崩溃可能发生在「写完 assistant 的 calls、还没写 tool 结果」之间。
   * 补一条失败结果，比让用户永远无法恢复这个会话要好。
   */
  #repairOrphans(): void {
    const pending = new Map<string, string>()

    for (const entry of this.#entries) {
      if (entry.kind === 'assistant') {
        for (const call of entry.calls) {
          pending.set(call.id, call.name)
        }
      } else if (entry.kind === 'tool') {
        pending.delete(entry.callId)
      }
    }

    if (pending.size === 0) return

    const patches: Entry[] = [...pending].map(([callId, name]) => ({
      kind: 'tool',
      callId,
      name,
      output: 'tool error: run was interrupted before this result was persisted',
      failed: true,
    }))

    this.append(patches)
  }
}

function validateEntry(value: unknown, line: number): Entry {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`session line ${line}: entry must be an object`)
  }
  const entry = value as Record<string, unknown>

  switch (entry.kind) {
    case 'user':
      return { kind: 'user', text: requireString(entry.text, line, 'text') }

    case 'notice':
      return { kind: 'notice', text: requireString(entry.text, line, 'text') }

    case 'assistant': {
      const calls = entry.calls
      if (!Array.isArray(calls)) {
        throw new Error(`session line ${line}: assistant.calls must be an array`)
      }
      return {
        kind: 'assistant',
        text: typeof entry.text === 'string' ? entry.text : '',
        calls: calls.map((call, index) => {
          const item = call as Record<string, unknown>
          return {
            id: requireString(item.id, line, `calls[${index}].id`),
            name: requireString(item.name, line, `calls[${index}].name`),
            args: (item.args ?? {}) as Record<string, unknown>,
          }
        }),
      }
    }

    case 'tool':
      return {
        kind: 'tool',
        callId: requireString(entry.callId, line, 'callId'),
        name: requireString(entry.name, line, 'name'),
        output: requireString(entry.output, line, 'output'),
        failed: entry.failed === true,
      }

    default:
      throw new Error(`session line ${line}: unknown entry kind "${String(entry.kind)}"`)
  }
}

function validateRecord(value: unknown, line: number): JournalRecord {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`session line ${line}: journal record must be an object`)
  }
  const record = value as Record<string, unknown>
  const at = typeof record.at === 'number' ? record.at : Date.now()

  if (record.kind === 'plan') {
    return { kind: 'plan', at, spec: parseSpec(record.spec) }
  }
  if (record.kind === 'progress') {
    return { kind: 'progress', at, progress: parseProgress(record.progress) }
  }

  throw new Error(`session line ${line}: unknown journal kind "${String(record.kind)}"`)
}


function requireString(value: unknown, line: number, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`session line ${line}: ${field} must be a string`)
  }
  return value
}

export function jsonlSessionPlugin(path: string, id: string, cwd: string): Plugin {
  return {
    name: 'session',
    provides: [SessionKey, JournalKey],
    setup(scope) {
      const session = new JsonlSession(path, id, cwd)
      scope.provide(SessionKey, session)
      scope.provide(JournalKey, session)
    },
  }
}
