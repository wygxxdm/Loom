import test from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, renderVersion } from '../src/cli.ts'
import { describe } from '../src/info.ts'

test('--version 被识别，且不当作子命令', () => {
  const parsed = parseArgs(['--version'])
  assert.equal(parsed.version, true)
  assert.equal(parsed.command, 'help')
})

test('其他参数仍然正常工作', () => {
  const parsed = parseArgs(['build', '--verbose'])
  assert.equal(parsed.version, false)
  assert.equal(parsed.command, 'build')
  assert.equal(parsed.verbose, true)
})

test('info.describe 返回名字与版本', () => {
  assert.equal(describe(), 'acme 1.2.3')
})

test('renderVersion 复用 describe 的结果', () => {
  assert.equal(renderVersion(), 'acme 1.2.3')
})
