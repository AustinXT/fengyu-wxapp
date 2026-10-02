#!/usr/bin/env bun
/**
 * 范围下拉「（已关店）」标记 + 选市场默认门店跳过关店店 · dev 库实测（#422）
 *
 * fixture：市场 A × 门店 A1 / A2（节点均启用），把 A1 置为「只关店」：is_closed=true + closed_at=今天，节点仍启用。
 *   - HQ finance、门店级 manager（绑 A1 + A2，市场 A 不在直接授权里 → 选市场落到门店）
 *
 * 验证：
 *   1. scopeOptions：A1 仍在下拉里且带 closed:true，A2 不带 closed 字段（HQ 与门店级两个视角）
 *   2. 真实 mgmt-scope-picker 组件接真实回包：onPickMarket(A) 默认落 A2（跳过已关店的 A1）
 *   3. A2 也关店 → onPickMarket(A) 回落到第一家 A1
 * 清理：cleanupTestData(NS) 删除全部 TE2LS_ 夹具（含上面改过的门店行）。
 */
import './setup.mjs'
import path from 'node:path'
import { NS, TEST_MARKETS, TEST_STORES_MULTI, closePool, testPhone, pgQuery, REPO_ROOT } from './setup.mjs'
import { createTestOrg, createTestStaffWithRoles, cleanupTestData, invalidateStaffAuthCache } from './helpers/fixtures.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { runSmoke } from './helpers/rbac-asserts.mjs'

// 组件按「开发版」自报 _envVersion=develop；本地云函数连的是 dev 库，语义上就是影子函数，按影子通道放行
process.env.DEPLOY_CHANNEL = 'shadow'

const A1 = TEST_STORES_MULTI.A1
const A2 = TEST_STORES_MULTI.A2
const MKT_A = TEST_MARKETS.A.orgId

/** 加载真实 picker 组件，callStaffApi 桥接到本地云函数（同一 dev 库） */
async function loadPicker(openid) {
  let def = null
  globalThis.Component = (d) => { def = d }
  globalThis.getApp = () => ({ globalData: { managerStoreIds: [] } })
  globalThis.wx = {
    showToast() {},
    getStorageSync() { return '' },
    getAccountInfoSync() { return { miniProgram: { envVersion: 'develop' } } },
    cloud: {
      async callFunction({ data }) {
        return { result: await invokeStaffApi(data.action, { ...data.payload, _testOpenid: openid, _loginLevel: 'management' }) }
      },
    },
  }
  await import(path.join(REPO_ROOT, 'fengyu-staff/miniprogram/components/mgmt-scope-picker/mgmt-scope-picker.ts') + `?t=${Date.now()}`)
  const inst = {
    ...def,
    ...def.methods,
    data: JSON.parse(JSON.stringify(def.data)),
    properties: Object.fromEntries(Object.entries(def.properties).map(([k, v]) => [k, v.value])),
    events: [],
  }
  inst.setData = (u) => {
    for (const [k, v] of Object.entries(u)) {
      const segs = k.split('.')
      let t = inst.data
      for (const s of segs.slice(0, -1)) t = t[s]
      t[segs[segs.length - 1]] = v
    }
  }
  inst.triggerEvent = (name, detail) => inst.events.push({ name, detail })
  return inst
}

function storesOf(resp, marketId) {
  return (resp.data?.markets || []).find((m) => m.id === marketId)?.stores || []
}

