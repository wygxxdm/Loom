import { spawn } from 'node:child_process'
import { ToolsKey } from '../contracts/keys.ts'
import type { Tool, ToolRisk } from '../contracts/tools.ts'
import type { Plugin } from '../kernel/plugin.ts'

/** 只读命令：自动放行。刻意保守——能写文件或能执行代码的一律不在表内。 */
const READ_ONLY_EXECUTABLES: ReadonlySet<string> = new Set([
  'pwd', 'ls', 'dir', 'cat', 'head', 'tail', 'wc',
  'grep', 'rg', 'find', 'file', 'stat', 'tree', 'du', 'df', 'which', 'git',
])

/** git 只放行这几个子命令；checkout / reset / push 都要确认。 */
const READ_ONLY_GIT: ReadonlySet<string> = new Set(['status', 'diff', 'log', 'show', 'branch', 'remote'])

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_CHARS = 32 * 1024

export interface CommandScan {
  /** 第一个 token（可执行文件）。 */
  readonly executable?: string
  readonly args: readonly string[]
  /** 出现未加引号的管道/重定向/替换符。 */
  readonly hasShellSyntax: boolean
  readonly valid: boolean
}

/**
 * 最小词法扫描：只回答“这条命令里有没有会改变执行范围的东西”。
 *
 * 不做完整 shell 解析是刻意的——解析器写不全就会漏，漏一条就等于
 * 把 shell 全权交给模型。这里宁可把带引号的复杂命令判成高风险。
 */
export function scanCommand(command: string): CommandScan {
  const trimmed = command.trim()
  if (trimmed.length === 0) {
    return { args: [], hasShellSyntax: false, valid: false }
  }

  const tokens: string[] = []
  let token = ''
  let started = false
  let quote: '"' | "'" | undefined
  let hasShellSyntax = false
  let escaped = false

  const push = (): void => {
    if (started) {
      tokens.push(token)
      token = ''
      started = false
    }
  }

  for (const char of trimmed) {
    if (escaped) {
      token += char
      started = true
      escaped = false
      continue
    }

    if (char === '\\' && quote !== "'") {
      escaped = true
      started = true
      continue
    }

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      } else {
        token += char
      }
      started = true
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }

    if (char === ' ' || char === '\t') {
      push()
      continue
    }

    // 未加引号的这些字符会改变命令的语义范围。
    if ('|&;<>$`()\n\r'.includes(char)) {
      hasShellSyntax = true
      return { executable: tokens[0], args: tokens.slice(1), hasShellSyntax, valid: false }
    }

    token += char
    started = true
  }

  push()

  if (quote !== undefined) {
    // 引号没闭合：语义不确定，按最高风险处理。
    return { executable: tokens[0], args: tokens.slice(1), hasShellSyntax: true, valid: false }
  }

  return {
    ...(tokens[0] === undefined ? {} : { executable: tokens[0] }),
    args: tokens.slice(1),
    hasShellSyntax,
    valid: tokens.length > 0,
  }
}

/** 把一条命令映射到风险等级。 */
export function classifyCommand(command: string): ToolRisk {
  const scan = scanCommand(command)
  if (!scan.valid || scan.hasShellSyntax) return 'shell-high'

  const executable = scan.executable ?? ''
  if (executable.length === 0) return 'shell-high'

  // 路径形式的可执行文件（./x.sh、/usr/bin/env）一律不自动放行。
  if (executable.includes('/') || executable.startsWith('.') || executable.startsWith('~')) {
    return 'shell-high'
  }

  if (!READ_ONLY_EXECUTABLES.has(executable)) return 'shell'

  if (executable === 'git') {
    const sub = scan.args[0]
    return sub !== undefined && READ_ONLY_GIT.has(sub) ? 'shell-low' : 'shell'
  }

  return 'shell-low'
}

export interface ShellOptions {
  readonly root: string
  readonly timeoutMs?: number
}

export function shellTool(options: ShellOptions): Tool {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    risk: 'shell',
    riskOf(args) {
      return classifyCommand(typeof args.command === 'string' ? args.command : '')
    },
    spec: {
      name: 'run_command',
      description:
        'Run a shell command inside the workspace. Pipes, redirections and substitutions are allowed but require approval. Prefer simple commands.',
      schema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'e.g. "npm test" or "ls -la src"' } },
        required: ['command'],
      },
    },
    async run(args, signal) {
      signal?.throwIfAborted()
      const command = typeof args.command === 'string' ? args.command.trim() : ''
      if (command.length === 0) {
        throw new Error('command must not be blank')
      }

      return await new Promise<string>((resolveResult, rejectResult) => {
        // detached: 让命令拥有独立进程组，超时时可以整组回收，
        // 否则 `sh -c "npm test"` 的孙进程会一直挂着。
        const child = spawn(command, {
          cwd: options.root,
          shell: true,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        })

        let output = ''
        let settled = false

        const cleanup = (): void => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        }

        const append = (chunk: Buffer): void => {
          if (output.length < MAX_OUTPUT_CHARS * 2) {
            output += chunk.toString('utf8')
          }
        }

        const killGroup = (): void => {
          if (child.pid === undefined) return
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            try {
              child.kill('SIGKILL')
            } catch {
              // 进程已经退出。
            }
          }
        }

        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          killGroup()
          cleanup()
          rejectResult(new Error(`command timed out after ${timeoutMs}ms`))
        }, timeoutMs)

        const onAbort = (): void => {
          if (settled) return
          settled = true
          killGroup()
          cleanup()
          rejectResult(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        child.stdout?.on('data', append)
        child.stderr?.on('data', append)

        child.on('error', (error) => {
          if (settled) return
          settled = true
          cleanup()
          rejectResult(new Error(`cannot start command: ${error.message}`))
        })

        child.on('close', (code) => {
          if (settled) return
          settled = true
          cleanup()
          resolveResult(`exit: ${code ?? 'null'}\n${clip(output)}`)
        })
      })
    },
  }
}

/** 头尾各留一半：错误栈在末尾，只留开头会丢掉最有用的部分。 */
function clip(value: string): string {
  const body = value.length === 0 ? '(no output)' : value
  if (body.length <= MAX_OUTPUT_CHARS) return body
  const marker = '\n...[truncated in tool output]\n'
  const room = MAX_OUTPUT_CHARS - marker.length
  return `${body.slice(0, Math.ceil(room / 2))}${marker}${body.slice(-Math.floor(room / 2))}`
}

export function shellToolPlugin(options: ShellOptions): Plugin {
  return {
    name: 'shell-tool',
    needs: [ToolsKey],
    provides: [],
    setup(scope) {
      const tools = scope.require(ToolsKey)
      scope.onDispose(tools.register(shellTool(options)))
    },
  }
}
