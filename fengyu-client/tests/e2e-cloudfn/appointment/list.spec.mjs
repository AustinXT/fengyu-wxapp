#!/usr/bin/env bun
/**
 * clientApi.appointment.list
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/appointment.js (line 131)
 *   - 仅按 client_user_id；status 过滤；page+pageSize 分页（fetchLimit=pageSize+1）
 *   - response: { appointments, hasMore }; appointments 按 appointment_time DESC
 *
 * 重要：appointments 表无 FK 校验到 sale_items（sale_item_id 可 NULL），
 *       本 spec 直接 SQL INSERT 多条记录测试分页/过滤
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID, TEST_STORE_ID,
} from '../setup.mjs'
import { invokeAs, expectError, expectSuccess } from '../helpers/invoke-client.mjs'
import { createTestClient, cleanupTestData } from '../../../../tests/e2e-cloudfn/helpers/fixtures.mjs'
import {
  cleanupClientExtras, createTestBeautician, createTestAppointment,
} from '../helpers/client-fixtures.mjs'

async function insertAppointment({ idx, status, userId = TEST_CLIENT_USER_ID }) {
  const apptId = `${NS}_APT_${status}_${idx}`.slice(0, 30)
  // appointment_time 错开（i 越大越新）
  const apptTime = new Date(Date.now() + (idx + 1) * 86400_000)
  // employee_id 是 NOT NULL FK → staff_wechat_users，先建美容师
  const { employeeId } = await createTestBeautician({
    employeeId: `${NS}_APT_BEAUT`,
    openid: `${NS}_APT_BEAUT_OPENID`,
    phone: '19999099105',
  })
  await createTestAppointment({
    appointmentId: apptId,
    clientUserId: userId,
    employeeId,
    status,
    appointmentTime: apptTime,
  })
  return apptId
}

async function caseListAll() {
  await createTestClient()
  // 3 条不同状态
  await insertAppointment({ idx: 0, status: '待确认' })
  await insertAppointment({ idx: 1, status: '已确认' })
  await insertAppointment({ idx: 2, status: '已取消' })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.list', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const list = res.data?.appointments || []
  // 命名空间隔离：只看本 NS 数据
  const mine = list.filter(a => a.appointment_id?.startsWith(`${NS}_APT_`))
  if (mine.length !== 3) throw new Error(`expect 3 my appointments, got ${mine.length}`)
}

async function caseListStatusFilter() {
  await createTestClient()
  await insertAppointment({ idx: 0, status: '待确认' })
  await insertAppointment({ idx: 1, status: '已确认' })
  await insertAppointment({ idx: 2, status: '已取消' })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.list', { status: '待确认' })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const mine = (res.data?.appointments || []).filter(a => a.appointment_id?.startsWith(`${NS}_APT_`))
  if (mine.length !== 1) throw new Error(`expect 1 待确认, got ${mine.length}`)
  if (mine[0].status !== '待确认') throw new Error(`status=${mine[0].status}`)
}

async function caseListPagination() {
  await createTestClient()
  await insertAppointment({ idx: 0, status: '待确认' })
  await insertAppointment({ idx: 1, status: '待确认' })
  await insertAppointment({ idx: 2, status: '待确认' })
  const r1 = await invokeAs(TEST_CLIENT_OPENID, 'appointment.list', { page: 1, pageSize: 2 })
  if (r1.code !== 0) throw new Error(`p1 code=${r1.code}: ${r1.message}`)
  if ((r1.data?.appointments || []).length !== 2) {
    throw new Error(`page1 expect 2, got ${r1.data.appointments.length}`)
  }
  if (r1.data.hasMore !== true) throw new Error(`page1 expect hasMore=true`)
  const r2 = await invokeAs(TEST_CLIENT_OPENID, 'appointment.list', { page: 2, pageSize: 2 })
  if (r2.code !== 0) throw new Error(`p2 code=${r2.code}: ${r2.message}`)
  if ((r2.data?.appointments || []).length !== 1) {
    throw new Error(`page2 expect 1, got ${r2.data.appointments.length}`)
  }
  if (r2.data.hasMore !== false) throw new Error(`page2 expect hasMore=false`)
}

async function caseListEmpty() {
  await createTestClient()
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.list', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const mine = (res.data?.appointments || []).filter(a => a.appointment_id?.startsWith(`${NS}_APT_`))
  if (mine.length !== 0) throw new Error(`expect empty, got ${mine.length}`)
}

const CASES = [
  ['list returns all 3 appointments', caseListAll],
  ['list filtered by status=待确认 returns only matching', caseListStatusFilter],
  ['list paginates with hasMore flag', caseListPagination],
  ['list empty returns empty array', caseListEmpty],
]

let pass = 0, fail = 0
console.log(`[appointment/list.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[appointment/list.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
