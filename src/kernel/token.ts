declare const capabilityBrand: unique symbol

/**
 * 一个带类型的“能力键”。
 *
 * 与字符串键相比，`Capability<ModelPort>` 只能被 `model` 这一族实现提供，
 * 拼错名字在编译期就会报错，而不是等到运行时抛 "not registered"。
 */
export interface Capability<T> {
  readonly id: string
  readonly [capabilityBrand]?: T
}

const registry = new Map<string, Capability<unknown>>()

/**
 * 创建（或复用）一个能力键。
 *
 * 同一 id 重复调用返回同一个对象，避免两个模块各自 `capability('model')`
 * 造成「看起来一样、实际不相等」的问题。
 */
export function capability<T>(id: string): Capability<T> {
  const trimmed = id.trim()
  if (trimmed.length === 0) {
    throw new Error('capability id must not be blank')
  }

  const existing = registry.get(trimmed)
  if (existing !== undefined) {
    return existing as Capability<T>
  }

  const created: Capability<T> = { id: trimmed }
  registry.set(trimmed, created as Capability<unknown>)
  return created
}
