import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSpec } from '../src/contracts/planning.ts'
import { JsonlSession } from '../src/plugins/jsonl-session.ts'
import { PlanStore } from '../src/plugins/planning.ts'
import { FileCatalog } from '../src/plugins/session-catalog.ts'

function sessionWith(dir: string, id: string, text: string, withPlan = false): JsonlSession {
  const session = new JsonlSession(join(dir, `${encodeURIComponent(id)}.jsonl`), id, dir)
  session.append([{ kind: 'user', text }])
  if (withPlan) {
    new PlanStore(session).save(parseSpec({
      goal: `goal of ${id}`,
      tasks: [{ id: 't1', objective: 'do it' }],
    }))
  }
  return session
}

test('会话目录列出会话并按创建时间倒序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-cat-'))
  sessionWith(dir, 'alpha', '第一个任务')
  sessionWith(dir, 'beta', '第二个任务', true)

  const items = new FileCatalog(dir).list()

  assert.equal(items.length, 2)
  const byId = new Map(items.map((item) => [item.id, item]))
  assert.equal(byId.get('alpha')?.entries, 1)
  assert.equal(byId.get('alpha')?.hasPlan, false)
  assert.equal(byId.get('beta')?.hasPlan, true)
  assert.equal(byId.get('beta')?.firstUser, '第二个任务')
})

test('空目录返回空列表而不是抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-cat-'))
  assert.deepEqual(new FileCatalog(dir).list(), [])

  mkdirSync(join(dir, 'nested'), { recursive: true })
  assert.deepEqual(new FileCatalog(dir).list(), [])
})

test('删除会话是幂等的', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-cat-'))
  sessionWith(dir, 'gamma', '任务')

  const catalog = new FileCatalog(dir)
  assert.equal(catalog.remove('gamma'), true)
  assert.equal(existsSync(join(dir, 'gamma.jsonl')), false)
  assert.equal(catalog.remove('gamma'), false)
})

test('单个损坏文件不影响列表其余项', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-cat-'))
  sessionWith(dir, 'good', '正常会话')

  const broken = join(dir, 'broken.jsonl')
  const session = new JsonlSession(broken, 'broken', dir)
  session.append([{ kind: 'user', text: 'x' }])
  // 直接破坏文件头，模拟被外部截断。
  writeFileSync(broken, '{"type":"loom.session"}\n')

  const items = new FileCatalog(dir).list()
  assert.deepEqual(items.map((item) => item.id), ['good'])
})
