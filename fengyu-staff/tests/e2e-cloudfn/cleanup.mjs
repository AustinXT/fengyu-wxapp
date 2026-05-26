#!/usr/bin/env bun
/**
 * 一次性清理所有 tests/e2e-cloudfn 命名空间数据。
 * 仅删除以命名空间前缀 NS（staff = 'TE2LS_'）开头或匹配测试手机号的行。
 *
 * 用法：bun tests/e2e-cloudfn/cleanup.mjs
 */
import './setup.mjs'
import { NS, closePool, pgQuery } from './setup.mjs'
import { cleanupTestData } from './helpers/fixtures.mjs'

console.log('[cleanup] start')
await cleanupTestData()
// 顺手清掉残留的 paynotify.disabled_invocation 测试告警
await pgQuery(
  `DELETE FROM operation_logs
    WHERE action = 'paynotify.disabled_invocation'
      AND target_id = 'EXTERNAL'
      AND (detail->>'event_keys')::text LIKE '%' || $1 || '_%'`,
  [NS],
).catch((e) => console.warn('[cleanup] op_logs paynotify:', e.message))
console.log('[cleanup] done')
await closePool()
