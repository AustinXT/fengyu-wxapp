#!/usr/bin/env bun
/**
 * 转店审批全链路守护：store.unbindRequests / approveUnbind / rejectUnbind + staff.todoList.pendingUnbindCount
 *
 * 回归守护（2026-06-08 修复）：店长查询/审批转店申请必须用 ctx.auth.effectiveStoreId（当前操作门店），
 * 而非 ctx.auth.storeId（员工档案默认门店）。两者在「档案 store_id 为空 / 多门店切店」时分叉，
 * 错用 storeId 会让店长收不到任何待审批转店申请（列表空、待办计数恒 0、审批被误拒 PERMISSION_DENIED）。
 *
 * 本测试特意把店长档案 store_id 置 null（最常见真实场景：档案未设默认门店），仅靠 manager 角色绑定
 * + _currentStoreId 派生 effectiveStoreId=A1。若代码回退用 storeId(null)，下方 T1~T4 全部失败。
 * （旧版本仅"调用不崩溃 + 空列表合理"，store_id 恰好 = 管理门店，无法暴露该 bug。）
 */
import './setup.mjs'
import { NS, TEST_STORES_MULTI, testPhone, pgQuery, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  createTestOrg, createTestStaffWithRoles, createTestClient,
  invalidateStaffAuthCache, cleanupTestData,
} from './helpers/fixtures.mjs'

const MGR_OPENID = `${NS}_UNBIND_MGR_OID`
const MGR_EMP = `${NS}_UNBIND_MGR`
const CLI1 = `${NS}_UNBIND_CLI1`
const CLI2 = `${NS}_UNBIND_CLI2`
const REQ1 = `${NS}_UNBIND_REQ1`
const REQ2 = `${NS}_UNBIND_REQ2`

const A1 = TEST_STORES_MULTI.A1 // from 店（店长管辖）
const A2 = TEST_STORES_MULTI.A2 // to 店（转店目标）

let pass = 0
let fail = 0
function ok(name) { pass++; console.log(`  ✅ ${name}`) }
function bad(name, detail) { fail++; console.log(`  ✗ FAIL ${name} — ${detail}`) }

// store_unbind_requests 不在 cleanupTestData 覆盖范围内，且其 FK 引用 stores/clients，
// 必须先于 cleanupTestData 删除，否则残留申请会阻塞门店/顾客的级联清理。
async function cleanupUnbind() {
  await pgQuery(
    `DELETE FROM store_unbind_requests WHERE from_store_id LIKE $1 OR to_store_id LIKE $1 OR user_id LIKE $1`,
    [`${NS}%`],
  )
}

async function insertPendingRequest(reqId, userId, fromStore, toStore) {
  await pgQuery(
    `INSERT INTO store_unbind_requests (request_id, user_id, from_store_id, to_store_id, status, note)
     VALUES ($1, $2, $3, $4, '待处理', $5)
     ON CONFLICT (request_id) DO UPDATE
       SET status = '待处理', from_store_id = EXCLUDED.from_store_id, to_store_id = EXCLUDED.to_store_id`,
    [reqId, userId, fromStore, toStore, `${NS}_转店原因`],
  )
}

