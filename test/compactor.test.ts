import test from 'node:test'
import assert from 'node:assert/strict'
import { Compactor, COMPACTOR_DEFAULTS, alignment, estimateTokens } from '../src/plugins/compactor.ts'
import type { Entry, SessionPort } from '../src/contracts/session.ts'
import type { ModelPort, ModelReply } from '../src/contracts/model.ts'
import type { ToolsPort } from '../src/contracts/tools.ts'

class FakeSession implements SessionPort {
  readonly list: Entry[] = []

  append(entries: readonly Entry[]): void {
    this.list.push(...entries)
  }

  entries(): readonly Entry[] {
    return this.list
  }

  flush(): void {}
}

const tools: ToolsPort = {
  register: () => () => {},
  specs: () => [],
  riskOf: () => 'read-only',
  invoke: async () => '',
}

const okModel: ModelPort = {
  async run(): Promise<ModelReply> {
    return { kind: 'message', text: 'SUMMARY-OF-HISTORY' }
  },
}

const brokenModel: ModelPort = {
  async run(): Promise<ModelReply> {
    throw new Error('summary backend down')
  },
}

function seed(session: FakeSession, pairs: number): void {
  session.append([{ kind: 'user', text: 'x'.repeat(300) }])
  for (let index = 0; index < pairs; index += 1) {
    session.append([
      { kind: 'assistant', text: '', calls: [{ id: `c${index}`, name: 'read_file', args: { path: `${index}.ts` } }] },
      { kind: 'tool', callId: `c${index}`, name: 'read_file', output: 'y'.repeat(300), failed: false },
    ])
  }
}

test('窗口对齐不会把 tool 消息与其调用切开', () => {
  const entries: Entry[] = [
    { kind: 'user', text: 'go' },
    { kind: 'assistant', text: '', calls: [{ id: 'c1', name: 'read_file', args: {} }] },
    { kind: 'tool', callId: 'c1', name: 'read_file', output: 'a', failed: false },
    { kind: 'tool', callId: 'c1', name: 'read_file', output: 'b', failed: false },
  ]

  // 无论保留几条，窗口起点都必须落在 assistant 上，而不是落在 tool 上。
  for (const keep of [0, 1, 2, 3]) {
    const start = alignment(entries, keep)
    assert.notEqual(entries[start]?.kind, 'tool')
  }
  assert.equal(alignment(entries, 1), 1)
})

test('未超过阈值时不压缩', async () => {
  const session = new FakeSession()
  seed(session, 1)

  const compactor = new Compactor(session, tools, okModel, undefined, { ...COMPACTOR_DEFAULTS, maxTokens: 100_000 })
  const view = await compactor.build({ system: 'sys' })

  assert.equal(view.compacted, false)
  assert.equal(view.system, 'sys')
  assert.equal(compactor.stats()?.entriesSent, session.entries().length)
})

test('超过阈值时压缩并注入摘要', async () => {
  const session = new FakeSession()
  seed(session, 4)

  const compactor = new Compactor(session, tools, okModel, undefined, {
    ...COMPACTOR_DEFAULTS,
    maxTokens: 400,
    threshold: 0.5,
    keepRecent: 2,
  })
  const view = await compactor.build({ system: 'sys' })

  assert.equal(view.compacted, true)
  assert.match(view.system ?? '', /SUMMARY-OF-HISTORY/)
  assert.ok(view.messages.length < session.entries().length)
})

test('摘要失败时降级为只裁剪，不中断调用', async () => {
  const session = new FakeSession()
  seed(session, 4)

  const compactor = new Compactor(session, tools, brokenModel, undefined, {
    ...COMPACTOR_DEFAULTS,
    maxTokens: 400,
    threshold: 0.5,
    keepRecent: 2,
  })
  const view = await compactor.build({ system: 'sys' })

  assert.equal(view.compacted, true)
  assert.equal(view.system, 'sys')
  assert.ok(view.messages.length > 0)
})

test('用真实用量校准估算系数', async () => {
  const session = new FakeSession()
  seed(session, 1)
  session.append([{ kind: 'user', text: 'z'.repeat(4_000) }])

  const compactor = new Compactor(session, tools, undefined, undefined, { ...COMPACTOR_DEFAULTS, maxTokens: 100_000 })
  await compactor.build({})
  const first = compactor.stats()?.estTokens ?? 0
  assert.ok(first > 500, `fixture too small: ${first}`)

  compactor.observe(first * 2)
  await compactor.build({})

  const scale = compactor.stats()?.scale ?? 1
  assert.ok(scale > 1.2, `expected scale to grow, got ${scale}`)
})

test('估算器：中文按字计、英文按四字符计', () => {
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens('你好'), 2)
})

test('手动压缩不看阈值，且摘要只生成一次', async () => {
  const session = new FakeSession()
  seed(session, 4)

  let calls = 0
  const counting: ModelPort = {
    async run(): Promise<ModelReply> {
      calls += 1
      return { kind: 'message', text: 'SUMMARY' }
    },
  }

  const compactor = new Compactor(session, tools, counting, undefined, {
    ...COMPACTOR_DEFAULTS,
    maxTokens: 100_000,
    keepRecent: 2,
  })

  await compactor.build({ system: 'sys' })
  const first = await compactor.compact()

  assert.equal(first.compacted, true)
  assert.ok(first.entriesSent < first.entriesTotal)
  assert.equal(calls, 1)

  // 没有新消息移出窗口，第二次不应再调用模型。
  await compactor.compact()
  assert.equal(calls, 1)
})

test('空会话手动压缩不报错', async () => {
  const session = new FakeSession()
  const compactor = new Compactor(session, tools, okModel, undefined, COMPACTOR_DEFAULTS)

  const stats = await compactor.compact()
  assert.equal(stats.entriesTotal, 0)
})
