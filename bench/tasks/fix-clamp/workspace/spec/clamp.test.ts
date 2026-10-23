import test from 'node:test'
import assert from 'node:assert/strict'
import { clamp } from '../src/clamp.ts'

test('值低于下界时返回下界', () => {
  assert.equal(clamp(-5, 0, 10), 0)
})

test('值高于上界时返回上界', () => {
  assert.equal(clamp(50, 0, 10), 10)
})

test('区间内原样返回', () => {
  assert.equal(clamp(5, 0, 10), 5)
})
