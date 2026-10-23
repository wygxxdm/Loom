import { routes } from './routes.ts'

export function match(path: string): string | undefined {
  for (const route of routes) {
    const params = matchPattern(route.pattern, path)
    if (params !== undefined) {
      return route.handler(params)
    }
  }
  return undefined
}

function matchPattern(pattern: string, path: string): Record<string, string> | undefined {
  const expect = pattern.split('/')
  const actual = path.split('/')
  if (expect.length !== actual.length) return undefined

  const params: Record<string, string> = {}
  for (let index = 0; index < expect.length; index += 1) {
    const segment = expect[index] ?? ''
    const value = actual[index] ?? ''

    if (segment.startsWith(':')) {
      params[segment.slice(1)] = value
      continue
    }
    if (segment !== value) return undefined
  }
  return params
}
