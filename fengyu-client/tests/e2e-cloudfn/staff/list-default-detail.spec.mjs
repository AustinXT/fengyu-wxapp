#!/usr/bin/env bun
/**
 * clientApi.staff.list / defaultStaff / detail 全分支
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/staff.js
 *
 * 实测要点：
 *   - staff.list 是公开接口（无 auth 中间件），但仍要求 storeId 参数
 *   - list 过滤条件：is_resigned=false AND position_name IN ('美容师','高级美容师','资深美容师')
 *     → createTestStaff 默认 position_name='门店经理'，不会出现在 list 结果，需自行 INSERT 美容师行
 *   - defaultStaff 走 auth 中间件，但路由要求 ctx.auth.phone 存在；否则直接返回空对象
 *     → 测试时必须建带 phone 的顾客（createTestClient 默认就带 phone）
 *   - detail 公开（无认证），只要 employeeId 存在且 is_resigned=false 即可
 */
import '../setup.mjs'
import {
  NS, closePool,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID,
  TEST_STORE_ID, TEST_STORE_ORG_ID,
  TEST_MANAGER_EMP_ID,
  pgQuery,
} from '../setup.mjs'
import { invokeAs, invokePublic } from '../helpers/invoke-client.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  cleanupTestData,
} from '../helpers/fixtures.mjs'
import { cleanupClientExtras } from '../helpers/client-fixtures.mjs'

const BEAUTICIAN_1_ID = `${NS}_BEAUTY1`
const BEAUTICIAN_2_ID = `${NS}_BEAUTY2`
const BEAUTICIAN_1_PHONE = '19999099011'
const BEAUTICIAN_2_PHONE = '19999099012'

/**
 * 本地辅助：直接 INSERT 一个美容师行（绕过 createTestStaff 默认的"门店经理"）
 */
async function createBeautician({
  employeeId,
  phone,
  name,
  positionName = '美容师',
  isResigned = false,
} = {}) {
  await ensureTestStore()
  await pgQuery(
    `INSERT INTO staff_wechat_users (
       employee_id, openid, phone, name, gender, store_id, org_node_id,
       position_name, skills, is_resigned, hired_at
     )
     VALUES ($1, NULL, $2, $3, '女', $4, $5, $6,
             ARRAY['美容']::text[], $7, CURRENT_DATE)
     ON CONFLICT (employee_id) DO UPDATE
       SET phone = EXCLUDED.phone, name = EXCLUDED.name,
           position_name = EXCLUDED.position_name,
           is_resigned = EXCLUDED.is_resigned`,
    [employeeId, phone, name, TEST_STORE_ID, TEST_STORE_ORG_ID, positionName, isResigned]
  )
}

async function caseListBeauticians() {
  await ensureTestStore()
  await createTestStaff()  // 店长（不应出现在 list）
  await createBeautician({
    employeeId: BEAUTICIAN_1_ID,
    phone: BEAUTICIAN_1_PHONE,
    name: `${NS}_美容师A`,
  })
  await createBeautician({
    employeeId: BEAUTICIAN_2_ID,
    phone: BEAUTICIAN_2_PHONE,
    name: `${NS}_高级美A`,
    positionName: '高级美容师',
  })

  const res = await invokePublic('staff.list', { storeId: TEST_STORE_ID })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (!Array.isArray(res.data.staffList) || res.data.staffList.length < 2) {
    throw new Error(`expect ≥ 2 beauticians, got ${res.data.staffList?.length}`)
  }
  // 店长不应被返回（position_name='门店经理'）
  const ids = res.data.staffList.map(s => s.staff_id)
  if (ids.includes(TEST_MANAGER_EMP_ID)) {
    throw new Error(`manager should be filtered out, got ${JSON.stringify(ids)}`)
  }
  if (!ids.includes(BEAUTICIAN_1_ID) || !ids.includes(BEAUTICIAN_2_ID)) {
    throw new Error(`missing beauticians, got ${JSON.stringify(ids)}`)
  }
}

