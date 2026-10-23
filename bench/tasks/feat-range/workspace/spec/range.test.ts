import test from 'node:test'
import assert from 'node:assert/strict'
import { range } from '../src/range.ts'

test('0 返回空数组', () => {
  assert.deepEqual(range(0), [])
})

test('正数返回递增序列', () => {
  assert.deepEqual(range(3), [0, 1, 2])
})

test('负数返回空数组', () => {
  assert.deepEqual(range(-2), [])
})
