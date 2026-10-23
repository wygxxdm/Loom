import test from 'node:test'
import assert from 'node:assert/strict'
import { splitList } from '../src/split.ts'

test('空字符串返回空数组', () => {
  assert.deepEqual(splitList(''), [])
})

test('纯空白返回空数组', () => {
  assert.deepEqual(splitList('   '), [])
})

test('正常分割并去空白', () => {
  assert.deepEqual(splitList('a, b'), ['a', 'b'])
})

test('连续逗号不产生空项', () => {
  assert.deepEqual(splitList('a,,b'), ['a', 'b'])
})
