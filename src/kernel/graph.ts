import type { Plugin } from './plugin.ts'

/**
 * 把插件集合解析成可执行的加载顺序。
 *
 * 与「手写数组」的做法不同，这里由 `provides` / `needs` 自动推导：
 * 提供某能力的插件一定排在需要它的插件之前。三件事同时被检查：
 * - 同一能力被两个插件提供（多实现冲突）；
 * - 需要的能被谁提供都不知道（缺插件）；
 * - 互相需要（环）。
 */
export function resolveOrder(plugins: readonly Plugin[]): Plugin[] {
  const providerOf = new Map<string, Plugin>()
  const byName = new Map<string, Plugin>()

  for (const plugin of plugins) {
    if (plugin.name.trim().length === 0) {
      throw new Error('plugin name must not be blank')
    }
    if (byName.has(plugin.name)) {
      throw new Error(`plugin "${plugin.name}" is declared twice`)
    }
    byName.set(plugin.name, plugin)

    for (const key of plugin.provides) {
      const owner = providerOf.get(key.id)
      if (owner !== undefined) {
        throw new Error(
          `capability "${key.id}" is provided by both "${owner.name}" and "${plugin.name}"`,
        )
      }
      providerOf.set(key.id, plugin)
    }
  }

  // 先做静态检查：缺提供者、自依赖都应在排序之前就报出来。
  for (const plugin of plugins) {
    for (const key of plugin.needs ?? []) {
      const provider = providerOf.get(key.id)
      if (provider === undefined) {
        throw new Error(
          `plugin "${plugin.name}" needs capability "${key.id}" but no loaded plugin provides it`,
        )
      }
      if (provider === plugin) {
        throw new Error(`plugin "${plugin.name}" depends on its own capability "${key.id}"`)
      }
    }
  }

  const state = new Map<Plugin, 'visiting' | 'done'>()
  const stack: Plugin[] = []
  const ordered: Plugin[] = []

  // 依赖优先的后序遍历：先递归解析本插件需要的全部能力提供者，再压入自己。
  const visit = (plugin: Plugin): void => {
    const seen = state.get(plugin)
    if (seen === 'done') return
    if (seen === 'visiting') {
      const from = stack.indexOf(plugin)
      const path = [...stack.slice(from), plugin].map((item) => item.name).join(' -> ')
      throw new Error(`plugin dependency cycle detected: ${path}`)
    }

    state.set(plugin, 'visiting')
    stack.push(plugin)

    for (const key of plugin.needs ?? []) {
      const provider = providerOf.get(key.id)
      if (provider === undefined) continue
      visit(provider)
    }

    stack.pop()
    state.set(plugin, 'done')
    ordered.push(plugin)
  }

  for (const plugin of plugins) {
    visit(plugin)
  }

  return ordered
}
