/** 会话目录里的一项。用于 `/sessions` 列表与恢复。 */
export interface SessionInfo {
  readonly id: string
  readonly path: string
  readonly createdAt: number
  readonly entries: number
  readonly hasPlan: boolean
  readonly firstUser?: string
}

export interface CatalogPort {
  /** 按创建时间倒序列出会话；读不出来的文件跳过而不是整体失败。 */
  list(): readonly SessionInfo[]
  /** 删除指定会话；不存在返回 false。 */
  remove(id: string): boolean
  pathOf(id: string): string
}
