import { randomUUID } from 'node:crypto'
import type { CompactorPort } from '../contracts/context.ts'
import type { EventsPort } from '../contracts/events.ts'
import type { GuardPort } from '../contracts/guard.ts'
import type { LoopPort, RunOptions, RunReport } from '../contracts/loop.ts'
import { BudgetExceeded } from '../contracts/loop.ts'
import type { ModelPort } from '../contracts/model.ts'
import type { PermissionPort } from '../contracts/permission.ts'
import type { Entry, SessionPort } from '../contracts/session.ts'
import type { ToolCall, ToolRisk, ToolsPort } from '../contracts/tools.ts'
import { GuardKey, LoopKey, ModelKey, PermissionKey, SessionKey, ToolsKey, CompactorKey, EventsKey } from '../contracts/keys.ts'
import type { Plugin } from '../kernel/plugin.ts'

export interface LoopConfig {
  readonly maxRounds: number
  readonly maxCalls: number
  readonly deadlineMs: number
  readonly readConcurrency: number
}

export const LOOP_DEFAULTS: LoopConfig = {
  maxRounds: 32,
  maxCalls: 96,
  deadlineMs: 8 * 60_000,
  readConcurrency: 4,
}

interface Prepared {
  readonly call: ToolCall
  readonly risk: ToolRisk
}

export class HarnessLoop implements LoopPort {
  readonly #session: SessionPort
  readonly #model: ModelPort
  readonly #tools: ToolsPort
  readonly #permission: PermissionPort
  readonly #events: EventsPort
  readonly #compactor: CompactorPort
  readonly #guard: GuardPort | undefined
  readonly #config: LoopConfig
  #runSeq = 0

  constructor(deps: {
    session: SessionPort
    model: ModelPort
    tools: ToolsPort
    permission: PermissionPort
    events: EventsPort
    compactor: CompactorPort
    guard?: GuardPort
  }, config: LoopConfig) {
    this.#session = deps.session
    this.#model = deps.model
    this.#tools = deps.tools
    this.#permission = deps.permission
    this.#events = deps.events
    this.#compactor = deps.compactor
    this.#guard = deps.guard
    this.#config = config
  }

  async run(task: string, options: RunOptions = {}): Promise<RunReport> {
    this.#runSeq += 1
    const runId = `run-${this.#runSeq}-${randomUUID().slice(0, 8)}`
    const taskId = options.taskId ?? runId
    const startedAt = Date.now()

    const controller = new AbortController()
    const unlink = linkSignal(options.signal, controller)
    const timer = setTimeout(() => {
      controller.abort(new BudgetExceeded('deadline', this.#config.deadlineMs))
    }, this.#config.deadlineMs)
    const signal = controller.signal

    let rounds = 0
    let calls = 0
    let failures = 0
    let emptyRetries = 0
    let checkpoint = false
    let text = ''
    let wasCompacted = false

    this.#events.emit({
      type: 'run.start',
      at: startedAt,
      runId,
      taskChars: task.length,
      resume: options.resume === true,
    })

    if (options.resume !== true) {
      this.#session.append([{ kind: 'user', text: task }])
    }

    try {
      for (rounds = 1; rounds <= this.#config.maxRounds; rounds += 1) {
        throwIfAborted(signal)

        const view = await this.#compactor.build({ system: options.system, signal })
        const stats = this.#compactor.stats()

        if (view.compacted && !wasCompacted) {
          wasCompacted = true
          this.#events.emit({
            type: 'context.compacted',
            at: Date.now(),
            runId,
            entriesBefore: stats?.entriesTotal ?? 0,
            entriesSent: stats?.entriesSent ?? view.messages.length,
            summarized: view.system !== options.system,
          })
        }

        this.#events.emit({
          type: 'round.start',
          at: Date.now(),
          runId,
          round: rounds,
          messages: view.messages.length,
          tools: view.tools.length,
          estTokens: stats?.estTokens ?? 0,
        })

