import { realpathSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ToolsKey } from '../contracts/keys.ts'
import type { Plugin } from '../kernel/plugin.ts'
import type { Tool } from '../contracts/tools.ts'

const MAX_READ_CHARS = 160_000
const MAX_READ_LINES = 2_000
/** 超过这个大小不做片段替换：多半是二进制或生成物，整文件读写都不合适。 */
const MAX_EDIT_BYTES = 1_000_000

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** 1-based 行号，用于把改动位置回告给模型。 */
function lineOf(value: string, index: number): number {
  if (index < 0) return 0
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (value.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string') {
    throw new Error(`argument "${key}" must be a string`)
  }
  return value
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`argument "${key}" must be a finite number`)
  }
  return value
}

/**
 * 把相对路径解析到 workspace 内。
 *
 * 两道检查：字面前缀 + 真实路径（realpath）。后者用于挡住
 * `workspace/link -> /etc` 这类符号链接逃逸——只做字符串前缀判断会漏。
 */
async function insideRoot(root: string, input: string): Promise<string> {
  if (isAbsolute(input)) {
    throw new Error('path must be relative to the workspace root')
  }

  const rootAbs = resolve(root)
  const target = resolve(rootAbs, input)

  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
    throw new Error(`path escapes the workspace: ${input}`)
  }

  // 比较 realpath 时必须以 realpath(root) 为基准：macOS 的 /var 实际指向
  // /private/var，拿字面根目录去比会把所有正常路径都判成逃逸。
  let rootReal = rootAbs
  try {
    rootReal = await realpath(rootAbs)
  } catch {
    rootReal = rootAbs
  }

  let real: string | undefined
  try {
    real = await realpath(target)
  } catch {
    real = undefined
  }

  if (real === undefined) {
    // 目标还不存在（写新文件），字面判断已经足够。
    return target
  }

  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new Error(`path escapes the workspace: ${input}`)
  }

  return real
}

/**
 * 为删除解析路径。
 *
 * 与 insideRoot 的区别：`insideRoot` 会把末段 symlink 解开（因为它要拿真实
 * 路径去读写），而删除必须看见链接本身。所以这里对**父目录**做 realpath
 * 校验（挡住 symlink 目录逃逸），对**末段**只做 lstat（不跟随）。
 */
async function resolveForDelete(
  root: string,
  input: string,
): Promise<{ target: string; info: Awaited<ReturnType<typeof lstat>> }> {
  if (isAbsolute(input)) {
    throw new Error('path must be relative to the workspace root')
  }

  const lexical = resolve(root, input)
  if (lexical !== root && !lexical.startsWith(root + sep)) {
    throw new Error(`path escapes the workspace: ${input}`)
  }

  let parentReal: string
  try {
    parentReal = await realpath(dirname(lexical))
  } catch {
    throw new Error(`file does not exist: ${input}`)
  }
  if (parentReal !== root && !parentReal.startsWith(root + sep)) {
    throw new Error(`path escapes the workspace: ${input}`)
  }

  const target = join(parentReal, basename(lexical))
  const info = await lstat(target).catch(() => undefined)
  if (info === undefined) {
    throw new Error(`file does not exist: ${input}`)
  }

  return { target, info }
}

