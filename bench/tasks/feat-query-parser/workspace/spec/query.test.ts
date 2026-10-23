import test from 'node:test'
import assert from 'node:assert/strict'
import { parseQuery } from '../src/url.ts'

test('空查询串返回空对象', () => {
  assert.deepEqual(parseQuery(''), {})
})

test('普通键值对', () => {
  assert.deepEqual(parseQuery('a=1&b=2'), { a: '1', b: '2' })
})

test('百分号编码与加号都要解码', () => {
  assert.deepEqual(parseQuery('q=hello%20world&s=a+b'), { q: 'hello world', s: 'a b' })
})

test('重复键收集成数组', () => {
  assert.deepEqual(parseQuery('tag=a&tag=b'), { tag: ['a', 'b'] })
})

test('没有等号的键取空字符串', () => {
  assert.deepEqual(parseQuery('flag'), { flag: '' })
})

test('忽略空片段', () => {
  assert.deepEqual(parseQuery('a=1&&b=2'), { a: '1', b: '2' })
})
