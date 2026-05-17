#!/usr/bin/env bun
// 清理 L3 client 命名空间残留
import { cleanupL3TestData } from './helpers/fixtures.mjs'
import { closePool } from './helpers/pg.mjs'

try {
  console.log(`[L3 cleanup] start | ${new Date().toISOString()}`)
  await cleanupL3TestData()
  console.log(`[L3 cleanup] done`)
} catch (e) {
  console.error('[L3 cleanup] FAILED:', e.message)
  process.exitCode = 1
} finally {
  await closePool()
}
