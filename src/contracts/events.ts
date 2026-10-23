/**
 * 结构化运行时事件。
 *
 * 设计原则：只记录「可度量的事实」，不记录提示词与工具输出原文，
 * 避免日志泄露代码与密钥。token 用量属于可度量事实，因此显式带出——
 * 这是实验里唯一可信的成本来源。
 */
export type HarnessEvent =
  | { readonly type: 'run.start'; readonly at: number; readonly runId: string; readonly taskChars: number; readonly resume: boolean }
  | { readonly type: 'round.start'; readonly at: number; readonly runId: string; readonly round: number; readonly messages: number; readonly tools: number; readonly estTokens: number }
  | { readonly type: 'model.reply'; readonly at: number; readonly runId: string; readonly round: number; readonly kind: 'message' | 'calls'; readonly calls: number; readonly ms: number; readonly promptTokens?: number; readonly completionTokens?: number }
  | { readonly type: 'tool.start'; readonly at: number; readonly runId: string; readonly callId: string; readonly tool: string; readonly risk: string }
  | { readonly type: 'tool.end'; readonly at: number; readonly runId: string; readonly callId: string; readonly tool: string; readonly ok: boolean; readonly ms: number; readonly chars: number }
  | { readonly type: 'context.compacted'; readonly at: number; readonly runId: string; readonly entriesBefore: number; readonly entriesSent: number; readonly summarized: boolean }
  | { readonly type: 'guard.nudge'; readonly at: number; readonly runId: string; readonly tool: string; readonly repeats: number }
  | { readonly type: 'run.end'; readonly at: number; readonly runId: string; readonly ok: boolean; readonly rounds: number; readonly calls: number; readonly failures: number; readonly ms: number; readonly error?: string }

export type EventSink = (event: HarnessEvent) => void

export interface EventsPort {
  emit(event: HarnessEvent): void
  subscribe(sink: EventSink): () => void
}
