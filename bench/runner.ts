import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { ModelPort, ModelReply, ModelInput, TokenUsage } from '../src/contracts/model.ts'
import type { HarnessEvent } from '../src/contracts/events.ts'
import { ScriptedModel, type ScriptedStep } from '../src/plugins/scripted-model.ts'
import { DeepSeekModel, ModelHttpError } from '../src/plugins/deepseek-model.ts'
import { createHarness } from '../src/runtime.ts'

interface TaskFile {
  readonly id: string
  readonly category: string
  readonly difficulty: string
  readonly prompt: string
  readonly verify: { readonly command: string; readonly timeoutMs: number }
  readonly demo?: readonly { readonly name: string; readonly args: Record<string, unknown> }[]
}

interface Arm {
  readonly name: string
  readonly compact: boolean
  readonly optimize: boolean
}

const ARMS: readonly Arm[] = [
  { name: 'baseline', compact: false, optimize: false },
  { name: 'compact', compact: true, optimize: false },
  { name: 'optimize', compact: false, optimize: true },
  { name: 'full', compact: true, optimize: true },
]

interface Row {
  readonly arm: string
  readonly task: string
  readonly seed: number
  readonly pass: boolean
  readonly rounds: number
  readonly calls: number
  readonly failures: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly ms: number
  readonly checkpoint: boolean
  /** 本次运行里压缩触发了几次；0 表示窗口一直没超。 */
  readonly compactions: number
  readonly error?: string
}

interface Options {
  readonly model: 'deepseek' | 'scripted'
  readonly repeat: number
  readonly force: boolean
  readonly dryRun: boolean
  readonly only: ReadonlySet<string> | undefined
  readonly arms: ReadonlySet<string> | undefined
  /** 覆盖 compaction 的窗口上限，用于强制触发压缩的压力测试。 */
  readonly window: number | undefined
}

function parseOptions(argv: readonly string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index < 0 ? undefined : argv[index + 1]
  }
  const list = (flag: string): ReadonlySet<string> | undefined => {
    const raw = value(flag)
    return raw === undefined ? undefined : new Set(raw.split(',').map((item) => item.trim()))
  }

  return {
    model: value('--model') === 'deepseek' ? 'deepseek' : 'scripted',
    repeat: Number(value('--repeat') ?? 1),
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
    only: list('--only'),
    arms: list('--arms'),
    window: value('--window') === undefined ? undefined : Number(value('--window')),
  }
}

/** 包一层，只做一件事：累计服务端返回的真实用量。 */
class CountingModel implements ModelPort {
  readonly #inner: ModelPort
  prompt = 0
  completion = 0

  constructor(inner: ModelPort) {
    this.#inner = inner
  }

  async run(input: ModelInput): Promise<ModelReply> {
    const reply = await this.#inner.run(input)
    const usage: TokenUsage | undefined = reply.usage
    if (usage !== undefined) {
      this.prompt += usage.prompt
      this.completion += usage.completion
    }
    return reply
  }
}

function readTasks(root: string): { dir: string; task: TaskFile }[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(root, entry.name)
      const task = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8')) as TaskFile
      return { dir, task }
    })
    .sort((left, right) => left.task.id.localeCompare(right.task.id))
}

function verify(task: TaskFile, runDir: string, pristineDir: string): { pass: boolean; error?: string } {
  // 防作弊：验证前用原始 spec 覆盖回去，agent 改测试不算通过。
  // pristine 放在 agent 工作区之外，避免它顺手改掉“原始副本”。
  if (existsSync(pristineDir)) {
    cpSync(pristineDir, join(runDir, 'spec'), { recursive: true, force: true })
  }

  const [executable, ...args] = task.verify.command.split(/\s+/)
  const command = executable === 'node' ? process.execPath : (executable ?? 'node')
  const result = spawnSync(command, args, {
    cwd: runDir,
    timeout: task.verify.timeoutMs,
    encoding: 'utf8',
    env: { ...process.env, PATH: process.env.PATH ?? '' },
  })

  if (result.status === 0) return { pass: true }

  const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(-400)
  return { pass: false, error: detail.length > 0 ? detail : `exit ${String(result.status)}` }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ModelHttpError) return error.retryable
  // fetch 在网络层失败时抛 TypeError（DNS、连接重置）。
  return error instanceof TypeError
}

async function withRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run()
    } catch (error: unknown) {
      lastError = error
      if (!isRetryable(error) || attempt === attempts) throw error

      const wait = 2_000 * 3 ** (attempt - 1)
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`    retry ${attempt}/${attempts - 1} in ${wait}ms: ${detail.slice(0, 120)}\n`)
      await new Promise((done) => setTimeout(done, wait))
    }
  }

  throw lastError
}

