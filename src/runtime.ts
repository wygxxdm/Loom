import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Container } from './kernel/container.ts'
import { resolveOrder } from './kernel/graph.ts'
import { scopeFor } from './kernel/plugin.ts'
import type { Plugin } from './kernel/plugin.ts'
import type { CatalogPort } from './contracts/catalog.ts'
import type { CompactorPort } from './contracts/context.ts'
import type { EventsPort } from './contracts/events.ts'
import type { LoopPort } from './contracts/loop.ts'
import type { ModelPort } from './contracts/model.ts'
import type { OptimizerPort } from './contracts/optimizer.ts'
import type { Approver } from './contracts/permission.ts'
import type { PlannerPort, PlanPort } from './contracts/planning.ts'
import type { SessionPort } from './contracts/session.ts'
import {
  CatalogKey,
  CompactorKey,
  EventsKey,
  LoopKey,
  ModelKey,
  OptimizerKey,
  PlannerKey,
  PlanKey,
  SessionKey,
} from './contracts/keys.ts'
import { agentLoopPlugin, type LoopConfig } from './plugins/agent-loop.ts'
import { catalogPlugin } from './plugins/session-catalog.ts'
import { compactorPlugin, type CompactorOptions } from './plugins/compactor.ts'
import { eventsPlugin } from './plugins/events.ts'
import { fileToolsPlugin } from './plugins/fs-tools.ts'
import { guardPlugin } from './plugins/guard.ts'
import { jsonlSessionPlugin } from './plugins/jsonl-session.ts'
import { memorySessionPlugin } from './plugins/memory-session.ts'
import { permissionPlugin } from './plugins/permission.ts'
import { nullPlanningPlugin, planningPlugin } from './plugins/planning.ts'
import { optimizerPlugin } from './plugins/prompt-optimizer.ts'
import { shellToolPlugin } from './plugins/shell-tool.ts'
import { toolsPlugin } from './plugins/tools-registry.ts'

export interface HarnessOptions {
  readonly workspace: string
  readonly model: ModelPort
  /** 会话 id；与 sessionDir 一起决定文件路径。 */
  readonly sessionId?: string
  readonly sessionDir?: string
  readonly sessionPath?: string
  /** `file` 落 JSONL；`memory` 只留进程内，用 `--ephemeral` 时选它。 */
  readonly sessionStore?: 'file' | 'memory'
  readonly approver?: Approver
  readonly loop?: Partial<LoopConfig>
  readonly compactor?: Partial<CompactorOptions>
  readonly withShell?: boolean
  readonly withGuard?: boolean
  readonly withOptimizer?: boolean
  readonly withPlanning?: boolean
}

export interface Harness {
  readonly loop: LoopPort
  readonly session: SessionPort
  readonly events: EventsPort
  readonly compactor: CompactorPort
  readonly plan: PlanPort
  readonly planner: PlannerPort | undefined
  readonly optimizer: OptimizerPort | undefined
  readonly catalog: CatalogPort
  readonly order: readonly string[]
  readonly sessionPath: string
  readonly sessionId: string
  dispose(): Promise<void>
}

function modelPlugin(model: ModelPort): Plugin {
  return {
    name: 'model',
    provides: [ModelKey],
    setup(scope) {
      scope.provide(ModelKey, model)
    },
  }
}

/**
 * 组装 Harness。
 *
 * 这里没有任何“加载顺序”数组：顺序由插件声明的 needs/provides
 * 推导出来。想关掉某个机制，从 plugins 数组里删一个就行。
 */
export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const workspace = resolve(options.workspace)
  const sessionId = options.sessionId ?? 'default'
  const sessionDir = resolve(
    options.sessionDir ?? process.env.LOOM_SESSION_DIR ?? join(homedir(), '.loom', 'sessions'),
  )
  const sessionPath = options.sessionPath ?? join(sessionDir, `${encodeURIComponent(sessionId)}.jsonl`)

  const plugins: Plugin[] = [
    eventsPlugin(),
    options.sessionStore === 'memory'
      ? memorySessionPlugin(sessionId, workspace)
      : jsonlSessionPlugin(sessionPath, sessionId, workspace),
    catalogPlugin(options.sessionDir === undefined ? sessionDir : resolve(options.sessionDir)),
    toolsPlugin(),
    fileToolsPlugin(workspace),
    ...(options.withShell === false ? [] : [shellToolPlugin({ root: workspace })]),
    permissionPlugin(options.approver),
    ...(options.withGuard === false ? [] : [guardPlugin()]),
    modelPlugin(options.model),
    ...(options.withOptimizer === false ? [] : [optimizerPlugin()]),
    options.withPlanning === false ? nullPlanningPlugin() : planningPlugin(),
    compactorPlugin(options.compactor),
    agentLoopPlugin(options.loop),
  ]

  const order = resolveOrder(plugins)
  const container = new Container()

  try {
    for (const plugin of order) {
      plugin.setup(scopeFor(container, plugin.name))
    }
  } catch (error: unknown) {
    await container.dispose()
    throw error
  }

  return {
    loop: container.require(LoopKey),
    session: container.require(SessionKey),
    events: container.require(EventsKey),
    compactor: container.require(CompactorKey),
    plan: container.require(PlanKey),
    planner: container.has(PlannerKey) ? container.require(PlannerKey) : undefined,
    optimizer: container.has(OptimizerKey) ? container.require(OptimizerKey) : undefined,
    catalog: container.require(CatalogKey),
    order: order.map((plugin) => plugin.name),
    sessionPath: options.sessionStore === 'memory' ? ':memory:' : sessionPath,
    sessionId,
    dispose: () => container.dispose(),
  }
}
