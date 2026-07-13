#!/usr/bin/env bun
/**
 * clientApi.appointment.staffSchedule
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/appointment.js
 *
 * 查询某门店某日各美容师已被占用的时段起点（待确认/已确认），
 * 供前端弹层标注「已约满」（1 对 1 口径）。
 *
 * 关键点：
 *   - 时段用 AT TIME ZONE 'Asia/Shanghai' 取墙钟 HH:MM（tz-safe，不依赖 session tz）
 *   - 仅 status IN (待确认,已确认) 计入；已完成/已取消不计
 *   - employee_id NULL 不计入
 *   - storeId 隔离、日期隔离
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID, TEST_STORE_ID,
} from '../setup.mjs'
import { invokeAs, expectError, expectSuccess } from '../helpers/invoke-client.mjs'
import { ensureTestStore, createTestClient, cleanupTestData } from '../helpers/fixtures.mjs'
import { cleanupClientExtras, createTestBeautician } from '../helpers/client-fixtures.mjs'

function isoDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 直接 SQL 造一条预约（明确 +08:00 偏移，避免 session tz 歧义） */
async function insertAppointment({ appointmentId, employeeId, clientUserId, isoTime, status = '待确认', storeId = TEST_STORE_ID }) {
  await pgQuery(
    `INSERT INTO appointments (
       appointment_id, status, store_id, client_user_id, client_name,
       employee_id, employee_name, appointment_time, created_at, updated_at
     ) VALUES ($1, $2::appointment_status, $3, $4, '测试顾客', $5, '测试美容师', $6::timestamptz, NOW(), NOW())`,
    [appointmentId, status, storeId, clientUserId, employeeId || null, isoTime]
  )
}

// happy：A 在 date 10:00 有活跃预约 → busySlots 含 '10:00'；B 无预约
async function caseHappy() {
  await createTestClient()
  const date = isoDate(1)
  const { employeeId: aId } = await createTestBeautician({
    employeeId: `${NS}_SCHA`, openid: `${NS}_SCHA_OP`, phone: '19999099301',
  })
  const { employeeId: bId } = await createTestBeautician({
    employeeId: `${NS}_SCHB`, openid: `${NS}_SCHB_OP`, phone: '19999099302',
  })
  await insertAppointment({
    appointmentId: `${NS}_SCH_A1`, employeeId: aId, clientUserId: TEST_CLIENT_USER_ID,
    isoTime: `${date}T10:00:00+08:00`,
  })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.staffSchedule', { storeId: TEST_STORE_ID, date })
  expectSuccess(res)
  const map = Object.fromEntries((res.data?.staffSchedule || []).map(s => [s.employeeId, s.busySlots]))
  if (!map[aId] || !map[aId].includes('10:00')) {
    throw new Error(`expect A busySlots includes 10:00, got: ${JSON.stringify(map[aId])}`)
  }
  if (map[bId] && map[bId].length > 0) {
    throw new Error(`expect B has no busySlots, got: ${JSON.stringify(map[bId])}`)
  }
}

// 仅活跃态计入：待确认/已确认 进；已完成/已取消不进
async function caseOnlyActiveStatus() {
  await createTestClient()
  const date = isoDate(1)
  const { employeeId } = await createTestBeautician({
    employeeId: `${NS}_SCHS`, openid: `${NS}_SCHS_OP`, phone: '19999099303',
  })
  await insertAppointment({ appointmentId: `${NS}_SCH_S1`, employeeId, clientUserId: TEST_CLIENT_USER_ID, isoTime: `${date}T09:00:00+08:00`, status: '待确认' })
  await insertAppointment({ appointmentId: `${NS}_SCH_S2`, employeeId, clientUserId: TEST_CLIENT_USER_ID, isoTime: `${date}T11:00:00+08:00`, status: '已确认' })
  await insertAppointment({ appointmentId: `${NS}_SCH_S3`, employeeId, clientUserId: TEST_CLIENT_USER_ID, isoTime: `${date}T13:00:00+08:00`, status: '已完成' })
  await insertAppointment({ appointmentId: `${NS}_SCH_S4`, employeeId, clientUserId: TEST_CLIENT_USER_ID, isoTime: `${date}T15:00:00+08:00`, status: '已取消' })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.staffSchedule', { storeId: TEST_STORE_ID, date })
  expectSuccess(res)
  const entry = (res.data?.staffSchedule || []).find(s => s.employeeId === employeeId)
  const slots = entry?.busySlots || []
  if (!slots.includes('09:00') || !slots.includes('11:00')) {
    throw new Error(`expect active slots 09:00/11:00, got: ${JSON.stringify(slots)}`)
  }
  if (slots.includes('13:00') || slots.includes('15:00')) {
    throw new Error(`expect non-active (已完成/已取消) excluded, got: ${JSON.stringify(slots)}`)
  }
}

