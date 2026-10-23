interface Slot<V> {
  readonly value: V
  readonly expiresAt: number
}

export class TtlCache<K, V> {
  readonly #ttlMs: number
  readonly #clock: () => number
  readonly #slots = new Map<K, Slot<V>>()

  constructor(ttlMs: number, clock: () => number = Date.now) {
    this.#ttlMs = ttlMs
    this.#clock = clock
  }

  set(key: K, value: V): void {
    this.#slots.set(key, { value, expiresAt: this.#clock() + this.#ttlMs })
  }

  get(key: K): V | undefined {
    const slot = this.#slots.get(key)
    if (slot === undefined) return undefined
    return slot.value
  }

  size(): number {
    return this.#slots.size
  }
}
