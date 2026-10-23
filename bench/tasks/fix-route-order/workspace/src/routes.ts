export type Handler = (params: Record<string, string>) => string

export interface Route {
  readonly pattern: string
  readonly handler: Handler
}

export const routes: readonly Route[] = [
  { pattern: '/users/:id', handler: (params) => `user:${params.id}` },
  { pattern: '/users/me', handler: () => 'me' },
  { pattern: '/users', handler: () => 'list' },
]
