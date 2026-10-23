import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelHttpError } from '../src/plugins/deepseek-model.ts'

test('限流和服务端错误可以重试', () => {
  assert.equal(new ModelHttpError(429, 'rate limited').retryable, true)
  assert.equal(new ModelHttpError(500, 'boom').retryable, true)
  assert.equal(new ModelHttpError(503, 'unavailable').retryable, true)
})

test('鉴权和参数错误不重试', () => {
  assert.equal(new ModelHttpError(400, 'bad request').retryable, false)
  assert.equal(new ModelHttpError(401, 'unauthorized').retryable, false)
  assert.equal(new ModelHttpError(404, 'not found').retryable, false)
})

test('错误信息里保留状态码', () => {
  const error = new ModelHttpError(429, 'slow down')
  assert.match(error.message, /429/)
  assert.match(error.message, /slow down/)
})
