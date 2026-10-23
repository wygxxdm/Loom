type Dict = Record<string, unknown>

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function merge<T>(base: T, patch: unknown): T {
  if (!isDict(base) || !isDict(patch)) {
    return (patch ?? base) as T
  }
  return { ...base, ...patch } as T
}
