import type { Cleanup, Container } from './container.ts'
import type { Capability } from './token.ts'

/**
 * 插件在 setup 期间能看到的唯一接口。
 *
 * 刻意不暴露容器本身：插件不能遍历、不能探测、不能拿到别人的实例，
 * 只能按声明的能力键申请。这保证依赖关系始终显式可见。
 */
export interface PluginScope {
  require<T>(key: Capability<T>): T
  /** 可选依赖：不存在时返回 undefined，用于“装了就用、没装就退化”的插件。 */
  optional<T>(key: Capability<T>): T | undefined
  provide<T>(key: Capability<T>, value: T): void
  onDispose(cleanup: Cleanup): void
}

export interface Plugin {
  readonly name: string
  /** 需要哪些能力；装配器据此做拓扑排序，而不是靠人肉顺序。 */
  readonly needs?: readonly Capability<unknown>[]
  /** 提供哪些能力；同时用于重复提供检测。 */
  readonly provides: readonly Capability<unknown>[]
  setup(scope: PluginScope): void
}

export function scopeFor(container: Container, pluginName: string): PluginScope {
  return {
    require<T>(key: Capability<T>): T {
      try {
        return container.require(key)
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`plugin "${pluginName}" failed to resolve: ${reason}`)
      }
    },
    provide<T>(key: Capability<T>, value: T): void {
      container.provide(key, value)
    },
    optional<T>(key: Capability<T>): T | undefined {
      return container.has(key) ? container.require(key) : undefined
    },
    onDispose(cleanup: Cleanup): void {
      container.onDispose(cleanup)
    },
  }
}
