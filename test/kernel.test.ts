import test from 'node:test'
import assert from 'node:assert/strict'
import { Container, childScope } from '../src/kernel/container.ts'
import { capability } from '../src/kernel/token.ts'
import { resolveOrder } from '../src/kernel/graph.ts'
import type { Plugin } from '../src/kernel/plugin.ts'

const A = capability<{ name: string }>('test.a')
const B = capability<{ name: string }>('test.b')
const C = capability<{ name: string }>('test.c')

test('container 拒绝重复提供，不静默覆盖', () => {
  const container = new Container()
  container.provide(A, { name: 'first' })
  assert.throws(() => container.provide(A, { name: 'second' }), /already provided/)
})

test('container 按 LIFO 释放，且单个失败不阻塞其余', async () => {
  const container = new Container()
  const order: string[] = []

  container.onDispose(() => order.push('first'))
  container.onDispose(() => {
    order.push('second')
    throw new Error('boom')
  })
  container.onDispose(() => order.push('third'))

  await assert.rejects(container.dispose(), /boom/)
  assert.deepEqual(order, ['third', 'second', 'first'])
})

test('子作用域可以读父级，但父级看不到子级', () => {
  const parent = new Container()
  parent.provide(A, { name: 'root' })

  const child = childScope(parent)
  child.provide(B, { name: 'leaf' })

  assert.equal(child.require(A).name, 'root')
  assert.equal(parent.has(B), false)
})

test('依赖排序把提供者放在消费者之前', () => {
  const consumer: Plugin = {
    name: 'consumer',
    needs: [A, B],
    provides: [C],
    setup() {},
  }
  const providerB: Plugin = { name: 'provider-b', provides: [B], setup() {} }
  const providerA: Plugin = { name: 'provider-a', provides: [A], setup() {} }

  const order = resolveOrder([consumer, providerB, providerA]).map((plugin) => plugin.name)

  assert.ok(order.indexOf('provider-a') < order.indexOf('consumer'))
  assert.ok(order.indexOf('provider-b') < order.indexOf('consumer'))
  assert.equal(order[order.length - 1], 'consumer')
})

test('缺少提供者时在排序阶段就报错', () => {
  const lonely: Plugin = { name: 'lonely', needs: [A], provides: [], setup() {} }
  assert.throws(() => resolveOrder([lonely]), /needs capability "test.a"/)
})

test('检测依赖环并给出路径', () => {
  const p1: Plugin = { name: 'p1', needs: [B], provides: [A], setup() {} }
  const p2: Plugin = { name: 'p2', needs: [A], provides: [B], setup() {} }

  assert.throws(() => resolveOrder([p1, p2]), /cycle/)
})

test('同一能力被两个插件提供时报冲突', () => {
  const p1: Plugin = { name: 'p1', provides: [A], setup() {} }
  const p2: Plugin = { name: 'p2', provides: [A], setup() {} }

  assert.throws(() => resolveOrder([p1, p2]), /provided by both/)
})
