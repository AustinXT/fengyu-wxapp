/**
 * 进销存退货双链冒烟（impl）。由 smoke-inventory-returns.mjs 以
 * `bun --preload _inv-smoke-preload.mjs` 启动。
 *
 * 院退货：门店发起（预留来源批次不扣减）→ 市场审批同时出库+回库 → 市场退货入库；
 * 市场退货：市场发起 → 供应链审批 → 供应链退货入库；
 * 驳回：释放预留。真实单价快照随退货流转（说明.md §7.3 后续退货以真实单价为准）。
 */
import path from 'node:path'
import { closePool, pgQuery } from './setup.mjs'
import {
  HQ_ORG, MKA_ORG, MKB_ORG, STA1_ID,
  SKU_SUPPLY,
  cleanupInventoryFixture, ensureInventoryFixture, insertSeedLot,
  docHeader, docItems, locationLots, lotQuantity,
  marketASession, marketBSession, storeA1Session, supplyChainSession,
} from './helpers/inventory-fixtures.mjs'

const __filename = new URL(import.meta.url).pathname
const TESTS_DIR = path.dirname(__filename)
const ADMIN_DIR = path.resolve(TESTS_DIR, '..', '..')
const A = (...p) => 'file://' + path.join(ADMIN_DIR, ...p)

