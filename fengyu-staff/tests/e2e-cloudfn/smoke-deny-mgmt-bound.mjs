#!/usr/bin/env bun
/**
 * 管理层 mgmt-* 入口准入边界 smoke
 *
 * 覆盖 3 个 case：所有都期望 PERMISSION_DENIED：
 *   1. manager@门店（staffLevel='store_manager'）调 mgmtDashboard.summary(scopeType='all') 应 403
 *      → store_manager 已放开管理层视图（双视图互切，scope.js canAccessManagementLevel），
 *        deny 边界移到 validateManagementScope：店长禁止 'all'/'market' 范围，仅可查所辖门店
 *        → utils/scope.js:206 "店长账号仅可查看所辖门店"
 *   2. finance@门店（staffLevel='store_staff'）调 mgmtCustomer.search 应 403
 *      → requireManagementLevel: canAccessManagementLevel(store_staff)=false → "仅管理层可执行此操作"
 *      — 验证"角色虽是 finance 但绑门店仍不能进 mgmt-*"
 *
 * 同时验证：3) staff@门店 调 mgmtDashboard.scopeOptions 应 403（再保险一次）
 */
import './setup.mjs'
import {
  NS, pgQuery, TEST_STORES_MULTI, closePool, testPhone,
} from './setup.mjs'
import {
  createTestOrg, createTestStaffWithRoles, cleanupTestData, invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'
import { expectFail, runSmoke } from './helpers/rbac-asserts.mjs'

async function run() {
  await cleanupTestData(NS)
  await createTestOrg({ markets: ['A'], stores: ['A1'] })
  const S_A1 = TEST_STORES_MULTI.A1

  const MGR_STORE = { empId: `${NS}_DENY_M_MGR_S`, oid: `${NS}_DENY_M_MGR_S_OID`, phone: testPhone(3) }
  const FIN_STORE = { empId: `${NS}_DENY_M_FIN_S`, oid: `${NS}_DENY_M_FIN_S_OID`, phone: testPhone(4) }
  const STAFF_STORE = { empId: `${NS}_DENY_M_STF_S`, oid: `${NS}_DENY_M_STF_S_OID`, phone: testPhone(5) }

  await createTestStaffWithRoles({
    employeeId: MGR_STORE.empId, openid: MGR_STORE.oid, phone: MGR_STORE.phone, name: `${NS}_店长`,
    storeId: S_A1.storeId, orgNodeId: S_A1.orgId,
    bindings: [{ role: 'manager', scopeId: S_A1.orgId }],
  })
  await createTestStaffWithRoles({
    employeeId: FIN_STORE.empId, openid: FIN_STORE.oid, phone: FIN_STORE.phone, name: `${NS}_门店财务`,
    storeId: S_A1.storeId, orgNodeId: S_A1.orgId,
    bindings: [{ role: 'finance', scopeId: S_A1.orgId }],
  })
  await createTestStaffWithRoles({
    employeeId: STAFF_STORE.empId, openid: STAFF_STORE.oid, phone: STAFF_STORE.phone, name: `${NS}_门店员工`,
    storeId: S_A1.storeId, orgNodeId: S_A1.orgId,
    bindings: [{ role: 'staff', scopeId: S_A1.orgId }],
  })

  await invalidateStaffAuthCache([MGR_STORE.oid, FIN_STORE.oid, STAFF_STORE.oid])
  await pgQuery(`SELECT 1`) // PG 连接池屏障（多笔 INSERT 后避免首次 auth.login 拉空）

  const today = new Date().toISOString().slice(0, 10)
  const results = []

  // 1) manager@门店 试 mgmtDashboard.summary(scopeType='all') → 403
  // 注：双视图互切后 store_manager 可登 management（deriveAvailableLoginLevels 含 management，
  // requireManagementLevel 放行）；deny 边界在 validateManagementScope：店长禁止 'all'/'market'。
  results.push(await expectFail('mgmtDashboard.summary',
    {
      _testOpenid: MGR_STORE.oid, _loginLevel: 'management',
      scopeType: 'all', date: today,
    },
    'PERMISSION_DENIED',
    'store-manager.mgmt.summary.scopeAll (设计意图：店长放开 mgmt 视图但禁止 all/market 范围)'))

  // 2) finance@门店 试 mgmtCustomer.search → 403（绑门店的 finance 不能进 mgmt-*）
  results.push(await expectFail('mgmtCustomer.search',
    {
      _testOpenid: FIN_STORE.oid, _loginLevel: 'management',
      scopeType: 'store', scopeId: S_A1.storeId, keyword: NS,
    },
    'PERMISSION_DENIED',
    'store-finance.mgmt.search (设计意图：绑门店角色不会因为 role=finance 就放行 mgmt)'))

  // 3) staff@门店 试 mgmtDashboard.scopeOptions → 403
  results.push(await expectFail('mgmtDashboard.scopeOptions',
    { _testOpenid: STAFF_STORE.oid, _loginLevel: 'management' },
    'PERMISSION_DENIED',
    'store-staff.mgmt.scopeOptions'))

  return results
}

await runSmoke('smoke-deny-mgmt-bound', run, async () => {
  await cleanupTestData(NS)
  await closePool()
})