async function runOnce(
  taskDir: string,
  task: TaskFile,
  arm: Arm,
  seed: number,
  model: 'deepseek' | 'scripted',
  window: number | undefined,
): Promise<Row> {
  const box = mkdtempSync(join(tmpdir(), `loom-bench-${task.id}-`))
  const runDir = join(box, 'ws')
  const pristineDir = join(box, 'pristine-spec')
  cpSync(join(taskDir, 'workspace'), runDir, { recursive: true })
  // 原始 spec 留一份在 agent 改不到的位置（在 box 里，不在 workspace 里）。
  cpSync(join(runDir, 'spec'), pristineDir, { recursive: true })

  const steps: ScriptedStep[] = [
    ...(task.demo ?? []).map((call) => ({
      calls: [{ name: call.name, args: call.args }],
    })),
    { text: '已完成修改。' },
  ]

  const counting = new CountingModel(
    model === 'deepseek'
      ? new DeepSeekModel({ apiKey: process.env.DEEPSEEK_API_KEY ?? '' })
      : new ScriptedModel(steps, { bypassToolFree: true }),
  )

  const harness = await createHarness({
    workspace: runDir,
    model: counting,
    sessionPath: join(runDir, '.loom', 'session.jsonl'),
    // 基准跑批无人值守：统一授予 session 级权限，避免因等待确认而超时。
    approver: { ask: async () => 'session' },
    compactor: {
      maxTokens: window ?? 1_500,
      threshold: 0.6,
      keepRecent: 6,
      enabled: arm.compact,
    },
    loop: { maxRounds: 20, maxCalls: 40, deadlineMs: 180_000 },
  })

  const events: HarnessEvent[] = []
  harness.events.subscribe((event) => events.push(event))

  let error: string | undefined
  let fatal: unknown
  let report = { rounds: 0, calls: 0, failures: 0, ms: 0, checkpoint: false }
  let pass = false

  try {
    const prompt = arm.optimize && harness.optimizer !== undefined
      ? await harness.optimizer.rewrite({ task: task.prompt, workspace: runDir })
      : task.prompt

    const result = await harness.loop.run(prompt)
    report = {
      rounds: result.rounds,
      calls: result.calls,
      failures: result.failures,
      ms: result.ms,
      checkpoint: result.checkpoint,
    }

    const verdict = verify(task, runDir, pristineDir)
    pass = verdict.pass
    error = verdict.error
  } catch (caught: unknown) {
    if (isRetryable(caught)) {
      // 限流/网络错误不写结果文件，交给外层退避重试。
      fatal = caught
    } else {
      error = caught instanceof Error ? caught.message : String(caught)
    }
  } finally {
    await harness.dispose()
    rmSync(box, { recursive: true, force: true })
  }

  if (fatal !== undefined) throw fatal

  return {
    arm: arm.name,
    task: task.id,
    seed,
    pass,
    rounds: report.rounds,
    calls: report.calls,
    failures: report.failures,
    promptTokens: counting.prompt,
    completionTokens: counting.completion,
    ms: report.ms,
    checkpoint: report.checkpoint,
    compactions: events.filter((event) => event.type === 'context.compacted').length,
    ...(error === undefined ? {} : { error }),
  }
}

function resultPath(model: string, arm: string, taskId: string, seed: number, window?: number): string {
  const bucket = window === undefined ? model : `${model}-w${window}`
  return resolve('bench', 'runs', bucket, arm, `${taskId}-s${seed}.json`)
}

