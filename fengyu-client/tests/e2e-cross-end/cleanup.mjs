#!/usr/bin/env bun
/**
 * cross-end (TE2X) 命名空间手动清理
 *
 * 用法：
 *   bun fengyu-client/tests/e2e-cross-end/cleanup.mjs
 */
import './setup.mjs'
import { closePool } from './setup.mjs'
import { cleanupCrossEnd } from './helpers/fixtures-cross.mjs'

console.log(`[cross-end/cleanup] start | ${new Date().toISOString()}`)
try {
  await cleanupCrossEnd()
  console.log(`[cross-end/cleanup] done`)
} catch (e) {
  console.error(`[cross-end/cleanup] error:`, e.message)
  process.exitCode = 1
} finally {
  await closePool()
}
