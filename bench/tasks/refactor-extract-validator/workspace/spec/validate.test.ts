import test from 'node:test'
import assert from 'node:assert/strict'
import { isEmail } from '../src/validate.ts'
import { validateSignup } from '../src/signup.ts'
import { validateInvite } from '../src/invite.ts'

test('isEmail 提取为独立模块', () => {
  assert.equal(isEmail('a@b.c'), true)
  assert.equal(isEmail('a@'), false)
  assert.equal(isEmail('@b'), false)
  assert.equal(isEmail('nope'), false)
})

test('注册校验行为不变', () => {
  assert.deepEqual(validateSignup('bad', 20), ['email'])
  assert.deepEqual(validateSignup('a@b.c', 17), ['age'])
  assert.deepEqual(validateSignup('a@b.c', 20), [])
  assert.deepEqual(validateSignup('bad', 10), ['email', 'age'])
})

test('邀请校验行为不变', () => {
  assert.deepEqual(validateInvite('bad'), ['email'])
  assert.deepEqual(validateInvite('a@b.c'), [])
})
