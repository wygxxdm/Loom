import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { ModelPort, ModelReply, ModelInput, TokenUsage } from '../src/contracts/model.ts'
import type { HarnessEvent } from '../src/contracts/events.ts'
import { ScriptedModel, type ScriptedStep } from '../src/plugins/scripted-model.ts'
import { DeepSeekModel } from '../src/plugins/deepseek-model.ts'
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
  readonly error?: string
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

async function runOnce(
  taskDir: string,
  task: TaskFile,
  arm: Arm,
  seed: number,
  model: 'deepseek' | 'scripted',
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
    compactor: { maxTokens: 1_500, threshold: 0.6, keepRecent: 6, enabled: arm.compact },
    loop: { maxRounds: 20, maxCalls: 40, deadlineMs: 180_000 },
  })

  const events: HarnessEvent[] = []
  harness.events.subscribe((event) => events.push(event))

  let error: string | undefined
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
    error = caught instanceof Error ? caught.message : String(caught)
  } finally {
    await harness.dispose()
    rmSync(box, { recursive: true, force: true })
  }

  const row: Row = {
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
    ...(error === undefined ? {} : { error }),
  }

  const outDir = resolve('bench', 'runs', model, arm.name)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, `${task.id}-s${seed}.json`), `${JSON.stringify(row, null, 2)}\n`)

  return row
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const modelArg = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : 'scripted'
  const model = modelArg === 'deepseek' ? 'deepseek' : 'scripted'
  const repeat = argv.includes('--repeat') ? Number(argv[argv.indexOf('--repeat') + 1]) : 1

  if (model === 'deepseek' && process.env.DEEPSEEK_API_KEY === undefined) {
    throw new Error('DEEPSEEK_API_KEY is required for --model deepseek')
  }

  const tasks = readTasks(resolve('bench', 'tasks'))
  const rows: Row[] = []

  process.stdout.write(`model=${model} tasks=${tasks.length} arms=${ARMS.length} seeds=${repeat}\n`)

  for (const arm of ARMS) {
    for (const { dir, task } of tasks) {
      if (model === 'scripted' && task.demo === undefined) continue
      for (let seed = 1; seed <= repeat; seed += 1) {
        const row = await runOnce(dir, task, arm, seed, model)
        rows.push(row)
        process.stdout.write(
          `  ${arm.name.padEnd(9)} ${task.id.padEnd(12)} ${row.pass ? 'PASS' : 'FAIL'} ` +
          `rounds=${row.rounds} calls=${row.calls} tokens=${row.promptTokens + row.completionTokens}\n`,
        )
      }
    }
  }

  process.stdout.write('\n| arm | pass | rounds | calls | failures | tokens | latency |\n')
  process.stdout.write('|---|---|---|---|---|---|---|\n')
  for (const arm of ARMS) {
    process.stdout.write(`${summary(rows, arm.name)}\n`)
  }

  if (model === 'scripted') {
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