async function run() {
  await cleanupTestData(NS)
  await createTestOrg({ markets: ['A'], stores: ['A1', 'A2'] })

  const HQ = { empId: `${NS}_CLOSED_HQ`, oid: `${NS}_CLOSED_HQ_OID`, phone: testPhone(41) }
  const SM = { empId: `${NS}_CLOSED_SM`, oid: `${NS}_CLOSED_SM_OID`, phone: testPhone(42) }
  await createTestStaffWithRoles({
    employeeId: HQ.empId, openid: HQ.oid, phone: HQ.phone, name: `${NS}_HQ财务`,
    storeId: A1.storeId, orgNodeId: A1.orgId,
    bindings: [{ role: 'finance', scopeId: (await pgQuery(`SELECT parent_id FROM org_nodes WHERE id = $1`, [MKT_A]))[0].parent_id }],
  })
  await createTestStaffWithRoles({
    employeeId: SM.empId, openid: SM.oid, phone: SM.phone, name: `${NS}_双店店长`,
    storeId: A1.storeId, orgNodeId: A1.orgId,
    bindings: [{ role: 'manager', scopeId: A1.orgId }, { role: 'manager', scopeId: A2.orgId }],
  })

  // 只关店、节点仍启用
  await pgQuery(
    `UPDATE stores SET is_closed = TRUE, closed_at = (NOW() AT TIME ZONE 'Asia/Shanghai')::date WHERE store_id = $1`,
    [A1.storeId],
  )
  const [node] = await pgQuery(`SELECT is_active FROM org_nodes WHERE id = $1`, [A1.orgId])
  await invalidateStaffAuthCache([HQ.oid, SM.oid])

  const results = []
  const check = (ok, label, reason) => results.push(ok ? { ok, label } : { ok, label, reason })
  check(node?.is_active === true, 'fixture: A1 节点仍启用', `is_active=${node?.is_active}`)

  // 1) scopeOptions 两个视角
  for (const [who, oid] of [['HQ', HQ.oid], ['门店级', SM.oid]]) {
    const r = await invokeStaffApi('mgmtDashboard.scopeOptions', { _testOpenid: oid, _loginLevel: 'management' })
    const list = storesOf(r, MKT_A)
    const a1 = list.find((s) => s.storeId === A1.storeId)
    const a2 = list.find((s) => s.storeId === A2.storeId)
    check(r.code === 0 && a1?.closed === true && a2 && !('closed' in a2),
      `${who}.scopeOptions: A1 closed=true 且仍在下拉，A2 无 closed`,
      `code=${r.code} msg=${r.message} stores=${JSON.stringify(list)}`)
    if (who === '门店级') {
      check(!(r.data?.allowedMarketIds || []).includes(MKT_A), '门店级：市场 A 不在直接授权里', JSON.stringify(r.data?.allowedMarketIds))
      check(list[0]?.storeId === A1.storeId, '下拉按店名排序 A1 在前（跳过逻辑才有意义）', JSON.stringify(list))
    }
  }

  // 2) 真实组件：选市场默认跳过已关店的 A1
  const picker = await loadPicker(SM.oid)
  await picker.loadOptions()
  picker.onPickMarket({ currentTarget: { dataset: { marketId: MKT_A } } })
  check(picker.data.current.scopeType === 'store' && picker.data.current.scopeId === A2.storeId,
    'picker.onPickMarket(A) → 默认落 A2（跳过已关店 A1）', JSON.stringify(picker.data.current))

  // 3) 全关 → 回落第一家
  await pgQuery(
    `UPDATE stores SET is_closed = TRUE, closed_at = (NOW() AT TIME ZONE 'Asia/Shanghai')::date WHERE store_id = $1`,
    [A2.storeId],
  )
  const picker2 = await loadPicker(SM.oid)
  await picker2.loadOptions()
  picker2.onPickMarket({ currentTarget: { dataset: { marketId: MKT_A } } })
  check(picker2.data.current.scopeId === A1.storeId,
    'A1/A2 全关 → onPickMarket(A) 回落第一家 A1', JSON.stringify(picker2.data.current))

  return results
}

await runSmoke('smoke-mgmt-closed-store-label', run, async () => {
  await cleanupTestData(NS)
  const left = await pgQuery(`SELECT COUNT(*)::int AS n FROM stores WHERE store_id LIKE $1`, [`${NS}_%`])
  console.log(`[cleanup] 残留 TE2LS_ 门店行 = ${left[0].n}`)
  await closePool()
})