function loadRow(path: string): Row | undefined {
  try {
    const row = JSON.parse(readFileSync(path, 'utf8')) as Row
    if (typeof row.task !== 'string' || typeof row.pass !== 'boolean') return undefined
    return row
  } catch {
    // 损坏的结果文件当作没跑过，重跑一次比读一半数据强。
    return undefined
  }
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function summary(rows: readonly Row[], arm: string): string {
  const mine = rows.filter((row) => row.arm === arm)
  const pass = mine.filter((row) => row.pass).length
  const tokens = mine.map((row) => row.promptTokens + row.completionTokens)
  return [
    `| ${arm} | ${pass}/${mine.length} |`,
    `${mean(mine.map((row) => row.rounds)).toFixed(1)} |`,
    `${mean(mine.map((row) => row.calls)).toFixed(1)} |`,
    `${mean(mine.map((row) => row.failures)).toFixed(2)} |`,
    `${Math.round(mean(tokens))} |`,
    `${Math.round(mean(mine.map((row) => row.ms)))}ms |`,
  ].join(' ')
}

function preview(plan: readonly { arm: Arm; task: TaskFile; seed: number }[], options: Options): void {
  const paths = plan.map((item) => resultPath(options.model, item.arm.name, item.task.id, item.seed, options.window))
  const cached = paths.filter((path) => existsSync(path) && loadRow(path) !== undefined).length
  const pending = plan.length - cached

  const armCount = new Set(plan.map((item) => item.arm.name)).size
  const taskCount = armCount === 0 ? 0 : plan.length / armCount / options.repeat

  process.stdout.write(
    `model=${options.model} 计划 ${plan.length} 次（${taskCount} 题 × ${armCount} 臂 × ${options.repeat} seed）\n` +
    `已完成 ${cached}，待跑 ${pending}${options.force ? '（--force 会全部重跑）' : ''}\n`,
  )

  if (pending === 0) {
    process.stdout.write('没有待跑的任务。\n')
    return
  }

  const previous = paths
    .filter((path) => existsSync(path))
    .map((path) => loadRow(path))
    .filter((row): row is Row => row !== undefined)

  if (previous.length === 0) {
    process.stdout.write('没有历史结果，无法估算 token；先跑一次 --repeat 1 拿基线。\n')
    return
  }

  const perRun = mean(previous.map((row) => row.promptTokens + row.completionTokens))
  const estimate = Math.round(perRun * pending)
  process.stdout.write(`按已有 ${previous.length} 次结果均值 ${Math.round(perRun)} token/次，预计 ${estimate} token\n`)

  const price = Number(process.env.LOOM_PRICE_PER_M ?? '0')
  if (price > 0) {
    process.stdout.write(`按 ${price} 元/百万 token 估算：约 ${(estimate / 1_000_000 * price).toFixed(2)} 元\n`)
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))

  if (options.model === 'deepseek' && process.env.DEEPSEEK_API_KEY === undefined) {
    throw new Error('DEEPSEEK_API_KEY is required for --model deepseek')
  }

  const tasks = readTasks(resolve('bench', 'tasks')).filter(
    (item) => options.only === undefined || options.only.has(item.task.id),
  )
  const arms = ARMS.filter((arm) => options.arms === undefined || options.arms.has(arm.name))

  const skipped: string[] = []
  const plan: { arm: Arm; task: TaskFile; dir: string; seed: number }[] = []

  for (const arm of arms) {
    for (const { dir, task } of tasks) {
      if (options.model === 'scripted' && task.demo === undefined) {
        // 脚本模式只能执行带 demo 的任务；其余跳过并统计，避免表格看起来“全跑过”。
        if (!skipped.includes(task.id)) skipped.push(task.id)
        continue
      }
      for (let seed = 1; seed <= options.repeat; seed += 1) {
        plan.push({ arm, task, dir, seed })
      }
    }
  }

  if (options.dryRun) {
    preview(plan, options)
    return
  }

  const rows: Row[] = []
  let cached = 0

  for (const item of plan) {
    const path = resultPath(options.model, item.arm.name, item.task.id, item.seed, options.window)
    const existing = options.force ? undefined : loadRow(path)
    const label = `${item.arm.name.padEnd(9)} ${item.task.id.padEnd(22)}`

    if (existing !== undefined) {
      rows.push(existing)
      cached += 1
      process.stdout.write(`  ${label} cached ${existing.pass ? 'PASS' : 'FAIL'}\n`)
      continue
    }

    const row = await withRetry(() => runOnce(item.dir, item.task, item.arm, item.seed, options.model, options.window))
    rows.push(row)

    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(row, null, 2)}\n`)

    process.stdout.write(
      `  ${label} ${row.pass ? 'PASS' : 'FAIL'} rounds=${row.rounds} calls=${row.calls} ` +
      `tokens=${row.promptTokens + row.completionTokens} compact=${row.compactions}\n`,
    )
  }

  process.stdout.write('\n| arm | pass | rounds | calls | failures | tokens | latency |\n')
  process.stdout.write('|---|---|---|---|---|---|---|\n')
  for (const arm of arms) {
    process.stdout.write(`${summary(rows, arm.name)}\n`)
  }

  if (cached > 0) {
    process.stdout.write(`\n其中 ${cached} 次来自已有结果，${rows.length - cached} 次本次运行。\n`)
  }

  if (options.model === 'scripted') {
    if (skipped.length > 0) {
      process.stdout.write(`\n跳过 ${skipped.length} 个没有 demo 的任务：${skipped.join(', ')}\n`)
    }
    process.stdout.write(
      '\n注意：scripted 模式按预设脚本执行，只能验证流水线连通性，不能用于评估能力差异。\n' +
      '真实数字请用 --model deepseek 重跑。\n',
    )
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`bench failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
