import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileTools } from '../src/plugins/fs-tools.ts'
import { MemorySession } from '../src/plugins/memory-session.ts'
import { createHarness } from '../src/runtime.ts'
import { ScriptedModel } from '../src/plugins/scripted-model.ts'

function sandbox(): { root: string; remove: ReturnType<typeof fileTools>[number] } {
  const root = mkdtempSync(join(tmpdir(), 'loom-del-'))
  const remove = fileTools(root).find((tool) => tool.spec.name === 'delete_file')
  assert.ok(remove !== undefined)
  return { root, remove }
}

test('软删除把文件移进 .loom/trash，内容保留', async () => {
  const { root, remove } = sandbox()
  writeFileSync(join(root, 'old.ts'), 'export const x = 1\n')

  const output = await remove.run({ path: 'old.ts' })

  assert.match(output, /soft delete/)
  assert.match(output, /\.loom\/trash\//)
  assert.equal(existsSync(join(root, 'old.ts')), false)

  const trashed = output.match(/→ (\.loom\/trash\/\S+)/)?.[1]
  assert.ok(trashed !== undefined)
  assert.equal(readFileSync(join(root, trashed), 'utf8'), 'export const x = 1\n')
})

test('拒绝删除目录', async () => {
  const { root, remove } = sandbox()
  mkdirSync(join(root, 'dist'))

  await assert.rejects(async () => await remove.run({ path: 'dist' }), /only removes files/)
})

test('拒绝删除符号链接', async () => {
  const { root, remove } = sandbox()
  writeFileSync(join(root, 'real.ts'), 'x')
  symlinkSync(join(root, 'real.ts'), join(root, 'link.ts'))

  await assert.rejects(async () => await remove.run({ path: 'link.ts' }), /symlink/)
  assert.equal(existsSync(join(root, 'real.ts')), true)
})

test('拒绝删除 .loom 内部与不存在的文件', async () => {
  const { root, remove } = sandbox()
  mkdirSync(join(root, '.loom', 'trash'), { recursive: true })
  writeFileSync(join(root, '.loom', 'trash', 'kept.ts'), 'x')

  await assert.rejects(async () => await remove.run({ path: '.loom/trash/kept.ts' }), /inside \.loom/)
  await assert.rejects(async () => await remove.run({ path: 'nope.ts' }), /does not exist/)
})

test('内存会话与 JSONL 版行为一致，且不与调用方共享引用', () => {
  const session = new MemorySession('mem', '/tmp')
  const entry = { kind: 'user' as const, text: 'hi' }

  session.append([entry])
  entry.text = 'tampered'

  assert.equal(session.entries()[0]?.kind === 'user' && session.entries()[0].text, 'hi')

  session.appendRecord({ kind: 'progress', at: 1, progress: { taskId: 't1', status: 'done', note: '' } })
  assert.equal(session.records().length, 1)
})

test('内存模式下不产生会话文件，但历史与规划仍在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-mem-'))
  const sessionPath = join(dir, 'should-not-exist.jsonl')

  const harness = await createHarness({
    workspace: dir,
    model: new ScriptedModel([{ text: 'ok' }]),
    sessionId: 'mem',
    sessionPath,
    sessionStore: 'memory',
  })

  harness.plan.save({
    goal: '验证内存会话',
    deliverables: [],
    tasks: [{ id: 't1', objective: '跑一次' }],
    constraints: [],
    acceptance: [],
    outOfScope: [],
  })

  await harness.loop.run('随便跑一下')

  assert.equal(existsSync(sessionPath), false)
  assert.equal(harness.sessionPath, ':memory:')
  assert.equal(harness.session.entries().length, 2)
  assert.equal(harness.plan.current()?.goal, '验证内存会话')

  await harness.dispose()
})
