import { capability } from '../kernel/token.ts'
import type { CatalogPort } from './catalog.ts'
import type { CompactorPort } from './context.ts'
import type { EventsPort } from './events.ts'
import type { GuardPort } from './guard.ts'
import type { JournalPort } from './journal.ts'
import type { LoopPort } from './loop.ts'
import type { ModelPort } from './model.ts'
import type { OptimizerPort } from './optimizer.ts'
import type { PermissionPort } from './permission.ts'
import type { PlannerPort, PlanPort } from './planning.ts'
import type { SessionPort } from './session.ts'
import type { ToolsPort } from './tools.ts'

/**
 * 全部能力键的唯一登记处。
 *
 * 集中声明的好处：想换一个实现，搜索这个文件就能看到所有可替换点；
 * 也避免两个插件各自 `capability('model')` 造成的隐式耦合。
 */
export const ModelKey = capability<ModelPort>('loom.model')
export const ToolsKey = capability<ToolsPort>('loom.tools')
export const SessionKey = capability<SessionPort>('loom.session')
export const JournalKey = capability<JournalPort>('loom.journal')
export const CatalogKey = capability<CatalogPort>('loom.catalog')
export const PlanKey = capability<PlanPort>('loom.plan')
export const PlannerKey = capability<PlannerPort>('loom.planner')
export const PermissionKey = capability<PermissionPort>('loom.permission')
export const EventsKey = capability<EventsPort>('loom.events')
export const CompactorKey = capability<CompactorPort>('loom.compactor')
export const GuardKey = capability<GuardPort>('loom.guard')
export const OptimizerKey = capability<OptimizerPort>('loom.optimizer')
export const LoopKey = capability<LoopPort>('loom.loop')
