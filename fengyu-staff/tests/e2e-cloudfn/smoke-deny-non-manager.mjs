#!/usr/bin/env bun
/**
 * 非店长 / 非法 scope 拒绝 smoke
 *
 * 覆盖 3 个 case：所有都期望 PERMISSION_DENIED：
 *   1. finance@门店 调 order.create → middleware/auth.js:273 "仅店长可执行此操作"
 *   2. 给员工绑 type='部门' 的 scope → 迁移 0039 起被 DB trigger 直接拒绝
 *      （没有任何角色的 allowed_scope_types 含 '部门'）。原先"绑上了但 staffLevel=null"
 *      的场景已不可达，本用例改为守护这条约束本身仍然生效。
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
  // 「部门 scope 员工」这个场景自迁移 0039 起在**数据库层**就造不出来了：
  // trigger permission_validate_role_assignment_scope 拿 role 查
  // permission_role_definitions.allowed_scope_types，而没有任何角色允许 '部门'
  // （现矩阵只有 总部/市场/门店）。原 case 3/4 依赖这种绑定已存在，现已不可达。
  // 于是把它翻过来守护约束本身：真去建一次，必须被 DB 拒绝。
  let deptBindingRejected = false
  let deptBindingError = ''
  try {
    await createTestStaffWithRoles({
      employeeId: DEPT_EMP.empId, openid: DEPT_EMP.oid, phone: DEPT_EMP.phone, name: `${NS}_部门绑定员工`,
      storeId: S_A1.storeId, orgNodeId: S_A1.orgId,
      bindings: [{ role: 'manager', scopeId: DEPT_ID }],
    })
  } catch (e) {
    deptBindingError = e.message || ''
    deptBindingRejected = /不能绑定到/.test(deptBindingError)
  }

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

  // 3) 部门 scope 绑定必须被数据库拒绝（迁移 0039 的 trigger）
  results.push({
    ok: deptBindingRejected,
    label: 'dept-scope.binding-rejected-by-db',
    reason: deptBindingRejected
      ? ''
      : `期望建「manager@部门」绑定时被 trigger 拒绝，实际${deptBindingError ? '报错但文案不符: ' + deptBindingError : '建成功了——0039 的 permission_validate_role_assignment_scope 可能被去掉'}`,
  })

  return results
}

await runSmoke('smoke-deny-non-manager', run, async () => {
  await cleanupTestData(NS)
  await closePool()
})
