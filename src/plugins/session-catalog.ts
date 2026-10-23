import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { CatalogPort, SessionInfo } from '../contracts/catalog.ts'
import { CatalogKey } from '../contracts/keys.ts'
import type { Plugin } from '../kernel/plugin.ts'

/**
 * 基于目录的会话目录。
 *
 * 只读文件头与行类型，不反序列化整段历史——列表操作应该和会话大小
 * 无关。单个文件损坏时跳过并继续，不能让一个坏文件挡住 `/sessions`。
 */
export class FileCatalog implements CatalogPort {
  readonly #dir: string

  constructor(dir: string) {
    this.#dir = dir
  }

  pathOf(id: string): string {
    return join(this.#dir, `${encodeURIComponent(id)}.jsonl`)
  }

  list(): readonly SessionInfo[] {
    let names: string[]
    try {
      names = readdirSync(this.#dir).filter((name) => name.endsWith('.jsonl'))
    } catch {
      return []
    }

    const items: SessionInfo[] = []

    for (const name of names) {
      const path = join(this.#dir, name)
      try {
        items.push(this.#inspect(path, decodeURIComponent(name.slice(0, -'.jsonl'.length))))
      } catch {
        // 坏文件跳过：列表功能不应被单个损坏的会话拖垮。
      }
    }

    return items.sort((left, right) => right.createdAt - left.createdAt)
  }

  remove(id: string): boolean {
    const path = this.pathOf(id)
    if (!existsSync(path)) return false
    unlinkSync(path)
    return true
  }

  #inspect(path: string, id: string): SessionInfo {
    const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
    const header = JSON.parse(lines[0] ?? '{}') as { id?: unknown; createdAt?: unknown }
    if (typeof header.createdAt !== 'number') {
      throw new Error('missing header')
    }

    let entries = 0
    let hasPlan = false
    let firstUser: string | undefined

    for (let index = 1; index < lines.length; index += 1) {
      const row = JSON.parse(lines[index] ?? '{}') as Record<string, unknown>
      if (row.type === 'journal') {
        const record = row.record as Record<string, unknown> | undefined
        if (record?.kind === 'plan') hasPlan = true
        continue
      }
      if (row.type !== 'entry') continue
      entries += 1

      const entry = row.entry as Record<string, unknown> | undefined
      if (firstUser === undefined && entry?.kind === 'user' && typeof entry.text === 'string') {
        firstUser = entry.text.slice(0, 60)
      }
    }

    return {
      id: typeof header.id === 'string' ? header.id : id,
      path,
      createdAt: header.createdAt,
      entries,
      hasPlan,
      ...(firstUser === undefined ? {} : { firstUser }),
    }
  }
}

export function catalogPlugin(dir: string): Plugin {
  return {
    name: 'session-catalog',
    provides: [CatalogKey],
    setup(scope) {
      scope.provide(CatalogKey, new FileCatalog(dir))
    },
  }
}
