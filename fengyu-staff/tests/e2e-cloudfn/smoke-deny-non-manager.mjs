#!/usr/bin/env bun
/**
 * 非店长 / 非法 scope 拒绝 smoke
 *
 * 覆盖 3 个 case：所有都期望 PERMISSION_DENIED：
 *   1. finance@门店 调 order.create → middleware/auth.js:273 "仅店长可执行此操作"
 *   2. 给员工绑 type='部门' 的 scope → staffLevel=null（scope.js:43 部门级被忽略）
 *      → 调任何业务 action 应被 requireManager 或类似中间件拒绝
 *   3. customer_mgr@门店 调 order.create → 同 case 1（覆盖另一个非 manager 角色）
 */
import './setup.mjs'
import {
  NS, pgQuery, TEST_HQ_ORG_ID, TEST_STORES_MULTI, closePool, testPhone,
} from './setup.mjs'
import {
  createTestOrg, createTestDeptNode, createTestStaffWithRoles, createTestClient,
  cleanupTestData, invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { expectFail, runSmoke } from './helpers/rbac-asserts.mjs'

async function run() {
  await cleanupTestData(NS)
  await createTestOrg({ markets: ['A'], stores: ['A1'] })
  const S_A1 = TEST_STORES_MULTI.A1

  // 部门节点（挂在 HQ 下面）
  const DEPT_ID = `${NS}_DENY_NM_DEPT`
  await createTestDeptNode({ deptId: DEPT_ID, parentId: TEST_HQ_ORG_ID, name: `${NS}_财务部` })

  const FIN_STORE = { empId: `${NS}_DENY_NM_FIN`, oid: `${NS}_DENY_NM_FIN_OID`, phone: testPhone(3) }
  const CM_STORE = { empId: `${NS}_DENY_NM_CM`,  oid: `${NS}_DENY_NM_CM_OID`,  phone: testPhone(4) }
  const DEPT_EMP = { empId: `${NS}_DENY_NM_DEP`, oid: `${NS}_DENY_NM_DEP_OID`, phone: testPhone(5) }

  await createTestStaffWithRoles({
    employeeId: FIN_STORE.empId, openid: FIN_STORE.oid, phone: FIN_STORE.phone, name: `${NS}_门店财务`,
    storeId: S_A1.storeId, orgNodeId: S_A1.orgId,
    bindings: [{ role: 'finance', scopeId: S_A1.orgId }],
  })
  await createTestStaffWithRoles({
    employeeId: CM_STORE.empId, openid: CM_STORE.oid, phone: CM_STORE.phone, name: `${NS}_门店客服主管`,
    storeId: S_A1.storeId, orgNodeId: S_A1.orgId,
    bindings: [{ role: 'customer_mgr', scopeId: S_A1.orgId }],
  })
  // 这名员工 binding 在 type='部门' scope 上 — utils/scope.js 会忽略它，staffLevel=null
  await createTestStaffWithRoles({
    employeeId: DEPT_EMP.empId, openid: DEPT_EMP.oid, phone: DEPT_EMP.phone, name: `${NS}_部门绑定员工`,
    storeId: S_A1.storeId, orgNodeId: S_A1.orgId,
    bindings: [{ role: 'manager', scopeId: DEPT_ID }],
  })

  const CLI = `${NS}_DENY_NM_CLI`
  await createTestClient({
    userId: CLI, openid: `${NS}_DENY_NM_CLI_OID`,
    phone: testPhone(6), boundStoreId: S_A1.storeId,
  })

  await invalidateStaffAuthCache([FIN_STORE.oid, CM_STORE.oid, DEPT_EMP.oid])
  await pgQuery(`SELECT 1`) // PG 连接池屏障（多笔 INSERT 后避免首次 auth.login 拉空）

  const results = []
  const minimalCreate = {
    storeId: S_A1.storeId,
    items: [{ skuId: 'no-such-sku', quantity: 1 }],
    customerId: CLI,
  }

  // 1) finance@门店 调 order.create → PERMISSION_DENIED 仅店长可执行
  results.push(await expectFail('order.create',
    { ...minimalCreate, _testOpenid: FIN_STORE.oid },
    'PERMISSION_DENIED',
    'finance-store.order.create'))

  // 2) customer_mgr@门店 调 order.create → 同
  results.push(await expectFail('order.create',
    { ...minimalCreate, _testOpenid: CM_STORE.oid },
    'PERMISSION_DENIED',
    'customer_mgr-store.order.create'))

  // 3) 部门 scope 员工：先验证 auth.login 返回 staffLevel=null
  const loginR = await invokeStaffApi('auth.login', { _testOpenid: DEPT_EMP.oid })
  if (loginR.code !== 0) {
    results.push({ ok: false, label: 'dept-scope.auth.login', reason: `code=${loginR.code} ${loginR.message}` })
  } else if (loginR.data?.staffLevel !== null) {
    results.push({
      ok: false, label: 'dept-scope.staffLevel',
      reason: `expected null (部门 scope 不归并), got ${loginR.data?.staffLevel}; roleBindings=${JSON.stringify(loginR.data?.roleBindings)}`,
    })
  } else {
    results.push({ ok: true, label: 'dept-scope.auth.login.staffLevel=null' })
  }

  // 4) 部门 scope 员工调 order.create → PERMISSION_DENIED
  results.push(await expectFail('order.create',
    { ...minimalCreate, _testOpenid: DEPT_EMP.oid },
    'PERMISSION_DENIED',
    'dept-scope.order.create'))

  return results
}

await runSmoke('smoke-deny-non-manager', run, async () => {
  await cleanupTestData(NS)
  await closePool()
})
