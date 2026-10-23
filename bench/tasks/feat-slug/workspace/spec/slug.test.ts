import test from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/slug.ts'

test('折叠空格与标点', () => {
  assert.equal(slugify('Hello World!'), 'hello-world')
})

test('去掉首尾连字符', () => {
  assert.equal(slugify('  A  B '), 'a-b')
})

test('空输入返回空串', () => {
  assert.equal(slugify(''), '')
})

test('连续分隔符折叠成一个', () => {
  assert.equal(slugify('A--B'), 'a-b')
})
