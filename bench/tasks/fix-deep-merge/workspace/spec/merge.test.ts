import test from 'node:test'
import assert from 'node:assert/strict'
import { merge } from '../src/merge.ts'

test('嵌套对象逐层合并', () => {
  const result = merge({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9 } })
  assert.deepEqual(result, { a: 1, b: { c: 9, d: 3 } })
})

test('数组整体替换，不逐项合并', () => {
  const result = merge({ list: [1, 2, 3] }, { list: [9] })
  assert.deepEqual(result, { list: [9] })
})

test('undefined 不覆盖已有值', () => {
  const result = merge({ a: 1, b: 2 }, { a: undefined })
  assert.deepEqual(result, { a: 1, b: 2 })
})

test('null 覆盖对象', () => {
  const result = merge({ a: { b: 1 } }, { a: null })
  assert.deepEqual(result, { a: null })
})

test('不修改入参', () => {
  const base = { a: { b: 1 } }
  merge(base, { a: { b: 2 } })
  assert.deepEqual(base, { a: { b: 1 } })
})

test('新增键会被加入', () => {
  const result = merge({ a: 1 }, { c: 3 })
  assert.deepEqual(result, { a: 1, c: 3 })
})
