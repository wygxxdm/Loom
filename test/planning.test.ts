import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseProgress, parseSpec } from '../src/contracts/planning.ts'
import { JsonlSession } from '../src/plugins/jsonl-session.ts'
import { PlanStore, extractJson } from '../src/plugins/planning.ts'
import { createHarness } from '../src/runtime.ts'
import { ScriptedModel } from '../src/plugins/scripted-model.ts'

const spec = {
  goal: '修复空输入导致的崩溃',
  deliverables: ['src/parse.ts 在空串下返回空数组'],
  tasks: [
    { id: 't1', objective: '定位崩溃点' },
    { id: 't2', objective: '补测试并修复' },
  ],
  constraints: ['不改公开 API'],
  acceptance: ['spec 全绿'],
  outOfScope: ['不要重构整个模块'],
}

test('规格解析拒绝空目标', () => {
  assert.throws(() => parseSpec({ goal: '   ' }), /non-empty goal/)
  assert.throws(() => parseSpec(null), /must be an object/)
})

test('规格解析为缺失字段补默认值', () => {
  const parsed = parseSpec({ goal: '做一件事' })
  assert.deepEqual(parsed.tasks, [])
  assert.deepEqual(parsed.acceptance, [])
})

test('进度解析校验状态枚举', () => {
  assert.deepEqual(parseProgress({ taskId: 't1', status: 'done' }), { taskId: 't1', status: 'done', note: '' })
  assert.throws(() => parseProgress({ taskId: 't1', status: 'finished' }), /invalid task status/)
  assert.throws(() => parseProgress({ status: 'done' }), /requires a taskId/)
})

test('从带围栏的模型输出里取出 JSON', () => {
  const text = '```json\n{"goal":"x","tasks":[]}\n```'
  assert.deepEqual(extractJson(text), { goal: 'x', tasks: [] })
  assert.throws(() => extractJson('no json here'), /no JSON object/)
})

test('规划写入 journal，恢复会话后规格与进度仍在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-plan-'))
  const path = join(dir, 'plan.jsonl')

  const first = new JsonlSession(path, 'plan', dir)
  const store = new PlanStore(first)
  store.save(parseSpec(spec))
  store.update({ taskId: 't1', status: 'done', note: '在 parse.ts:12' })

  const reopened = new JsonlSession(path, 'plan', dir)
  const restored = new PlanStore(reopened)

  assert.equal(restored.current()?.goal, spec.goal)
  assert.equal(restored.progress().length, 1)
  assert.equal(restored.progress()[0]?.status, 'done')

  const rendered = restored.render() ?? ''
  assert.match(rendered, /\[TASK SPEC\]/)
  assert.match(rendered, /\[t1\] 定位崩溃点 \(done: 在 parse\.ts:12\)/)
  assert.match(rendered, /do not touch: 不要重构整个模块/)
})

test('重新规划会清空旧进度', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-plan-'))
  const session = new JsonlSession(join(dir, 'p.jsonl'), 'p', dir)
  const store = new PlanStore(session)

  store.save(parseSpec(spec))
  store.update({ taskId: 't1', status: 'done', note: '' })
  assert.equal(store.progress().length, 1)

  store.save(parseSpec({ ...spec, goal: '换一个目标' }))
  assert.equal(store.progress().length, 0)
})

test('journal 行以独立类型落盘，不影响消息序号', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-plan-'))
  const path = join(dir, 'mix.jsonl')
  const session = new JsonlSession(path, 'mix', dir)

  session.append([{ kind: 'user', text: 'go' }])
  new PlanStore(session).save(parseSpec(spec))
  session.append([{ kind: 'assistant', text: 'done', calls: [] }])

  const lines = readFileSync(path, 'utf8').trim().split('\n')
  const rows = lines.slice(1).map((line) => JSON.parse(line) as { type: string; seq?: number })

  assert.deepEqual(rows.map((row) => row.type), ['entry', 'journal', 'entry'])
  assert.deepEqual(rows.filter((row) => row.type === 'entry').map((row) => row.seq), [1, 2])
})

test('任务规格会注入 system prompt，并随 update_task 更新', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-plan-'))
  const systems: (string | undefined)[] = []

  const model = {
    async run(input: { system?: string }) {
      systems.push(input.system)
      return { kind: 'message' as const, text: 'ok' }
    },
  }

  const harness = await createHarness({
    workspace: dir,
    model,
    sessionPath: join(dir, 'inject.jsonl'),
    sessionId: 'inject',
  })

  harness.plan.save(parseSpec(spec))
  await harness.loop.run('做点什么')

  assert.match(systems[0] ?? '', /\[TASK SPEC\]/)
  assert.match(systems[0] ?? '', /acceptance: spec 全绿/)
  assert.match(systems[0] ?? '', /do not touch: 不要重构整个模块/)

  await harness.dispose()
})

test('update_task 是 agent-state 级工具，无需授权即可写入进度', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-plan-'))

  const harness = await createHarness({
    workspace: dir,
    model: new ScriptedModel([
      { calls: [{ name: 'update_task', args: { taskId: 't1', status: 'done', note: '改完了' } }] },
      { text: 'done' },
    ]),
    sessionPath: join(dir, 'tool.jsonl'),
    sessionId: 'tool',
  })

  harness.plan.save(parseSpec(spec))
  const report = await harness.loop.run('推进一下')

  assert.equal(report.failures, 0)
  assert.equal(harness.plan.progress()[0]?.status, 'done')
  assert.equal(harness.plan.progress()[0]?.note, '改完了')

  await harness.dispose()
})
