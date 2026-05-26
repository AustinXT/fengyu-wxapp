#!/usr/bin/env bun
/**
 * 一次性清理 admin Server Action smoke 的命名空间残留。
 * 仅删除以命名空间前缀 'TE2L2_' 开头或匹配测试手机号的行。
 *
 * 用法：bun fengyu-admin/tests/e2e-actions/cleanup.mjs
 */
import './setup.mjs'
import { closePool } from './setup.mjs'
import { cleanupTestData } from './helpers/fixtures.mjs'

console.log('[cleanup] start')
await cleanupTestData()
console.log('[cleanup] done')
await closePool()
