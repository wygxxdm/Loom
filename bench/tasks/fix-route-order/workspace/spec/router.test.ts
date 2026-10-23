import test from 'node:test'
import assert from 'node:assert/strict'
import { match } from '../src/router.ts'

test('静态路径优先于参数路径', () => {
  assert.equal(match('/users/me'), 'me')
})

test('参数路径仍然可以匹配', () => {
  assert.equal(match('/users/42'), 'user:42')
})

test('上级路径不受影响', () => {
  assert.equal(match('/users'), 'list')
})

test('未命中返回 undefined', () => {
  assert.equal(match('/nope'), undefined)
  assert.equal(match('/users/42/extra'), undefined)
})