async function caseListResignedFiltered() {
  await ensureTestStore()
  await createBeautician({
    employeeId: BEAUTICIAN_1_ID,
    phone: BEAUTICIAN_1_PHONE,
    name: `${NS}_美容师A`,
  })
  // 先确认在列表里
  let res = await invokePublic('staff.list', { storeId: TEST_STORE_ID })
  if (res.code !== 0) throw new Error(`pre-check failed: ${res.message}`)
  const beforeIds = res.data.staffList.map(s => s.staff_id)
  if (!beforeIds.includes(BEAUTICIAN_1_ID)) {
    throw new Error(`precondition: beautician should be in list, got ${JSON.stringify(beforeIds)}`)
  }
  // 离职
  await pgQuery(
    `UPDATE staff_wechat_users SET is_resigned = true WHERE employee_id = $1`,
    [BEAUTICIAN_1_ID]
  )
  res = await invokePublic('staff.list', { storeId: TEST_STORE_ID })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const afterIds = res.data.staffList.map(s => s.staff_id)
  if (afterIds.includes(BEAUTICIAN_1_ID)) {
    throw new Error(`resigned beautician should be excluded, got ${JSON.stringify(afterIds)}`)
  }
}

async function caseDefaultStaffBound() {
  await ensureTestStore()
  await createTestStaff()  // 创建店长（虽然 list 不返回，但可作 bound_employee_id）
  await createTestClient()
  await pgQuery(
    `UPDATE client_wechat_users SET bound_employee_id = $1 WHERE user_id = $2`,
    [TEST_MANAGER_EMP_ID, TEST_CLIENT_USER_ID]
  )
  const res = await invokeAs(TEST_CLIENT_OPENID, 'staff.default', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.mainStaffId !== TEST_MANAGER_EMP_ID) {
    throw new Error(`mainStaffId mismatch: ${res.data.mainStaffId}`)
  }
  if (!res.data.mainStaffName) {
    throw new Error(`mainStaffName should be present, got ${res.data.mainStaffName}`)
  }
}

async function caseDefaultStaffNotBound() {
  await ensureTestStore()
  await createTestClient()  // 不设 bound_employee_id
  const res = await invokeAs(TEST_CLIENT_OPENID, 'staff.default', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.mainStaffId !== null) {
    throw new Error(`expect mainStaffId=null when not bound, got ${res.data.mainStaffId}`)
  }
  if (res.data.mainStaffName !== null) {
    throw new Error(`expect mainStaffName=null when not bound, got ${res.data.mainStaffName}`)
  }
}

async function caseDetail() {
  await ensureTestStore()
  await createBeautician({
    employeeId: BEAUTICIAN_1_ID,
    phone: BEAUTICIAN_1_PHONE,
    name: `${NS}_美容师A`,
  })
  const res = await invokePublic('staff.detail', { employeeId: BEAUTICIAN_1_ID })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.employeeId !== BEAUTICIAN_1_ID) {
    throw new Error(`employeeId mismatch: ${res.data.employeeId}`)
  }
  if (typeof res.data.serviceCount !== 'number') {
    throw new Error(`expect serviceCount number, got ${typeof res.data.serviceCount}`)
  }
  if (typeof res.data.isBusy !== 'boolean') {
    throw new Error(`expect isBusy boolean, got ${typeof res.data.isBusy}`)
  }
}

const CASES = [
  ['list returns only beauticians (not manager)', caseListBeauticians],
  ['list filters resigned beautician', caseListResignedFiltered],
  ['defaultStaff bound → returns mainStaffId/Name', caseDefaultStaffBound],
  ['defaultStaff not bound → mainStaffId=null', caseDefaultStaffNotBound],
  ['detail by employeeId → serviceCount + isBusy', caseDetail],
]

let pass = 0, fail = 0
console.log(`[staff/list-default-detail.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[staff/list-default-detail.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
