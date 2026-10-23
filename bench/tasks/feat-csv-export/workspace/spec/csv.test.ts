import test from 'node:test'
import assert from 'node:assert/strict'
import { toCsv } from '../src/report.ts'

test('普通行按逗号拼接，行之间用换行', () => {
  assert.equal(toCsv([['a', 'b'], ['1', '2']]), 'a,b\n1,2')
})

test('含逗号的字段加引号', () => {
  assert.equal(toCsv([['a,b', 'c']]), '"a,b",c')
})

test('含引号的字段要转义成两个引号', () => {
  assert.equal(toCsv([['say "hi"']]), '"say ""hi"""')
})

test('含换行的字段加引号', () => {
  assert.equal(toCsv([['line\nbreak']]), '"line\nbreak"')
})

test('空行被跳过', () => {
  assert.equal(toCsv([[], ['a']]), 'a')
})
