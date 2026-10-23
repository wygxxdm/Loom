import test from 'node:test'
import assert from 'node:assert/strict'
import { formatAmount } from '../src/money.ts'
import { formatInvoice } from '../src/invoice.ts'

test('formatAmount 处理整数金额', () => {
  assert.equal(formatAmount(1234, '¥'), '¥12.34')
})

test('formatAmount 补足两位小数', () => {
  assert.equal(formatAmount(5, '¥'), '¥0.05')
  assert.equal(formatAmount(1200, '$'), '$12.00')
})

test('formatAmount 处理负数', () => {
  assert.equal(formatAmount(-5, '¥'), '-¥0.05')
  assert.equal(formatAmount(-1234, '¥'), '-¥12.34')
})

test('formatInvoice 行为不变', () => {
  assert.equal(formatInvoice({ id: 'A1', cents: 1234, currency: '¥' }), 'A1 ¥12.34')
  assert.equal(formatInvoice({ id: 'A2', cents: -5, currency: '$' }), 'A2 -$0.05')
})
