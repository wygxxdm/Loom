export { capability } from './kernel/token.ts'
export type { Capability } from './kernel/token.ts'
export { Container, childScope } from './kernel/container.ts'
export { resolveOrder } from './kernel/graph.ts'
export { scopeFor } from './kernel/plugin.ts'
export type { Plugin, PluginScope } from './kernel/plugin.ts'

export type { ChatMessage, ModelInput, ModelPort, ModelReply, TokenUsage } from './contracts/model.ts'
export { AUTO_ALLOWED } from './contracts/tools.ts'
export type { Tool, ToolCall, ToolRisk, ToolsPort, ToolSpec } from './contracts/tools.ts'
export type { Entry, SessionPort } from './contracts/session.ts'
export type { JournalPort, JournalRecord } from './contracts/journal.ts'
export type { CatalogPort, SessionInfo } from './contracts/catalog.ts'
export { parseProgress, parseSpec } from './contracts/planning.ts'
export type { PlannerPort, PlanPort, PlanTask, TaskProgress, TaskSpec, TaskStatus } from './contracts/planning.ts'
export type { Approver, GrantScope, PermissionPort, PermissionQuery, Verdict } from './contracts/permission.ts'
export type { EventsPort, HarnessEvent } from './contracts/events.ts'
export type { CompactorPort, ContextView, UsageStats } from './contracts/context.ts'
export type { GuardPort, GuardVerdict } from './contracts/guard.ts'
export type { OptimizerPort, OptimizeInput } from './contracts/optimizer.ts'
export { BudgetExceeded } from './contracts/loop.ts'
export type { LoopPort, RunOptions, RunReport } from './contracts/loop.ts'
export {
  CatalogKey,
  CompactorKey,
  EventsKey,
  GuardKey,
  JournalKey,
  LoopKey,
  ModelKey,
  OptimizerKey,
  PermissionKey,
  PlannerKey,
  PlanKey,
  SessionKey,
  ToolsKey,
} from './contracts/keys.ts'

export { createHarness } from './runtime.ts'
export type { Harness, HarnessOptions } from './runtime.ts'

export { agentLoopPlugin, HarnessLoop, LOOP_DEFAULTS } from './plugins/agent-loop.ts'
export { compactorPlugin, COMPACTOR_DEFAULTS, estimateTokens } from './plugins/compactor.ts'
export { DeepSeekModel, deepseekPlugin } from './plugins/deepseek-model.ts'
export { eventsPlugin, MemoryEvents } from './plugins/events.ts'
export { fileTools, fileToolsPlugin } from './plugins/fs-tools.ts'
export { guardPlugin, RepeatGuard, fingerprint } from './plugins/guard.ts'
export { JsonlSession, jsonlSessionPlugin, FORMAT } from './plugins/jsonl-session.ts'
export { MemorySession, memorySessionPlugin } from './plugins/memory-session.ts'
export { planningPlugin, nullPlanningPlugin, PlanStore, ModelPlanner, extractJson } from './plugins/planning.ts'
export { permissionPlugin, GrantStore } from './plugins/permission.ts'
export { optimizerPlugin, ModelOptimizer } from './plugins/prompt-optimizer.ts'
export { FileCatalog, catalogPlugin } from './plugins/session-catalog.ts'
export { ScriptedModel, scriptedPlugin } from './plugins/scripted-model.ts'
export type { ScriptedStep } from './plugins/scripted-model.ts'
export { classifyCommand, scanCommand, shellTool, shellToolPlugin } from './plugins/shell-tool.ts'
export { ToolRegistry, toolsPlugin } from './plugins/tools-registry.ts'
