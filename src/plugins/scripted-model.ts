import type { ModelInput, ModelPort, ModelReply } from '../contracts/model.ts'
import { ModelKey } from '../contracts/keys.ts'
import type { Plugin } from '../kernel/plugin.ts'

export interface ScriptedStep {
  /** 纯文本回答，或工具调用前的说明。 */
  readonly text?: string
  /** 本步要发起的工具调用；为空数组时表示普通回答。 */
  readonly calls?: readonly { readonly name: string; readonly args?: Record<string, unknown> }[]
  /** 专门构造“返回了 tool-call 但一条调用都没有”这种格式抖动，用于测试重试路径。 */
  readonly emptyCalls?: boolean
}

export interface ScriptedOptions {
  /** 脚本耗尽后的兜底回答。 */
  readonly fallback?: string
  /**
   * 无工具的请求（改写、摘要）直接返回固定值，不消耗脚本步骤。
   *
   * 否则优化器会“吃掉”本应给 Agent 的一步，让消融结果看起来更便宜——
   * 这是脚本化测试最容易产生的假象。
   */
  readonly bypassToolFree?: boolean
}

/**
 * 脚本化模型：按预设序列逐步返回，用于测试与离线演示。
 *
 * 它不“思考”，因此不能用来评估 Agent 的真实能力——只用于验证
 * Harness 的行为（批次原子性、预算、权限、压缩、护栏）。
 */
export class ScriptedModel implements ModelPort {
  readonly #steps: readonly ScriptedStep[]
  readonly #options: ScriptedOptions
  #index = 0
  #callSeq = 0

  constructor(steps: readonly ScriptedStep[], options: ScriptedOptions = {}) {
    this.#steps = steps
    this.#options = options
  }

  get remaining(): number {
    return Math.max(0, this.#steps.length - this.#index)
  }

  async run(input: ModelInput): Promise<ModelReply> {
    input.signal?.throwIfAborted()

    // 让估算校准路径在离线模式下也能被触发：用量按输入规模合成。
    const usage = {
      prompt: Math.max(1, Math.ceil(estimate(input))),
      completion: 8,
    }

    if (this.#options.bypassToolFree === true && input.tools.length === 0) {
      return { kind: 'message', text: 'NOOP', usage }
    }

    const step = this.#steps[this.#index]
    this.#index += 1

    if (step === undefined) {
      return { kind: 'message', text: this.#options.fallback ?? '(script finished, no further steps)', usage }
    }

    if (step.emptyCalls === true) {
      return { kind: 'calls', calls: [], usage }
    }

    if (step.calls !== undefined && step.calls.length > 0) {
      return {
        kind: 'calls',
        text: step.text ?? '',
        calls: step.calls.map((call) => {
          this.#callSeq += 1
          return { id: `call_${this.#callSeq}`, name: call.name, args: call.args ?? {} }
        }),
        usage,
      }
    }

    return { kind: 'message', text: step.text ?? '', usage }
  }
}

function estimate(input: ModelInput): number {
  const text = `${input.system ?? ''}${JSON.stringify(input.messages)}${JSON.stringify(input.tools)}`
  let ascii = 0
  let wide = 0
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) <= 0x7f) ascii += 1
    else wide += 1
  }
  return 0.8 * (Math.ceil(ascii / 4) + wide)
}

export function scriptedPlugin(steps: readonly ScriptedStep[]): Plugin {
  return {
    name: 'model-scripted',
    provides: [ModelKey],
    setup(scope) {
      scope.provide(ModelKey, new ScriptedModel(steps))
    },
  }
}