export function fileTools(root: string): Tool[] {
  // 先归一化工作区根：macOS 的 /var 指向 /private/var，不归一化的话
  // 回告给模型的相对路径会变成 ../../private/var/...
  try {
    root = realpathSync(resolve(root))
  } catch {
    root = resolve(root)
  }

  const readTool: Tool = {
    risk: 'read-only',
    spec: {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the workspace. Supports line offsets for large files.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root' },
          offset: { type: 'number', description: 'First line to return, 1-based' },
          limit: { type: 'number', description: 'Maximum number of lines to return' },
        },
        required: ['path'],
      },
    },
    async run(args, signal) {
      signal?.throwIfAborted()
      const target = await insideRoot(root, text(args, 'path'))
      const raw = await readFile(target, 'utf8')
      const lines = raw.split('\n')
      const offset = Math.max(1, optionalNumber(args, 'offset') ?? 1)
      const limit = Math.max(1, Math.min(optionalNumber(args, 'limit') ?? MAX_READ_LINES, MAX_READ_LINES))

      const slice = lines.slice(offset - 1, offset - 1 + limit)
      let body = slice.join('\n')
      if (body.length > MAX_READ_CHARS) {
        body = `${body.slice(0, MAX_READ_CHARS)}\n...[truncated ${body.length - MAX_READ_CHARS} chars]`
      }

      const shown = slice.length
      return `path: ${relative(resolve(root), target) || '.'}\nlines: ${offset}-${offset + shown - 1} of ${lines.length}\n\n${body}`
    },
  }

  const writeTool: Tool = {
    risk: 'workspace-write',
    spec: {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 text file inside the workspace. Creates parent directories.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
    async run(args, signal) {
      signal?.throwIfAborted()
      const target = await insideRoot(root, text(args, 'path'))
      const content = text(args, 'content')
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
      return `wrote ${content.length} chars to ${relative(resolve(root), target)}`
    },
  }

  /**
   * 按片段精确替换。
   *
   * 三条语义是刻意定死的：
   * 1. 精确匹配，不做空白/换行归一化——模糊匹配会让“改错地方”变得不可预测；
   * 2. `old` 必须唯一，出现多次就报错，不猜模型想改哪一处；
   * 3. 任何校验失败都不写盘，文件保持原样。
   */
  const editTool: Tool = {
    risk: 'workspace-write',
    spec: {
      name: 'edit_file',
      description:
        'Replace one exact snippet in an existing UTF-8 file. `old` must appear exactly once unless replaceAll is true. ' +
        'The file is left untouched when the snippet is missing or ambiguous.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root' },
          old: { type: 'string', description: 'Exact text to replace, including indentation' },
          new: { type: 'string', description: 'Replacement text' },
          replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false)' },
        },
        required: ['path', 'old', 'new'],
      },
    },
    async run(args, signal) {
      signal?.throwIfAborted()
      const target = await insideRoot(root, text(args, 'path'))
      const before = text(args, 'old')
      const after = text(args, 'new')
      const replaceAll = args.replaceAll === true

      if (before.length === 0) {
        throw new Error('argument "old" must not be empty; use write_file to create or rewrite a file')
      }

      const info = await stat(target).catch(() => undefined)
      if (info === undefined) {
        throw new Error(`file does not exist: ${text(args, 'path')}`)
      }
      if (info.size > MAX_EDIT_BYTES) {
        throw new Error(`file is too large to edit (${info.size} bytes > ${MAX_EDIT_BYTES})`)
      }

      const original = await readFile(target, 'utf8')
      const occurrences = countOccurrences(original, before)

      if (occurrences === 0) {
        throw new Error('snippet not found; read the file again and pass the exact current text')
      }
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `snippet appears ${occurrences} times; add surrounding context or set replaceAll to true`,
        )
      }

      const updated = replaceAll
        ? original.split(before).join(after)
        : original.replace(before, after)

      if (updated === original) {
        return 'snippet already matched the replacement; nothing changed'
      }

      await writeFile(target, updated, 'utf8')

      const line = lineOf(original, original.indexOf(before))
      const removed = before.split('\n').length
      const added = after.split('\n').length
      return (
        `edited ${relative(resolve(root), target)} at line ${line}: ` +
        `-${removed} +${added} lines` +
        `${occurrences > 1 ? ` (${occurrences} occurrences)` : ''}`
      )
    },
  }

  /**
   * 软删除：移进 `.loom/trash/`，不是 unlink。
   *
   * agent 删错文件是不可逆事故，而「移动 + 回报原路径」可回滚，
   * 代价只是多一个目录。拒绝目录和符号链接——前者破坏面太大，
   * 后者会让 realpath 把删除作用到工作区之外的目标上。
   */
  const deleteTool: Tool = {
    risk: 'workspace-write',
    spec: {
      name: 'delete_file',
      description:
        'Soft-delete a file by moving it into .loom/trash inside the workspace. Directories and symlinks are refused.',
      schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the workspace root' } },
        required: ['path'],
      },
    },
    async run(args, signal) {
      signal?.throwIfAborted()
      const input = text(args, 'path')
      const { target, info } = await resolveForDelete(root, input)

      if (target === root) {
        throw new Error('refusing to delete the workspace root')
      }
      if (target.startsWith(join(root, '.loom') + sep) || target === join(root, '.loom')) {
        throw new Error('refusing to delete inside .loom')
      }

      if (info.isDirectory()) {
        throw new Error('delete_file only removes files; remove contents first or use run_command')
      }
      if (info.isSymbolicLink()) {
        throw new Error('refusing to delete a symlink')
      }

      const trashDir = join(root, '.loom', 'trash')
      await mkdir(trashDir, { recursive: true })
      const trashed = join(trashDir, `${Date.now().toString(36)}-${basename(target)}`)
      await rename(target, trashed)

      return (
        `moved ${relative(root, target)} → ${relative(root, trashed)} ` +
        `(soft delete, ${info.size} bytes; move it back to restore)`
      )
    },
  }

  const listTool: Tool = {
    risk: 'read-only',
    spec: {
      name: 'list_dir',
      description: 'List entries of a directory inside the workspace (one level, no recursion).',
      schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path, defaults to "."' } },
      },
    },
    async run(args, signal) {
      signal?.throwIfAborted()
      const input = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path : '.'
      const target = await insideRoot(root, input)
      const entries = await readdir(target, { withFileTypes: true })
      if (entries.length === 0) return '(empty directory)'

      const rows = await Promise.all(entries.slice(0, 200).map(async (entry) => {
        if (entry.isDirectory()) return `${entry.name}/`
        try {
          const info = await stat(join(target, entry.name))
          return `${entry.name} (${info.size} bytes)`
        } catch {
          return entry.name
        }
      }))

      return rows.sort().join('\n')
    },
  }

  return [readTool, writeTool, editTool, deleteTool, listTool]
}

export function fileToolsPlugin(root: string): Plugin {
  return {
    name: 'file-tools',
    needs: [ToolsKey],
    provides: [],
    setup(scope) {
      const tools = scope.require(ToolsKey)
      for (const tool of fileTools(root)) {
        scope.onDispose(tools.register(tool))
      }
    },
  }
}
