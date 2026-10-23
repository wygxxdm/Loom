import { ModelKey, OptimizerKey } from '../contracts/keys.ts'
import type { ModelPort } from '../contracts/model.ts'
import type { OptimizeInput, OptimizerPort } from '../contracts/optimizer.ts'
import type { Plugin } from '../kernel/plugin.ts'

const SYSTEM = [
  'Rewrite a user request into one clear, actionable instruction for a coding agent.',
  'Preserve the intent. State the expected outcome. Add verification only when it is obvious.',
  'Do NOT plan, do NOT name files, do NOT choose libraries, do NOT write code.',
  'If the request is already clear, return it with minimal edits.',
  'Return the instruction only.',
].join(' ')

/**
 * 基于同一个模型的轻量改写器。
 *
 * 它的输出直接作为 Loop 的 task，因此不进入 Session 历史——
 * 否则每次请求都会把改写前后的两份需求都带上。
 */
export class ModelOptimizer implements OptimizerPort {
  readonly #model: ModelPort

  constructor(model: ModelPort) {
    this.#model = model
  }

  async rewrite(input: OptimizeInput): Promise<string> {
    try {
      const reply = await this.#model.run({
        system: SYSTEM,
        messages: [{
          role: 'user',
          text: `REQUEST:\n${input.task}\n\nWORKSPACE:\n${input.workspace}`,
        }],
        tools: [],
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })

      if (reply.kind !== 'message') return input.task
      const text = reply.text.trim()
      return text.length === 0 ? input.task : text
    } catch {
      // 改写失败就退回原需求，不能因为“优化”把任务弄丢。
      return input.task
    }
  }
}

export function optimizerPlugin(): Plugin {
  return {
    name: 'optimizer',
    needs: [ModelKey],
    provides: [OptimizerKey],
    setup(scope) {
      scope.provide(OptimizerKey, new ModelOptimizer(scope.require(ModelKey)))
    },
  }
}