async function main() {
  console.log(`[smoke-store-unbind] start`)
  await cleanupUnbind()
  await cleanupTestData(NS)

  // ── setup：A1/A2 门店 + 档案无默认门店的店长(store_id=null) + 两顾客 + 两条 pending 申请 ──
  await createTestOrg({ markets: ['A'], stores: ['A1', 'A2'] })
  await createTestStaffWithRoles({
    employeeId: MGR_EMP,
    openid: MGR_OPENID,
    phone: testPhone(3),
    name: `${NS}_无默认门店店长`,
    storeId: null, // ← 关键：制造 storeId(null) ≠ effectiveStoreId(A1)
    orgNodeId: A1.orgId,
    positionName: '门店经理',
    bindings: [{ role: 'manager', scopeId: A1.orgId }],
  })
  await invalidateStaffAuthCache(MGR_OPENID)

  await createTestClient({ userId: CLI1, openid: `${CLI1}_OID`, phone: testPhone(4), boundStoreId: A1.storeId, name: `${NS}_顾客1` })
  await createTestClient({ userId: CLI2, openid: `${CLI2}_OID`, phone: testPhone(5), boundStoreId: A1.storeId, name: `${NS}_顾客2` })
  await insertPendingRequest(REQ1, CLI1, A1.storeId, A2.storeId)
  await insertPendingRequest(REQ2, CLI2, A1.storeId, A2.storeId)

  // 前端 callStaffApi 自动附加 _currentStoreId（当前选中门店）→ 后端派生 effectiveStoreId
  const authP = { _testOpenid: MGR_OPENID, _currentStoreId: A1.storeId }

  // ── T1: staff.todoList.pendingUnbindCount 计入本门店待审批申请 ──
  const todo = await invokeStaffApi('staff.todoList', { ...authP })
  if (todo.code === 0 && Number(todo.data?.pendingUnbindCount) >= 2) {
    ok(`todoList.pendingUnbindCount=${todo.data.pendingUnbindCount} (≥2)`)
  } else {
    bad('todoList pendingUnbindCount', `code=${todo.code} count=${todo.data?.pendingUnbindCount} msg=${todo.message}`)
  }

  // ── T2: store.unbindRequests 列表能查到本门店两条申请 ──
  const list = await invokeStaffApi('store.unbindRequests', { ...authP })
  const ids = (list.data?.requests || []).map((r) => r.requestId)
  if (list.code === 0 && ids.includes(REQ1) && ids.includes(REQ2)) {
    ok(`unbindRequests 含 REQ1+REQ2 (${ids.length} 条)`)
  } else {
    bad('unbindRequests 列表', `code=${list.code} ids=${JSON.stringify(ids)} msg=${list.message}`)
  }

  // ── T3: approveUnbind 通过 → 顾客绑定门店 A1→A2，申请置已通过 ──
  const appr = await invokeStaffApi('store.approveUnbind', { ...authP, requestId: REQ1 })
  if (appr.code === 0) {
    const [reqRow] = await pgQuery(`SELECT status FROM store_unbind_requests WHERE request_id = $1`, [REQ1])
    const [cliRow] = await pgQuery(`SELECT bound_store_id FROM client_wechat_users WHERE user_id = $1`, [CLI1])
    if (reqRow?.status === '已通过' && cliRow?.bound_store_id === A2.storeId) {
      ok('approveUnbind → 已通过 + bound_store_id 转 A2')
    } else {
      bad('approveUnbind 副作用', `status=${reqRow?.status} bound=${cliRow?.bound_store_id}`)
    }
  } else {
    bad('approveUnbind', `code=${appr.code} msg=${appr.message}`)
  }

  // ── T4: rejectUnbind 拒绝 → 申请置已拒绝 ──
  const rej = await invokeStaffApi('store.rejectUnbind', { ...authP, requestId: REQ2, rejectReason: `${NS}_不符合条件` })
  if (rej.code === 0) {
    const [reqRow] = await pgQuery(`SELECT status FROM store_unbind_requests WHERE request_id = $1`, [REQ2])
    if (reqRow?.status === '已拒绝') ok('rejectUnbind → 已拒绝')
    else bad('rejectUnbind 副作用', `status=${reqRow?.status}`)
  } else {
    bad('rejectUnbind', `code=${rej.code} msg=${rej.message}`)
  }
}

let exitCode = 1
try {
  await main()
  exitCode = fail === 0 && pass > 0 ? 0 : 1
} catch (e) {
  console.error('EXCEPTION:', e.stack || e.message)
} finally {
  try { await cleanupUnbind() } catch {}
  try { await cleanupTestData(NS) } catch {}
  await closePool()
  console.log(`end | ${fail === 0 && pass > 0 ? 'PASS' : 'FAIL'} | pass=${pass} fail=${fail} | exit=${exitCode}`)
  process.exit(exitCode)
}
