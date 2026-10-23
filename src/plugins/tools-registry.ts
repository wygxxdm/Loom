import type { Tool, ToolRisk, ToolsPort, ToolSpec } from '../contracts/tools.ts'
import { ToolsKey } from '../contracts/keys.ts'
import type { Plugin } from '../kernel/plugin.ts'

export class ToolRegistry implements ToolsPort {
  readonly #tools = new Map<string, Tool>()

  register(tool: Tool): () => void {
    const name = tool.spec.name.trim()
    if (name.length === 0) {
      throw new Error('tool name must not be blank')
    }
    if (this.#tools.has(name)) {
      throw new Error(`tool "${name}" is already registered`)
    }

    this.#tools.set(name, tool)

    let active = true
    return () => {
      if (!active) return
      active = false
      // 只有当前注册仍指向这个实例时才删除，避免误删后注册的同名工具。
      if (this.#tools.get(name) === tool) {
        this.#tools.delete(name)
      }
    }
  }

  specs(): readonly ToolSpec[] {
    return [...this.#tools.values()].map((tool) => tool.spec)
  }

  riskOf(name: string, args: Record<string, unknown>): ToolRisk {
    const tool = this.#lookup(name)
    return tool.riskOf?.(args) ?? tool.risk
  }

  async invoke(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const tool = this.#lookup(name)
    return tool.run(args, signal)
  }

  #lookup(name: string): Tool {
    const tool = this.#tools.get(name)
    if (tool === undefined) {
      throw new Error(`tool "${name}" is not registered`)
    }
    return tool
  }
}

export function toolsPlugin(): Plugin {
  return {
    name: 'tools',
    provides: [ToolsKey],
    setup(scope) {
      scope.provide(ToolsKey, new ToolRegistry())
    },
  }
}
