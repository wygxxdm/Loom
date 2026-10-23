import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessEvent } from '../src/contracts/events.ts'
import { ScriptedModel, type ScriptedStep } from '../src/plugins/scripted-model.ts'
import { createHarness, type Harness } from '../src/runtime.ts'

function sandbox(): { workspace: string; sessionPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'loom-loop-'))
  const workspace = join(dir, 'ws')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'a.txt'), 'alpha')
  writeFileSync(join(workspace, 'b.txt'), 'beta')
  return { workspace, sessionPath: join(dir, 'session.jsonl') }
}

async function harnessFor(
  steps: readonly ScriptedStep[],
  options: { sessionPath: string; workspace: string; maxCalls?: number; withGuard?: boolean },
): Promise<{ harness: Harness; events: HarnessEvent[] }> {
  const harness = await createHarness({
    workspace: options.workspace,
    model: new ScriptedModel(steps),
    sessionPath: options.sessionPath,
    withGuard: options.withGuard ?? true,
    ...(options.maxCalls === undefined ? {} : { loop: { maxCalls: options.maxCalls } }),
  })

  const events: HarnessEvent[] = []
  harness.events.subscribe((event) => events.push(event))
  return { harness, events }
}

test('一轮工具调用后会话结构正确：user → assistant(calls) → tool', async () => {
  const box = sandbox()
  const { harness } = await harnessFor(
    [{ calls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { text: 'ok' }],
    box,
  )

  const report = await harness.loop.run('读取 a.txt')

  assert.equal(report.calls, 1)
  assert.equal(report.failures, 0)
  assert.equal(report.checkpoint, false)
  assert.equal(report.text, 'ok')

  const entries = harness.session.entries()
  assert.deepEqual(entries.map((entry) => entry.kind), ['user', 'assistant', 'tool', 'assistant'])
  const tool = entries[2]
  assert.equal(tool?.kind === 'tool' && tool.failed, false)
  assert.match(tool?.kind === 'tool' ? tool.output : '', /alpha/)

  await harness.dispose()
})

test('没有 approver 时写操作被拒绝，且以工具结果形式回灌', async () => {
  const box = sandbox()
  const { harness } = await harnessFor(
    [
      { calls: [{ name: 'write_file', args: { path: 'new.txt', content: 'x' } }] },
      { text: '放弃了' },
    ],
    box,
  )

  const report = await harness.loop.run('写一个文件')

  assert.equal(report.failures, 1)
  assert.equal(report.checkpoint, false)
  assert.equal(existsSync(join(box.workspace, 'new.txt')), false)

  const denied = harness.session.entries().find((entry) => entry.kind === 'tool')
  assert.equal(denied?.kind === 'tool' && denied.failed, true)
  assert.match(denied?.kind === 'tool' ? denied.output : '', /permission denied/)

  await harness.dispose()
})

test('批次内多个只读调用按原顺序回填结果', async () => {
  const box = sandbox()
  const { harness } = await harnessFor(
    [{
      calls: [
        { name: 'read_file', args: { path: 'a.txt' } },
        { name: 'read_file', args: { path: 'b.txt' } },
      ],
    }, { text: 'done' }],
    box,
  )

  await harness.loop.run('并发读两个文件')

  const tools = harness.session.entries().filter((entry) => entry.kind === 'tool')
  assert.equal(tools.length, 2)
  assert.match(tools[0]?.kind === 'tool' ? tools[0].output : '', /alpha/)
  assert.match(tools[1]?.kind === 'tool' ? tools[1].output : '', /beta/)

  await harness.dispose()
})

test('工具调用预算耗尽时返回检查点而不是抛异常', async () => {
  const box = sandbox()
  const { harness, events } = await harnessFor(
    [
      { calls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { calls: [{ name: 'read_file', args: { path: 'b.txt' } }] },
      { text: 'never reached' },
    ],
    { ...box, maxCalls: 1 },
  )

  const report = await harness.loop.run('跑两个调用')

  assert.equal(report.checkpoint, true)
  assert.equal(report.text, '')
  assert.equal(report.calls, 1)

  const end = events.at(-1)
  assert.equal(end?.type, 'run.end')
  assert.equal(end?.type === 'run.end' && end.ok, false)

  await harness.dispose()
})

test('续跑不会重复追加用户消息', async () => {
  const box = sandbox()
  const first = await harnessFor(
    [
      { calls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { calls: [{ name: 'read_file', args: { path: 'b.txt' } }] },
    ],
    { ...box, maxCalls: 1 },
  )
  const report = await first.harness.loop.run('一次做两件事')
  assert.equal(report.checkpoint, true)
  await first.harness.dispose()

  const second = await harnessFor([{ text: '继续完成' }], { ...box, maxCalls: 4 })
  const resumed = await second.harness.loop.run('一次做两件事', { resume: true, taskId: 'fixed-task' })

  assert.equal(resumed.checkpoint, false)
  const userEntries = second.harness.session.entries().filter((entry) => entry.kind === 'user')
  assert.equal(userEntries.length, 1)

  await second.harness.dispose()
})

test('同一调用重复三次会触发护栏并注入提示', async () => {
  const box = sandbox()
  const { harness, events } = await harnessFor(
    [
      { calls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { calls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { calls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { text: '换策略了' },
    ],
    box,
  )

  await harness.loop.run('反复读同一个文件')

  const nudges = events.filter((event) => event.type === 'guard.nudge')
  assert.equal(nudges.length, 1)
  assert.ok(harness.session.entries().some((entry) => entry.kind === 'notice'))

  await harness.dispose()
})

test('模型返回空工具调用列表时会重试一次而不是直接失败', async () => {
  const box = sandbox()
  const { harness } = await harnessFor([{ emptyCalls: true }, { text: '恢复正常' }], box)

  const report = await harness.loop.run('格式抖动')

  assert.equal(report.text, '恢复正常')
  assert.ok(harness.session.entries().some((entry) => entry.kind === 'notice'))

  await harness.dispose()
})
