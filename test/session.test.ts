import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlSession } from '../src/plugins/jsonl-session.ts'

const header = (id: string) => JSON.stringify({
  type: 'loom.session',
  format: 1,
  id,
  cwd: '/tmp',
  createdAt: 1,
})

const row = (seq: number, entry: unknown) => JSON.stringify({ type: 'entry', seq, at: 1, entry })

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'loom-session-')), `${name}.jsonl`)
}

test('写入后可重新载入，顺序与内容保持一致', () => {
  const path = tempFile('ok')
  const session = new JsonlSession(path, 'ok', '/tmp')

  session.append([{ kind: 'user', text: 'hello' }])
  session.append([
    { kind: 'assistant', text: '', calls: [{ id: 'c1', name: 'read_file', args: { path: 'a' } }] },
    { kind: 'tool', callId: 'c1', name: 'read_file', output: 'body', failed: false },
  ])

  const reopened = new JsonlSession(path, 'ok', '/tmp')
  const entries = reopened.entries()

  assert.equal(entries.length, 3)
  assert.equal(entries[0]?.kind, 'user')
  assert.equal(entries[1]?.kind, 'assistant')
  assert.equal(entries[2]?.kind, 'tool')
})

test('载入时补齐孤儿工具调用，且重复载入不会重复补齐', () => {
  const path = tempFile('orphan')
  writeFileSync(path, [
    header('orphan'),
    row(1, { kind: 'user', text: 'go' }),
    row(2, { kind: 'assistant', text: '', calls: [{ id: 'c1', name: 'run_command', args: {} }] }),
    '',
  ].join('\n'))

  const first = new JsonlSession(path, 'orphan', '/tmp')
  const entries = first.entries()

  assert.equal(entries.length, 3)
  const patched = entries[2]
  assert.equal(patched?.kind, 'tool')
  assert.equal(patched?.kind === 'tool' && patched.failed, true)
  assert.match(patched?.kind === 'tool' ? patched.output : '', /interrupted/)

  const second = new JsonlSession(path, 'orphan', '/tmp')
  assert.equal(second.entries().length, 3)
})

test('只截断没有换行收尾的半行', () => {
  const path = tempFile('half')
  writeFileSync(path, `${header('half')}\n${row(1, { kind: 'user', text: 'kept' })}\n{"type":"entry","seq":2`)

  const session = new JsonlSession(path, 'half', '/tmp')
  assert.equal(session.entries().length, 1)

  const raw = readFileSync(path, 'utf8')
  assert.ok(raw.endsWith('\n'))
  assert.ok(!raw.includes('"seq":2'))
})

test('已提交的坏行必须报错，不能静默跳过', () => {
  const path = tempFile('broken')
  writeFileSync(path, `${header('broken')}\n${row(1, { kind: 'user', text: 'kept' })}\n{"nonsense":true}\n`)

  assert.throws(() => new JsonlSession(path, 'broken', '/tmp'), /unknown row type/)
})

test('序号不连续时报错', () => {
  const path = tempFile('seq')
  writeFileSync(path, [
    header('seq'),
    row(1, { kind: 'user', text: 'a' }),
    row(3, { kind: 'user', text: 'b' }),
    '',
  ].join('\n'))

  assert.throws(() => new JsonlSession(path, 'seq', '/tmp'), /expected seq 2/)
})