const report = []
let failed = 0
const check = (name, ok, detail = '') => {
  report.push(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}
const setSession = (s) => { globalThis.__INV_SESSION = s }
const num = (v) => (v === null || v === undefined ? null : Number(v))
async function expectThrow(name, pattern, fn) {
  try {
    await fn()
    check(name, false, '未抛错（应被拦截）')
  } catch (e) {
    check(name, pattern.test(e.message ?? ''), e.message)
  }
}
async function reservations(requestDocId) {
  return pgQuery(
    `SELECT status, quantity, fulfilled_quantity, released_quantity
       FROM inventory_stock_reservations WHERE request_doc_id = $1 ORDER BY id`,
    [requestDocId],
  )
}

try {
  await cleanupInventoryFixture()
  await ensureInventoryFixture()

  const biz = await import(A('src', 'actions', 'inventory', 'business.ts'))
  const docs = await import(A('src', 'actions', 'inventory', 'docs.ts'))

  // 种子库存：门店批次（真实单价 1100）、市场批次（真实单价 950）
  const storeLotId = await insertSeedLot({
    locationId: STA1_ID, skuId: SKU_SUPPLY, skuName: 'TE2AI_供应链产品',
    quantity: 10, batchNo: 'RSEED-S',
    supplyChainUnitCost: 800,
    marketStandardUnitPrice: 1000, marketUnitDiscount: 50, marketActualUnitPrice: 950,
    storeStandardUnitPrice: 1200, storeUnitDiscount: 100, storeActualUnitPrice: 1100,
  })
  const marketLotId = await insertSeedLot({
    locationId: MKA_ORG, skuId: SKU_SUPPLY, skuName: 'TE2AI_供应链产品',
    quantity: 8, batchNo: 'RSEED-M',
    supplyChainUnitCost: 800,
    marketStandardUnitPrice: 1000, marketUnitDiscount: 50, marketActualUnitPrice: 950,
    storeStandardUnitPrice: 1200, storeUnitDiscount: 0, storeActualUnitPrice: 1200,
  })
  check('种子库存就位（门店 10 / 市场 8）',
    (await lotQuantity(storeLotId)) === 10 && (await lotQuantity(marketLotId)) === 8, '')

  // ════ 院退货链（门店 → 市场）════
  setSession(storeA1Session())
  await expectThrow('门店只能退回所属市场(§8/流程图)', /INVALID_PARAMS/, () =>
    biz.createReturnForRestock({
      sourceOrgNodeId: STA1_ID, targetOrgNodeId: MKB_ORG,
      items: [{ lotId: storeLotId, quantity: 1 }],
    }))

  const { id: ythId } = await biz.createReturnForRestock({
    sourceOrgNodeId: STA1_ID, targetOrgNodeId: MKA_ORG,
    items: [{ lotId: storeLotId, quantity: 4, reason: '效期临近' }],
  })
  const ythHead = await docHeader(ythId)
  const ythReservations = await reservations(ythId)
  check('院退货建单待审批 + 预留不扣减库存',
    ythHead?.status === '待审批' && ythHead?.market_id === MKA_ORG
      && (await lotQuantity(storeLotId)) === 10
      && ythReservations.length === 1 && ythReservations[0].status === '已预留'
      && num(ythReservations[0].quantity) === 4,
    `${ythId} status=${ythHead?.status} 预留=${JSON.stringify(ythReservations)}`)

  await expectThrow('退货预留占用可用量：再退 7 超出 10-4 被拒', /INVALID_STATE/, () =>
    biz.createReturnForRestock({
      sourceOrgNodeId: STA1_ID, targetOrgNodeId: MKA_ORG,
      items: [{ lotId: storeLotId, quantity: 7 }],
    }))

  await expectThrow('门店库存员无审批权限', /PERMISSION_DENIED/, () =>
    biz.approveReturnForRestock({ returnDocId: ythId }))
  setSession(supplyChainSession())
  await expectThrow('供应链不能替市场审批院退货(§9.2 总部 scope 不下沉)', /PERMISSION_DENIED/, () =>
    biz.approveReturnForRestock({ returnDocId: ythId }))
  setSession(marketBSession())
  check('跨市场看不到他市场院退货(§9.4)', (await docs.getInventoryCoreDocById(ythId)) === null, ythId)

  setSession(marketASession())
  const { id: mtrId } = await biz.approveReturnForRestock({ returnDocId: ythId, auditRemark: '同意退回' })
  const mtrHead = await docHeader(mtrId)
  const [mtrItem] = await docItems(mtrId)
  const marketReturnLots = (await locationLots(MKA_ORG, SKU_SUPPLY))
    .filter((lot) => lot.batch_no === 'RSEED-S')
  const ythAfter = await docHeader(ythId)
  const ythReservationsAfter = await reservations(ythId)
  check('市场审批后生成市场退货入库并完成双向库存变动',
    mtrHead?.doc_type === '市场退货入库' && mtrHead?.status === '已完成'
      && (await lotQuantity(storeLotId)) === 6
      && marketReturnLots.length === 1 && num(marketReturnLots[0]?.quantity_on_hand) === 4,
    `${mtrId} store=${await lotQuantity(storeLotId)} 回库=${marketReturnLots[0]?.quantity_on_hand}`)
  check('退货沿门店真实单价核算(§7.3 退货以真实单价为准)',
    num(marketReturnLots[0]?.store_actual_unit_price) === 1100
      && num(mtrItem?.actual_unit_price) === 1100 && num(mtrItem?.amount) === 4400
      && num(mtrHead?.total_amount) === 4400,
    JSON.stringify({ act: mtrItem?.actual_unit_price, amount: mtrItem?.amount, total: mtrHead?.total_amount }))
  check('院退货完结且预留转已完成',
    ythAfter?.status === '已完成' && ythReservationsAfter[0]?.status === '已完成'
      && num(ythReservationsAfter[0]?.fulfilled_quantity) === 4,
    JSON.stringify(ythReservationsAfter))

  // ════ 驳回链：释放预留 ════
  setSession(storeA1Session())
  const { id: yth2Id } = await biz.createReturnForRestock({
    sourceOrgNodeId: STA1_ID, targetOrgNodeId: MKA_ORG,
    items: [{ lotId: storeLotId, quantity: 2, reason: '包装破损' }],
  })
  setSession(marketASession())
  await biz.rejectReturnForRestock({ returnDocId: yth2Id, auditRemark: '照片不清晰，驳回重报' })
  const yth2Head = await docHeader(yth2Id)
  const yth2Reservations = await reservations(yth2Id)
  check('驳回院退货：单据已驳回 + 预留释放 + 库存不动',
    yth2Head?.status === '已驳回' && yth2Reservations[0]?.status === '已释放'
      && num(yth2Reservations[0]?.released_quantity) === 2
      && (await lotQuantity(storeLotId)) === 6,
    JSON.stringify({ status: yth2Head?.status, reservation: yth2Reservations[0] }))
  setSession(storeA1Session())
  const { id: yth3Id } = await biz.createReturnForRestock({
    sourceOrgNodeId: STA1_ID, targetOrgNodeId: MKA_ORG,
    items: [{ lotId: storeLotId, quantity: 6 }],
  })
  check('释放后的可用量恢复（可再整退 6）', Boolean(yth3Id), yth3Id)
  setSession(marketASession())
  await biz.rejectReturnForRestock({ returnDocId: yth3Id, auditRemark: '回收测试预留' })

  // ════ 市场退货链（市场 → 供应链）════
  setSession(marketASession())
  const { id: mthId } = await biz.createReturnForRestock({
    sourceOrgNodeId: MKA_ORG, targetOrgNodeId: HQ_ORG,
    items: [{ lotId: marketLotId, quantity: 3, reason: '滞销退回' }],
  })
  const mthHead = await docHeader(mthId)
  check('市场退货建单待审批且归属本市场',
    mthHead?.doc_type === '市场退货' && mthHead?.status === '待审批' && mthHead?.market_id === MKA_ORG,
    `${mthId} market_id=${mthHead?.market_id}`)
  await expectThrow('市场不能自审市场退货(§6.2 同源规则：审批在供应链)', /PERMISSION_DENIED/, () =>
    biz.approveReturnForRestock({ returnDocId: mthId }))

  setSession(supplyChainSession())
  const { id: gtrId } = await biz.approveReturnForRestock({ returnDocId: mthId, auditRemark: '同意退回总部' })
  const gtrHead = await docHeader(gtrId)
  const hqReturnLots = (await locationLots(HQ_ORG, SKU_SUPPLY)).filter((lot) => lot.batch_no === 'RSEED-M')
  check('供应链审批后生成供应链退货入库',
    gtrHead?.doc_type === '供应链退货入库' && gtrHead?.status === '已完成'
      && (await lotQuantity(marketLotId)) === 5
      && hqReturnLots.length === 1 && num(hqReturnLots[0]?.quantity_on_hand) === 3,
    `${gtrId} market=${await lotQuantity(marketLotId)} hq=${hqReturnLots[0]?.quantity_on_hand}`)
  check('市场真实单价快照随市场退货回总部',
    num(hqReturnLots[0]?.market_actual_unit_price) === 950
      && num(hqReturnLots[0]?.supply_chain_unit_cost) === 800,
    JSON.stringify({ act: hqReturnLots[0]?.market_actual_unit_price, cost: hqReturnLots[0]?.supply_chain_unit_cost }))
} catch (e) {
  check('冒烟整体', false, '致命错误：' + (e?.stack || e?.message || String(e)))
} finally {
  try {
    await cleanupInventoryFixture()
  } catch (e) {
    check('退场清理', false, e?.message ?? String(e))
  }
  await closePool()
}

console.log('\n──────── 进销存退货双链冒烟报告 ────────')
for (const line of report) console.log(line)
console.log(`────────────────────────────────────\n${failed === 0 ? '全部通过 ✅' : failed + ' 项失败 ❌'}`)
process.exit(failed === 0 ? 0 : 1)