// 跨日不串：date+2 的预约不出现在 date+1 的结果
async function caseCrossDayIsolated() {
  await createTestClient()
  const date = isoDate(1)
  const otherDate = isoDate(2)
  const { employeeId } = await createTestBeautician({
    employeeId: `${NS}_SCHD`, openid: `${NS}_SCHD_OP`, phone: '19999099304',
  })
  await insertAppointment({ appointmentId: `${NS}_SCH_D1`, employeeId, clientUserId: TEST_CLIENT_USER_ID, isoTime: `${otherDate}T10:00:00+08:00` })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.staffSchedule', { storeId: TEST_STORE_ID, date })
  expectSuccess(res)
  const entry = (res.data?.staffSchedule || []).find(s => s.employeeId === employeeId)
  if (entry && entry.busySlots.length > 0) {
    throw new Error(`expect no slots on ${date} (apt is on ${otherDate}), got: ${JSON.stringify(entry.busySlots)}`)
  }
}

// employee_id NULL 的预约不计入（不指定美容师）
async function caseNullEmployeeExcluded() {
  await createTestClient()
  const date = isoDate(1)
  await insertAppointment({ appointmentId: `${NS}_SCH_N1`, employeeId: null, clientUserId: TEST_CLIENT_USER_ID, isoTime: `${date}T10:00:00+08:00` })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.staffSchedule', { storeId: TEST_STORE_ID, date })
  expectSuccess(res)
  if ((res.data?.staffSchedule || []).length !== 0) {
    throw new Error(`expect empty schedule for NULL-employee appt, got: ${JSON.stringify(res.data?.staffSchedule)}`)
  }
}

// 参数校验：缺 storeId / date 格式错 → INVALID_PARAMS
async function caseInvalidParams() {
  await createTestClient()
  const date = isoDate(1)
  const r1 = await invokeAs(TEST_CLIENT_OPENID, 'appointment.staffSchedule', { date })
  expectError(r1, 'INVALID_PARAMS', { messageIncludes: 'storeId' })
  const r2 = await invokeAs(TEST_CLIENT_OPENID, 'appointment.staffSchedule', { storeId: TEST_STORE_ID, date: '2026/07/14' })
  expectError(r2, 'INVALID_PARAMS', { messageIncludes: 'YYYY-MM-DD' })
  const r3 = await invokeAs(TEST_CLIENT_OPENID, 'appointment.staffSchedule', { storeId: TEST_STORE_ID })
  expectError(r3, 'INVALID_PARAMS')
}

const CASES = [
  ['happy → A busySlots=[10:00], B empty', caseHappy],
  ['only active status (待确认/已确认) counted', caseOnlyActiveStatus],
  ['cross-day appointment not leaked', caseCrossDayIsolated],
  ['NULL employee_id excluded', caseNullEmployeeExcluded],
  ['invalid params (missing storeId / bad date) → INVALID_PARAMS', caseInvalidParams],
]

let pass = 0, fail = 0
console.log(`[appointment/staffSchedule.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[appointment/staffSchedule.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
