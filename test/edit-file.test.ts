import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileTools } from '../src/plugins/fs-tools.ts'

function sandbox(content: string): { root: string; edit: ReturnType<typeof fileTools>[number] } {
  const root = mkdtempSync(join(tmpdir(), 'loom-edit-'))
  writeFileSync(join(root, 'a.ts'), content)
  const tools = fileTools(root)
  const edit = tools.find((tool) => tool.spec.name === 'edit_file')
  assert.ok(edit !== undefined)
  return { root, edit }
}

test('替换唯一片段并回报行号', async () => {
  const { root, edit } = sandbox('line1\nconst a = 1\nline3\n')

  const output = await edit.run({ path: 'a.ts', old: 'const a = 1', new: 'const a = 2' })

  assert.match(output, /a\.ts at line 2/)
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'line1\nconst a = 2\nline3\n')
})

test('片段不存在时报错且不改文件', async () => {
  const { root, edit } = sandbox('const a = 1\n')

  await assert.rejects(
    async () => await edit.run({ path: 'a.ts', old: 'const b = 9', new: 'x' }),
    /snippet not found/,
  )
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'const a = 1\n')
})

test('片段出现多次时拒绝猜测，除非 replaceAll', async () => {
  const { root, edit } = sandbox('const a = 1\nconst a = 1\n')

  await assert.rejects(
    async () => await edit.run({ path: 'a.ts', old: 'const a = 1', new: 'const a = 2' }),
    /appears 2 times/,
  )
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'const a = 1\nconst a = 1\n')

  const output = await edit.run({ path: 'a.ts', old: 'const a = 1', new: 'const a = 2', replaceAll: true })
  assert.match(output, /2 occurrences/)
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'const a = 2\nconst a = 2\n')
})

test('文件不存在时提示改用 write_file', async () => {
  const { edit } = sandbox('x')

  await assert.rejects(
    async () => await edit.run({ path: 'missing.ts', old: 'a', new: 'b' }),
    /file does not exist/,
  )
})

test('空 old 被拒绝，避免变成整文件重写', async () => {
  const { edit } = sandbox('abc')
  await assert.rejects(async () => await edit.run({ path: 'a.ts', old: '', new: 'x' }), /must not be empty/)
})

test('多行替换保留其余内容与缩进', async () => {
  const { root, edit } = sandbox('function f() {\n    return 1\n}\n')
  const old = 'function f() {\n    return 1\n}'
  const next = 'function f() {\n    return 2\n}'

  await edit.run({ path: 'a.ts', old, new: next })
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'function f() {\n    return 2\n}\n')
})

test('仍受工作区边界约束', async () => {
  const { edit } = sandbox('abc')
  await assert.rejects(
    async () => await edit.run({ path: '../escape.ts', old: 'a', new: 'b' }),
    /escapes the workspace/,
  )
})
