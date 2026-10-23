export interface SplitTarget {
  readonly path: string
  readonly query: string
}

export function splitPath(target: string): SplitTarget {
  const index = target.indexOf('?')
  if (index < 0) {
    return { path: target, query: '' }
  }
  return { path: target.slice(0, index), query: target.slice(index + 1) }
}
