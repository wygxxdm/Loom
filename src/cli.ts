import { statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, resolve } from 'node:path'
import { stdin, stdout } from 'node:process'
import type { HarnessEvent } from './contracts/events.ts'
import type { Approver, GrantScope, PermissionQuery } from './contracts/permission.ts'
import type { TaskSpec } from './contracts/planning.ts'
import { DeepSeekModel } from './plugins/deepseek-model.ts'
import { ScriptedModel, type ScriptedStep } from './plugins/scripted-model.ts'
import { createHarness, type Harness } from './runtime.ts'

interface Args {
  task: string
  workspace: string
  session: string
  sessionDir: string | undefined
  model: 'deepseek' | 'scripted'
  resume: boolean
  yes: boolean
  quiet: boolean
  optimize: boolean
  plan: boolean
  ephemeral: boolean
  maxRounds: number | undefined
  maxToolCalls: number | undefined
  timeoutMs: number | undefined
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    task: '',
    workspace: process.cwd(),
    session: 'cli',
    sessionDir: undefined,
    model: process.env.DEEPSEEK_API_KEY === undefined ? 'scripted' : 'deepseek',
    resume: false,
    yes: false,
    quiet: false,
    optimize: false,
    plan: false,
    ephemeral: false,
    maxRounds: undefined,
    maxToolCalls: undefined,
    timeoutMs: undefined,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const next = (): string => argv[index + 1] ?? ''
    switch (token) {
      case '--task': args.task = next(); index += 1; break
      case '--workspace': args.workspace = next(); index += 1; break
      case '--session': args.session = next(); index += 1; break
      case '--session-dir': args.sessionDir = next(); index += 1; break
      case '--model': args.model = next() === 'deepseek' ? 'deepseek' : 'scripted'; index += 1; break
      case '--resume': args.resume = true; break
      case '--yes': args.yes = true; break
      case '--quiet': args.quiet = true; break
      case '--optimize': args.optimize = true; break
      case '--plan': args.plan = true; break
      case '--ephemeral': args.ephemeral = true; break
      case '--max-rounds': args.maxRounds = Number(next()); index += 1; break
      case '--max-tool-calls': args.maxToolCalls = Number(next()); index += 1; break
      case '--timeout-ms': args.timeoutMs = Number(next()); index += 1; break
      case '--help': printHelp(); process.exit(0)
      default:
        if (token !== undefined && token.startsWith('--')) {
          throw new Error(`unknown flag: ${token}`)
        }
    }
  }

  return args
}

function printHelp(): void {
  stdout.write(`loom — a plugin-woven coding agent harness

一次性模式
  --task <text>        要执行的任务
  --plan               先让规划器产出结构化任务规格，再执行
  --optimize           先改写需求再执行（多一次模型调用）
  --resume             续跑上一次因预算耗尽中断的任务
  --max-rounds <n>     模型请求轮次上限（默认 32）
  --max-tool-calls <n> 工具调用数上限（默认 96）
  --timeout-ms <n>     单次运行墙钟上限（默认 480000）
  --yes                自动授权写/执行（等价于 allow-run）

通用
  --workspace <dir>    工作目录（默认当前目录）
  --session <id>       会话 id
  --session-dir <dir>  会话目录（默认 ~/.loom/sessions）
  --model <kind>       deepseek | scripted
  --ephemeral          会话只留内存，不落盘
  --quiet              只输出最终结果

交互命令（不带 --task 时进入）
  /sessions            列出所有会话
  /use <id>            切换到指定会话
  /new [id]            新建会话
  /delete <id>         删除会话
  /history [n]         查看最近 n 条记录（默认 10）
  /plan [text]         查看当前规格；带文本则先规划
  /context             查看上下文用量
  /compact             立即压缩一次上下文
  /continue            用续跑模式接着上次预算耗尽的任务
  /pwd                 查看当前工作目录
  /cd <path>           切换工作目录（会新建会话）
  /help                帮助
  /quit                退出
`)
}

const DEMO: readonly ScriptedStep[] = [
  { calls: [{ name: 'list_dir', args: { path: '.' } }] },
  { calls: [{ name: 'read_file', args: { path: 'package.json' } }] },
  { text: '（scripted）已列出目录并读取 package.json。换成 --model deepseek 可执行真实任务。' },
]

/** 单读队列：REPL 与授权询问共用同一条 stdin，避免两个 readline 抢输入。 */
class LineReader {
  readonly #queue: string[] = []
  readonly #waiters: ((value: string | null) => void)[] = []
  readonly #rl: ReturnType<typeof createInterface>
  #closed = false

