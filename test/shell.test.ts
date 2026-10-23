import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyCommand, scanCommand, shellTool } from '../src/plugins/shell-tool.ts'

test('词法扫描切出可执行文件与参数', () => {
  const scan = scanCommand('ls -la src')
  assert.equal(scan.executable, 'ls')
  assert.deepEqual(scan.args, ['-la', 'src'])
  assert.equal(scan.hasShellSyntax, false)
  assert.equal(scan.valid, true)
})

test('引号内的空格不会被当作分隔符', () => {
  const scan = scanCommand('grep "a b" file.txt')
  assert.equal(scan.executable, 'grep')
  assert.deepEqual(scan.args, ['a b', 'file.txt'])
  assert.equal(scan.hasShellSyntax, false)
})

test('未加引号的管道、重定向、替换符被标成 shell 语法', () => {
  for (const command of ['ls | grep a', 'cat x > y', 'echo $(whoami)', 'a && b', 'a; b', 'a `b`']) {
    const scan = scanCommand(command)
    assert.equal(scan.hasShellSyntax, true, command)
    assert.equal(scan.valid, false, command)
  }
})

test('引号未闭合按不确定处理', () => {
  const scan = scanCommand('echo "unterminated')
  assert.equal(scan.hasShellSyntax, true)
  assert.equal(scan.valid, false)
})

test('风险分级：只读命令自动放行', () => {
  assert.equal(classifyCommand('ls -la'), 'shell-low')
  assert.equal(classifyCommand('cat package.json'), 'shell-low')
  assert.equal(classifyCommand('git status'), 'shell-low')
  assert.equal(classifyCommand('git diff HEAD'), 'shell-low')
})

test('风险分级：普通外部命令要确认', () => {
  assert.equal(classifyCommand('npm install'), 'shell')
  assert.equal(classifyCommand('git push origin main'), 'shell')
  assert.equal(classifyCommand('node -e 1'), 'shell')
})

test('风险分级：可能越界的判为高危', () => {
  assert.equal(classifyCommand('rm -rf build'), 'shell')
  assert.equal(classifyCommand('ls | grep x'), 'shell-high')
  assert.equal(classifyCommand('cat x > y'), 'shell-high')
  assert.equal(classifyCommand('./scripts/build.sh'), 'shell-high')
  assert.equal(classifyCommand('/usr/bin/env node'), 'shell-high')
})

test('工具按参数返回不同风险', () => {
  const tool = shellTool({ root: tmpdir() })
  assert.equal(tool.riskOf?.({ command: 'ls' }), 'shell-low')
  assert.equal(tool.riskOf?.({ command: 'git push' }), 'shell')
  assert.equal(tool.riskOf?.({ command: 'ls | wc -l' }), 'shell-high')
  assert.equal(tool.riskOf?.({}), 'shell-high')
})

test('执行只读命令并返回退出码与输出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-shell-'))
  writeFileSync(join(dir, 'note.txt'), 'hello')

  const tool = shellTool({ root: dir })
  const output = await tool.run({ command: 'cat note.txt' })

  assert.match(output, /exit: 0/)
  assert.match(output, /hello/)
})

test('走真 shell，因此管道可用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-shell-'))
  writeFileSync(join(dir, 'note.txt'), 'a\nb\nc\n')

  const tool = shellTool({ root: dir })
  const output = await tool.run({ command: 'cat note.txt | wc -l' })

  assert.match(output, /exit: 0/)
  assert.match(output.trim(), /3/)
})

test('命令不存在时由 shell 报 127，而不是抛异常', async () => {
  const tool = shellTool({ root: tmpdir() })
  const output = await tool.run({ command: 'definitely-not-a-command-xyz' })
  assert.match(output, /exit: 127/)
})

test('超时会被整组杀掉并报错', async () => {
  const tool = shellTool({ root: tmpdir(), timeoutMs: 300 })
  await assert.rejects(async () => await tool.run({ command: 'sleep 5' }), /timed out/)
})
