import type { Capability } from './token.ts'

export type Cleanup = () => void | Promise<void>

/**
 * 最小能力容器。
 *
 * 三条与常见手写 DI 不同的约束：
 * 1. `provide` 自带注销：注册即登记清理函数，插件不可能“忘了 dispose”造成泄漏；
 * 2. 清理按 LIFO 执行，且单个清理失败不阻塞其余；
 * 3. 支持父子作用域，子作用域解析失败时向父级回溯。
 */
export class Container {
  readonly #values = new Map<string, unknown>()
  readonly #cleanups: Cleanup[] = []
  readonly #parent: Container | undefined

  constructor(parent?: Container) {
    this.#parent = parent
  }

  get parent(): Container | undefined {
    return this.#parent
  }

  /**
   * 注册一个能力。
   *
   * 同一作用域内重复注册直接失败——不允许静默覆盖，否则后加载的插件
   * 会在不声不响中替换掉前一个插件的实现，实验分组就失真了。
   */
  provide<T>(key: Capability<T>, value: T): void {
    if (this.#values.has(key.id)) {
      throw new Error(`capability "${key.id}" is already provided in this scope`)
    }

    this.#values.set(key.id, value)
    this.#cleanups.push(() => {
      this.#values.delete(key.id)
    })
  }

  require<T>(key: Capability<T>): T {
    if (this.#values.has(key.id)) {
      return this.#values.get(key.id) as T
    }

    if (this.#parent !== undefined) {
      return this.#parent.require(key)
    }

    throw new Error(`capability "${key.id}" is not available`)
  }

  has(key: Capability<unknown>): boolean {
    return this.#values.has(key.id) || (this.#parent?.has(key) ?? false)
  }

  owns(key: Capability<unknown>): boolean {
    return this.#values.has(key.id)
  }

  onDispose(cleanup: Cleanup): void {
    this.#cleanups.push(cleanup)
  }

  /** 逆序释放，全部尝试执行，最后抛出第一个错误。 */
  async dispose(): Promise<void> {
    let firstError: unknown
    let failed = false

    while (this.#cleanups.length > 0) {
      const cleanup = this.#cleanups.pop()
      if (cleanup === undefined) break

      try {
        await cleanup()
      } catch (error: unknown) {
        if (!failed) {
          failed = true
          firstError = error
        }
      }
    }

    this.#values.clear()

    if (failed) {
      throw firstError
    }
  }
}

/**
 * 派生一个子作用域。
 *
 * 子作用域可以覆盖父级能力，也可以注册只在本作用域可见的能力。
 * 这解决“多个 Agent Run 共享同一容器导致状态串号”的问题。
 */
export function childScope(parent: Container): Container {
  return new Container(parent)
}