        const modelStartedAt = Date.now()
        const reply = await this.#model.run({
          system: view.system,
          messages: view.messages,
          tools: view.tools,
          signal,
        })

        this.#events.emit({
          type: 'model.reply',
          at: Date.now(),
          runId,
          round: rounds,
          kind: reply.kind,
          calls: reply.kind === 'calls' ? reply.calls.length : 0,
          ms: Date.now() - modelStartedAt,
          ...(reply.usage === undefined
            ? {}
            : { promptTokens: reply.usage.prompt, completionTokens: reply.usage.completion }),
        })

        if (reply.usage !== undefined) {
          this.#compactor.observe(reply.usage.prompt)
        }

        if (reply.kind === 'message') {
          text = reply.text
          this.#session.append([{ kind: 'assistant', text, calls: [] }])
          break
        }

        const batch = reply.calls
        if (batch.length === 0) {
          // 空调用是模型侧的格式抖动，给它一次纠正机会，而不是整轮失败。
          emptyRetries += 1
          if (emptyRetries > 1) {
            throw new Error('model returned an empty tool call list twice in a row')
          }
          this.#session.append([{
            kind: 'notice',
            text: '上一条回复既没有给出答案，也没有工具调用。请直接回答，或重新发起工具调用。',
          }])
          continue
        }

        if (calls + batch.length > this.#config.maxCalls) {
          throw new BudgetExceeded('calls', this.#config.maxCalls)
        }

        const prepared: Prepared[] = batch.map((call) => ({
          call,
          risk: this.#tools.riskOf(call.name, call.args),
        }))

        const allowed = new Map<string, boolean>()
        for (const item of prepared) {
          const verdict = await this.#permission.check({
            runId,
            taskId,
            tool: item.call.name,
            risk: item.risk,
            args: item.call.args,
          }, signal)
          allowed.set(item.call.id, verdict === 'allow')
        }

        const nudges: string[] = []
        for (const item of prepared) {
          const verdict = this.#guard?.observe(item.call.name, item.call.args)
          if (verdict?.tripped === true && verdict.nudge !== undefined) {
            nudges.push(verdict.nudge)
            this.#events.emit({
              type: 'guard.nudge',
              at: Date.now(),
              runId,
              tool: item.call.name,
              repeats: verdict.repeats,
            })
          }
        }

        const results = await this.#executeBatch(prepared, allowed, runId, signal)
        calls += batch.length
        failures += results.filter((entry) => entry.kind === 'tool' && entry.failed).length

        // 整批一次写入：assistant 调用与全部结果同生共死。
        this.#session.append([
          { kind: 'assistant', text: reply.text ?? '', calls: batch },
          ...results,
        ])

        for (const nudge of nudges) {
          this.#session.append([{ kind: 'notice', text: nudge }])
        }
      }

      if (rounds > this.#config.maxRounds && text.length === 0) {
        throw new BudgetExceeded('rounds', this.#config.maxRounds)
      }
    } catch (error: unknown) {
      if (error instanceof BudgetExceeded) {
        checkpoint = true
      } else {
        this.#events.emit({
          type: 'run.end',
          at: Date.now(),
          runId,
          ok: false,
          rounds,
          calls,
          failures,
          ms: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        })
        this.#session.flush()
        throw error
      }
    } finally {
      clearTimeout(timer)
      unlink()
      this.#permission.dropRun(runId)
      if (!checkpoint) {
        this.#permission.dropTask(taskId)
      }
    }

    const report: RunReport = {
      text,
      runId,
      rounds,
      calls,
      failures,
      ms: Date.now() - startedAt,
      checkpoint,
    }

    this.#events.emit({
      type: 'run.end',
      at: Date.now(),
      runId,
      ok: !checkpoint,
      rounds,
      calls,
      failures,
      ms: report.ms,
      ...(checkpoint ? { error: 'budget exhausted' } : {}),
    })
    this.#session.flush()

    return report
  }

  /**
   * 执行一批工具调用。
   *
   * 只读调用并发执行（模型经常一次读多个文件），有副作用的一律串行，
   * 避免写写冲突。结果按调用顺序回填，保证与 assistant 的 calls 对齐。
   */
  async #executeBatch(
    prepared: readonly Prepared[],
    allowed: ReadonlyMap<string, boolean>,
    runId: string,
    signal: AbortSignal,
  ): Promise<Entry[]> {
    const results: Entry[] = new Array(prepared.length)
    const serialIdx: number[] = []
    const readIdx: number[] = []

    prepared.forEach((item, index) => {
      if (allowed.get(item.call.id) === true && item.risk === 'read-only') {
        readIdx.push(index)
      } else {
        serialIdx.push(index)
      }
    })

    for (const index of serialIdx) {
      const item = prepared[index]
      if (item !== undefined) {
        results[index] = await this.#executeOne(item, allowed, runId, signal)
      }
    }

    let cursor = 0
    const workers = Array.from({ length: Math.min(this.#config.readConcurrency, readIdx.length) }, async () => {
      while (cursor < readIdx.length) {
        const index = readIdx[cursor]
        cursor += 1
        const item = index === undefined ? undefined : prepared[index]
        if (item !== undefined) {
          results[index] = await this.#executeOne(item, allowed, runId, signal)
        }
      }
    })
    await Promise.all(workers)

    return results
  }

  async #executeOne(
    item: Prepared,
    allowed: ReadonlyMap<string, boolean>,
    runId: string,
    signal: AbortSignal,
  ): Promise<Entry> {
    const startedAt = Date.now()
    this.#events.emit({
      type: 'tool.start',
      at: startedAt,
      runId,
      callId: item.call.id,
      tool: item.call.name,
      risk: item.risk,
    })

    if (allowed.get(item.call.id) !== true) {
      const output = `permission denied for tool "${item.call.name}"`
      this.#events.emit({
        type: 'tool.end',
        at: Date.now(),
        runId,
        callId: item.call.id,
        tool: item.call.name,
        ok: false,
        ms: Date.now() - startedAt,
        chars: output.length,
      })
      return { kind: 'tool', callId: item.call.id, name: item.call.name, output, failed: true }
    }

    try {
      const output = await this.#tools.invoke(item.call.name, item.call.args, signal)
      this.#events.emit({
        type: 'tool.end',
        at: Date.now(),
        runId,
        callId: item.call.id,
        tool: item.call.name,
        ok: true,
        ms: Date.now() - startedAt,
        chars: output.length,
      })
      return { kind: 'tool', callId: item.call.id, name: item.call.name, output, failed: false }
    } catch (error: unknown) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
      }
      const output = `tool error: ${error instanceof Error ? error.message : String(error)}`
      this.#events.emit({
        type: 'tool.end',
        at: Date.now(),
        runId,
        callId: item.call.id,
        tool: item.call.name,
        ok: false,
        ms: Date.now() - startedAt,
        chars: output.length,
      })
      return { kind: 'tool', callId: item.call.id, name: item.call.name, output, failed: true }
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
}

function linkSignal(parent: AbortSignal | undefined, controller: AbortController): () => void {
  if (parent === undefined) return () => {}
  if (parent.aborted) {
    controller.abort(parent.reason)
    return () => {}
  }
  const onAbort = (): void => controller.abort(parent.reason)
  parent.addEventListener('abort', onAbort, { once: true })
  return () => parent.removeEventListener('abort', onAbort)
}

export function agentLoopPlugin(config: Partial<LoopConfig> = {}): Plugin {
  const merged: LoopConfig = { ...LOOP_DEFAULTS, ...config }

  return {
    name: 'agent-loop',
    needs: [SessionKey, ModelKey, ToolsKey, PermissionKey, EventsKey, CompactorKey],
    provides: [LoopKey],
    setup(scope) {
      const guard = scope.optional(GuardKey)
      scope.provide(LoopKey, new HarnessLoop({
        session: scope.require(SessionKey),
        model: scope.require(ModelKey),
        tools: scope.require(ToolsKey),
        permission: scope.require(PermissionKey),
        events: scope.require(EventsKey),
        compactor: scope.require(CompactorKey),
        ...(guard === undefined ? {} : { guard }),
      }, merged))
    },
  }
}
