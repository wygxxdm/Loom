import test from 'node:test'
import assert from 'node:assert/strict'
import { TtlCache } from '../src/cache.ts'

test('未过期时正常命中', () => {
  let now = 0
  const cache = new TtlCache<string, number>(100, () => now)

  cache.set('a', 1)
  assert.equal(cache.get('a'), 1)

  now = 99
  assert.equal(cache.get('a'), 1)
})

test('到期后 get 返回 undefined 并清掉该条', () => {
  let now = 0
  const cache = new TtlCache<string, number>(100, () => now)

  cache.set('a', 1)
  now = 100
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.size(), 0)
})

test('重新 set 会刷新过期时间', () => {
  let now = 0
  const cache = new TtlCache<string, number>(100, () => now)

  cache.set('a', 1)
  now = 80
  cache.set('a', 2)

  now = 150
  assert.equal(cache.get('a'), 2)

  now = 180
  assert.equal(cache.get('a'), undefined)
})

test('size 不计入已过期条目', () => {
  let now = 0
  const cache = new TtlCache<string, number>(100, () => now)

  cache.set('a', 1)
  cache.set('b', 2)
  assert.equal(cache.size(), 2)

  now = 101
  assert.equal(cache.size(), 0)
})

test('不同 key 互不影响', () => {
  let now = 0
  const cache = new TtlCache<string, number>(50, () => now)

  cache.set('a', 1)
  now = 30
  cache.set('b', 2)
  now = 60

  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('b'), 2)
})