  constructor() {
    const rl = createInterface({ input: stdin, output: stdout })
    this.#rl = rl
    rl.on('line', (line) => this.#push(line))
    rl.on('close', () => {
      this.#closed = true
      while (this.#waiters.length > 0) this.#waiters.shift()?.(null)
    })
  }

  /** 必须显式关闭：readline 会持有 stdin 句柄，不关进程就退不出去。 */
  close(): void {
    if (this.#closed) return
    this.#rl.close()
  }

  read(): Promise<string | null> {
    const ready = this.#queue.shift()
    if (ready !== undefined) return Promise.resolve(ready)
    if (this.#closed) return Promise.resolve(null)
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  #push(line: string): void {
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) waiter(line)
    else this.#queue.push(line)
  }
}

function makeApprover(auto: boolean, reader: LineReader | undefined): Approver | undefined {
  if (auto) {
    return { ask: async (): Promise<GrantScope> => 'run' }
  }
  if (reader === undefined) return undefined

  return {
    async ask(query: PermissionQuery): Promise<GrantScope> {
      stdout.write(
        `\n[permission] ${query.risk}  ${query.tool}  ${JSON.stringify(query.args).slice(0, 160)}\n` +
        '  a=once  r=this run  t=this task  s=session  else=deny > ',
      )
      const answer = (await reader.read() ?? '').trim()
      if (answer === 'a') return 'once'
      if (answer === 'r') return 'run'
      if (answer === 't') return 'task'
      if (answer === 's') return 'session'
      return 'deny'
    },
  }
}

function render(event: HarnessEvent, quiet: boolean): void {
  if (quiet) return
  const at = new Date(event.at).toISOString().slice(11, 23)
  switch (event.type) {
    case 'run.start':
      stdout.write(`${at} run ${event.runId} start (resume=${event.resume})\n`)
      break
    case 'round.start':
      stdout.write(`${at}   round ${event.round} · msgs=${event.messages} · est=${event.estTokens}\n`)
      break
    case 'model.reply':
      stdout.write(
        `${at}   model ${event.kind} calls=${event.calls} ${event.ms}ms` +
        `${event.promptTokens === undefined ? '' : ` tokens=${event.promptTokens}+${event.completionTokens}`}\n`,
      )
      break
    case 'tool.start':
      stdout.write(`${at}     → ${event.tool} [${event.risk}]\n`)
      break
    case 'tool.end':
      stdout.write(`${at}     ${event.ok ? 'ok' : 'ERR'} ${event.tool} ${event.ms}ms ${event.chars}c\n`)
      break
    case 'context.compacted':
      stdout.write(`${at}   compacted ${event.entriesBefore}→${event.entriesSent} summarized=${event.summarized}\n`)
      break
    case 'guard.nudge':
      stdout.write(`${at}   guard: ${event.tool} repeated ${event.repeats}x\n`)
      break
    case 'run.end':
      stdout.write(
        `${at} run end ok=${event.ok} rounds=${event.rounds} calls=${event.calls} failures=${event.failures} ${event.ms}ms` +
        `${event.error === undefined ? '' : ` (${event.error})`}\n`,
      )
      break
  }
}

function formatPlan(spec: TaskSpec, harness: Harness): string {
  const progress = harness.plan.progress()
  const status = new Map(progress.map((item) => [item.taskId, item]))
  const lines = [`goal: ${spec.goal}`]

  if (spec.tasks.length > 0) {
    lines.push('tasks:')
    for (const task of spec.tasks) {
      const state = status.get(task.id)
      lines.push(`  [${task.id}] ${task.objective} → ${state?.status ?? 'pending'}${state?.note ? ` (${state.note})` : ''}`)
    }
  }
  if (spec.acceptance.length > 0) lines.push(`acceptance: ${spec.acceptance.join(' | ')}`)
  if (spec.outOfScope.length > 0) lines.push(`do not touch: ${spec.outOfScope.join(' | ')}`)

  return lines.join('\n')
}

async function runTask(harness: Harness, text: string, workspace: string, options: { quiet: boolean; optimize: boolean; plan: boolean; resume: boolean }): Promise<void> {
  let task = text

  if (options.plan && harness.planner !== undefined) {
    const spec = await harness.planner.plan(task)
    if (spec !== undefined) {
      harness.plan.save(spec)
      if (!options.quiet) stdout.write(`\n[plan]\n${formatPlan(spec, harness)}\n\n`)
    } else if (!options.quiet) {
      stdout.write('\n[plan] 规划失败，按原需求执行。\n\n')
    }
  }

  if (options.optimize && harness.optimizer !== undefined) {
    const rewritten = await harness.optimizer.rewrite({ task, workspace })
    if (rewritten !== task && !options.quiet) stdout.write(`[optimize] ${rewritten}\n\n`)
    task = rewritten
  }

  const report = await harness.loop.run(task, options.resume ? { resume: true } : {})

  if (report.checkpoint) {
    stdout.write('\n[checkpoint] 预算耗尽，可加 --resume 继续。\n')
  } else {
    stdout.write(`\n${report.text}\n`)
  }

  const stats = harness.compactor.stats()
  if (stats !== undefined && !options.quiet) {
    stdout.write(
      `\ncontext: est=${stats.estTokens}/${stats.maxTokens} scale=${stats.scale} ` +
      `entries=${stats.entriesSent}/${stats.entriesTotal} compacted=${stats.compacted}\n`,
    )
  }
}

function printSessions(harness: Harness, currentId: string): void {
  const items = harness.catalog.list()
  if (items.length === 0) {
    stdout.write('(no sessions)\n')
    return
  }

  for (const item of items) {
    const mark = item.id === currentId ? '*' : ' '
    const when = new Date(item.createdAt).toISOString().slice(0, 16).replace('T', ' ')
    stdout.write(
      `${mark} ${item.id.padEnd(18)} ${when}  entries=${String(item.entries).padStart(3)}` +
      `${item.hasPlan ? '  plan' : ''}  ${item.firstUser ?? ''}\n`,
    )
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  // 管道输入默认不当成交互模式；给自动化测试留一个显式开关。
  const interactive = stdin.isTTY || process.env.LOOM_FORCE_REPL === '1'
  const reader = interactive ? new LineReader() : undefined

  if (args.model === 'deepseek' && process.env.DEEPSEEK_API_KEY === undefined) {
    throw new Error('DEEPSEEK_API_KEY is required for --model deepseek')
  }

  const model = args.model === 'deepseek'
    ? new DeepSeekModel({ apiKey: process.env.DEEPSEEK_API_KEY ?? '' })
    : new ScriptedModel(DEMO, { bypassToolFree: true })

  const approver = makeApprover(args.yes, reader)

  let workspace = resolve(args.workspace)

  const loopOptions = args.maxRounds === undefined && args.maxToolCalls === undefined && args.timeoutMs === undefined
    ? {}
    : {
        loop: {
          ...(args.maxRounds === undefined ? {} : { maxRounds: args.maxRounds }),
          ...(args.maxToolCalls === undefined ? {} : { maxCalls: args.maxToolCalls }),
          ...(args.timeoutMs === undefined ? {} : { deadlineMs: args.timeoutMs }),
        },
      }

  const build = (sessionId: string): Promise<Harness> => createHarness({
    workspace,
    model,
    sessionId,
    ...(args.sessionDir === undefined ? {} : { sessionDir: args.sessionDir }),
    ...(approver === undefined ? {} : { approver }),
    ...(args.ephemeral ? { sessionStore: 'memory' as const } : {}),
    ...loopOptions,
  })

  let harness = await build(args.session)
  let currentId = args.session
  harness.events.subscribe((event) => render(event, args.quiet))

  // 一次性模式
  if (args.task.trim().length > 0) {
    try {
      await runTask(harness, args.task, args.workspace, {
        quiet: args.quiet,
        optimize: args.optimize,
        plan: args.plan,
        resume: args.resume,
      })
      process.exitCode = harness.session.entries().length === 0 ? 1 : 0
    } finally {
      await harness.dispose()
      reader?.close()
    }
    return
  }

  if (!interactive) {
    printHelp()
    await harness.dispose()
    reader?.close()
    process.exitCode = 1
    return
  }

  stdout.write(`loom · session=${currentId} · workspace=${workspace}\n`)
  stdout.write(`plugins: ${harness.order.join(' → ')}\n/help 查看命令\n\n`)

  while (true) {
    stdout.write(`loom:${currentId}> `)
    const line = await reader?.read()
    if (line === null || line === undefined) break

    const input = line.trim()
    if (input.length === 0) continue

    if (input === '/quit' || input === '/exit') break

    if (input === '/help') {
      printHelp()
      continue
    }

    if (input === '/sessions') {
      printSessions(harness, currentId)
      continue
    }

    if (input.startsWith('/use ')) {
      const id = input.slice(5).trim()
      await harness.dispose()
      harness = await build(id)
      currentId = id
      harness.events.subscribe((event) => render(event, args.quiet))
      stdout.write(`switched to ${id} (${harness.session.entries().length} entries${harness.plan.current() === undefined ? '' : ', with plan'})\n`)
      continue
    }

    if (input === '/new' || input.startsWith('/new ')) {
      const id = input.length > 5 ? input.slice(5).trim() : `s${Date.now().toString(36)}`
      await harness.dispose()
      harness = await build(id)
      currentId = id
      harness.events.subscribe((event) => render(event, args.quiet))
      stdout.write(`new session ${id}\n`)
      continue
    }

    if (input.startsWith('/delete ')) {
      const id = input.slice(8).trim()
      if (id === currentId) {
        stdout.write('cannot delete the active session\n')
        continue
      }
      stdout.write(harness.catalog.remove(id) ? `deleted ${id}\n` : `no such session: ${id}\n`)
      continue
    }

    if (input === '/history' || input.startsWith('/history ')) {
      const count = Number(input.split(/\s+/)[1] ?? '10')
      const entries = harness.session.entries()
      const slice = entries.slice(Math.max(0, entries.length - (Number.isFinite(count) ? count : 10)))
      if (slice.length === 0) stdout.write('(empty)\n')
      for (const entry of slice) {
        if (entry.kind === 'assistant') {
          stdout.write(`assistant${entry.calls.length > 0 ? ` (${entry.calls.length} calls)` : ''}: ${entry.text.slice(0, 100)}\n`)
        } else if (entry.kind === 'tool') {
          stdout.write(`tool ${entry.name}${entry.failed ? ' [failed]' : ''}: ${entry.output.slice(0, 80).replace(/\n/g, ' ')}\n`)
        } else if (entry.kind === 'notice') {
          stdout.write(`notice: ${entry.text.slice(0, 80)}\n`)
        } else {
          stdout.write(`user: ${entry.text.slice(0, 100)}\n`)
        }
      }
      continue
    }

    if (input === '/plan' || input.startsWith('/plan ')) {
      const text = input.length > 5 ? input.slice(5).trim() : ''
      if (text.length > 0) {
        if (harness.planner === undefined) {
          stdout.write('planner is not available in this build\n')
          continue
        }
        const spec = await harness.planner.plan(text)
        if (spec === undefined) {
          stdout.write('planning failed; nothing saved\n')
          continue
        }
        harness.plan.save(spec)
      }

      const spec = harness.plan.current()
      stdout.write(spec === undefined ? '(no plan yet — try /plan <request>)\n' : `${formatPlan(spec, harness)}\n`)
      continue
    }

    if (input === '/context') {
      const stats = harness.compactor.stats()
      stdout.write(stats === undefined
        ? '(no model call yet)\n'
        : `est=${stats.estTokens}/${stats.maxTokens} ratio=${stats.ratio.toFixed(2)} scale=${stats.scale} sent=${stats.entriesSent}/${stats.entriesTotal}\n`)
      continue
    }

    if (input === '/compact') {
      const before = harness.compactor.stats()
      const after = await harness.compactor.compact()
      stdout.write(
        `compacted: entries ${before?.entriesTotal ?? 0} → ${after.entriesSent}, ` +
        `est=${after.estTokens}/${after.maxTokens} scale=${after.scale}\n`,
      )
      continue
    }

    if (input === '/continue') {
      const report = await harness.loop.run('', { resume: true })
      stdout.write(report.checkpoint
        ? '[checkpoint] 仍然超出预算，可调大 --max-rounds 后继续\n'
        : `\n${report.text}\n`)
      continue
    }

    if (input === '/pwd') {
      stdout.write(`${workspace}\n`)
      continue
    }

    if (input.startsWith('/cd ')) {
      const next = resolve(workspace, input.slice(4).trim())
      let isDir = false
      try {
        isDir = statSync(next).isDirectory()
      } catch {
        isDir = false
      }
      if (!isDir) {
        stdout.write(`not a directory: ${next}\n`)
        continue
      }

      await harness.dispose()
      workspace = next
      currentId = `${basename(next) || 'ws'}-${Date.now().toString(36)}`
      harness = await build(currentId)
      harness.events.subscribe((event) => render(event, args.quiet))
      stdout.write(`workspace=${workspace}  new session=${currentId}\n`)
      continue
    }

    if (input.startsWith('/')) {
      stdout.write(`unknown command: ${input.split(/\s+/)[0]} (see /help)\n`)
      continue
    }

    await runTask(harness, input, args.workspace, { quiet: false, optimize: args.optimize, plan: args.plan, resume: false })
  }

  await harness.dispose()
  reader?.close()
  stdout.write('\nbye\n')
}

main().catch((error: unknown) => {
  stdout.write(`\nfatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
