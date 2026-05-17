#!/usr/bin/env bun
/**
 * clientApi.message.list / read / unreadCount 全分支
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/message.js
 *
 * 实测要点：
 *   - messages.recipient_type 枚举值为 '客户' / '员工'（非英文 client/staff）
 *     而 helpers/client-fixtures.mjs::createTestMessage 默认 recipientType='client'
 *     会触发枚举校验失败 → 本 spec 显式传 recipientType='客户'
 *   - read 跨用户：路由 SQL 加了 recipient_id=$3 守卫，错误用户调用不抛错也不更新
 *     （UPDATE 影响 0 行，返回 success: true）→ 用例断言"目标行 is_read 仍 false"
 *
 * 用例：
 *   1. list 倒序             — 插 3 条 → list 返回 3 条按 created_at DESC
 *   2. list 分页             — 插 5 条 → page=1 pageSize=2 → 返回 2 条
 *   3. read happy            — 建未读 → read({messageId}) → PG 验证 is_read=true
 *   4. read 跨用户拒绝       — A 标记 B 的消息 → success:true 但 B 的消息仍未读
 *   5. unreadCount           — 5 条 3 未读 → count=3
 *   6. read 缺 messageId     — INVALID_PARAMS
 */
import '../setup.mjs'
import {
  NS, closePool,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID,
  TEST_CLIENT2_OPENID, TEST_CLIENT2_USER_ID,
  pgQuery,
} from '../setup.mjs'
import { invokeAs, expectError, expectSuccess } from '../helpers/invoke-client.mjs'
import { createTestClient, cleanupTestData } from '../../../../tests/e2e-cloudfn/helpers/fixtures.mjs'
import { cleanupClientExtras, createTestMessage, createTestClient2 } from '../helpers/client-fixtures.mjs'

async function caseListDesc() {
  await createTestClient()
  await createTestMessage({ recipientType: '客户', title: `${NS}_M1` })
  await new Promise(r => setTimeout(r, 5))
  await createTestMessage({ recipientType: '客户', title: `${NS}_M2` })
  await new Promise(r => setTimeout(r, 5))
  await createTestMessage({ recipientType: '客户', title: `${NS}_M3` })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'message.list', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.records.length !== 3) {
    throw new Error(`expect 3 records, got ${res.data.records.length}`)
  }
  if (res.data.records[0].title !== `${NS}_M3`) {
    throw new Error(`expect newest first (M3), got ${res.data.records[0].title}`)
  }
}

async function caseListPagination() {
  await createTestClient()
  for (let i = 0; i < 5; i++) {
    await createTestMessage({ recipientType: '客户', title: `${NS}_msg_${i}` })
    await new Promise(r => setTimeout(r, 3))
  }
  const res = await invokeAs(TEST_CLIENT_OPENID, 'message.list', { page: 1, pageSize: 2 })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.records.length !== 2) {
    throw new Error(`expect 2 records (page=1 pageSize=2), got ${res.data.records.length}`)
  }
}

async function caseReadHappy() {
  await createTestClient()
  const { id } = await createTestMessage({ recipientType: '客户', isRead: false })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'message.read', { messageId: id })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.success !== true) throw new Error(`expect success=true, got ${res.data.success}`)

  const rows = await pgQuery('SELECT is_read FROM messages WHERE id = $1', [id])
  if (rows[0].is_read !== true) throw new Error(`expect is_read=true, got ${rows[0].is_read}`)
}

async function caseReadCrossUser() {
  await createTestClient()
  await createTestClient2()
  // 给 client2 建一条未读消息
  const { id } = await createTestMessage({
    recipientType: '客户',
    recipientId: TEST_CLIENT2_USER_ID,
    isRead: false,
  })

  // client1 (TEST_CLIENT_OPENID) 尝试标记 client2 的消息
  const res = await invokeAs(TEST_CLIENT_OPENID, 'message.read', { messageId: id })
  // 路由 SQL 不报错，UPDATE 影响 0 行
  if (res.code !== 0) throw new Error(`expect code=0 (no error), got ${res.code}: ${res.message}`)

  // 验证：client2 的消息仍为未读
  const rows = await pgQuery('SELECT is_read, recipient_id FROM messages WHERE id = $1', [id])
  if (rows[0].is_read !== false) {
    throw new Error(`cross-user read should not flip is_read; got ${rows[0].is_read}`)
  }
  if (rows[0].recipient_id !== TEST_CLIENT2_USER_ID) {
    throw new Error(`recipient_id mismatch: ${rows[0].recipient_id}`)
  }
}

async function caseUnreadCount() {
  await createTestClient()
  // 5 条消息，3 条未读 + 2 条已读
  await createTestMessage({ recipientType: '客户', isRead: false, title: `${NS}_u1` })
  await createTestMessage({ recipientType: '客户', isRead: false, title: `${NS}_u2` })
  await createTestMessage({ recipientType: '客户', isRead: false, title: `${NS}_u3` })
  await createTestMessage({ recipientType: '客户', isRead: true, title: `${NS}_r1` })
  await createTestMessage({ recipientType: '客户', isRead: true, title: `${NS}_r2` })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'message.unreadCount', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.count !== 3) {
    throw new Error(`expect count=3, got ${res.data.count}`)
  }
}

async function caseReadMissingMessageId() {
  await createTestClient()
  const res = await invokeAs(TEST_CLIENT_OPENID, 'message.read', {})
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '缺少 messageId' })
}

const CASES = [
  ['list 3 msgs → desc order', caseListDesc],
  ['list pagination → page=1 pageSize=2 returns 2', caseListPagination],
  ['read happy → PG is_read=true', caseReadHappy],
  ['read cross-user → no-op (target stays unread)', caseReadCrossUser],
  ['unreadCount 3 of 5 → 3', caseUnreadCount],
  ['read missing messageId → INVALID_PARAMS', caseReadMissingMessageId],
]

let pass = 0, fail = 0
console.log(`[message/list-read-unread.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

try {
  for (const [name, fn] of CASES) {
    await cleanupClientExtras(NS)
    await cleanupTestData(NS)
    try {
      await fn()
      console.log(`  ✅ ${name}`)
      pass++
    } catch (e) {
      console.log(`  ❌ ${name}`)
      console.log(`     ${e.message}`)
      if (process.env.E2E_DEBUG) console.log(e.stack)
      fail++
    }
  }
} finally {
  await cleanupClientExtras(NS)
  await cleanupTestData(NS)
  await closePool()
}

console.log(`[message/list-read-unread.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
