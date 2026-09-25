/**
 * 库存进出明细（#360）冒烟（impl）。由 smoke-inventory-movements.mjs 以
 * `bun --preload _inv-smoke-preload.mjs` 启动，跑在本地 docker 一次性库。
 *
 * 为什么要真库：单测的 mock db 证不了 SQL 本身 —— JOIN 出来的行数、批号/商品编号过滤、
 * 上海日界、对方主体 CASE、以及「同一 created_at 多行时 keyset 翻页不漏不重」都只能在真 PG 上钉。
 *
 * 流水来源：
 *   - 种子入库（insertSeedLot，doc_id 为空）
 *   - 院退货审批（真业务 action，一张单两行 → 同一事务两条出库流水，created_at 相同）
 *   - 调整（直写流水，0009 触发器照常校验前后结存并回写批次）
 *   - 45 条同事务调整（DO 块，created_at 全相同）用于翻页
 */
import path from 'node:path'
import { closePool, pgQuery } from './setup.mjs'
import {
  MKA_ORG, STA1_ID, SKU_SUPPLY,
  cleanupInventoryFixture, ensureInventoryFixture, insertSeedLot, lotQuantity,
  marketASession, storeA1Session, storeA2Session, supplyChainSession,
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
async function expectThrow(name, pattern, fn) {
  try {
    await fn()
    check(name, false, '未抛错（应被拦截）')
  } catch (e) {
    check(name, pattern.test(e.message ?? ''), e.message)
  }
}

/** 原表真相：直接查 inventory_movements，按 id 正序 */
async function rawMovements(where, params) {
  const rows = await pgQuery(
    `SELECT m.id, m.doc_id, m.direction, m.quantity_delta, m.quantity_before, m.quantity_after,
            m.created_at, lot.batch_no
       FROM inventory_movements m
       JOIN inventory_stock_lots lot ON lot.id = m.lot_id
      WHERE ${where}
      ORDER BY m.id`,
    params,
  )
  return rows.map((row) => ({
    id: Number(row.id),
    docId: row.doc_id,
    direction: row.direction,
    quantityDelta: Number(row.quantity_delta),
    quantityBefore: Number(row.quantity_before),
    quantityAfter: Number(row.quantity_after),
    createdAt: new Date(row.created_at).getTime(),
    batchNo: row.batch_no,
  }))
}

const pick = (row) => ({
  id: row.id,
  docId: row.docId,
  direction: row.direction,
  quantityDelta: row.quantityDelta,
  quantityBefore: row.quantityBefore,
  quantityAfter: row.quantityAfter,
})
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function insertAdjustment(lotId, delta, remark) {
  const [lot] = await pgQuery(`SELECT quantity_on_hand FROM inventory_stock_lots WHERE id = $1`, [lotId])
  const before = Number(lot.quantity_on_hand)
  await pgQuery(
    `INSERT INTO inventory_movements (
       movement_key, lot_id, location_id, sku_id, direction,
       quantity_delta, quantity_before, quantity_after, remark
     ) VALUES ($1, $2, $3, $4, '调整', $5, $6, $7, $8)`,
    [`TE2AI-mv-adj:${lotId}:${Date.now()}`, lotId, STA1_ID, SKU_SUPPLY, delta, before, before + delta, remark],
  )
}

try {
  await cleanupInventoryFixture()
  await ensureInventoryFixture()

  const biz = await import(A('src', 'actions', 'inventory', 'business.ts'))
  const mv = await import(A('src', 'actions', 'inventory', 'movements.ts'))
  const { iterateExportPages } = await import(A('src', 'lib', 'export-pagination.ts'))

  const lotPrices = {
    supplyChainUnitCost: 800,
    marketStandardUnitPrice: 1000, marketUnitDiscount: 50, marketActualUnitPrice: 950,
    storeStandardUnitPrice: 1200, storeUnitDiscount: 100, storeActualUnitPrice: 1100,
  }
  const lotA = await insertSeedLot({ locationId: STA1_ID, skuId: SKU_SUPPLY, skuName: 'TE2AI_供应链产品', quantity: 10, batchNo: 'TMV-A', ...lotPrices })
  const lotB = await insertSeedLot({ locationId: STA1_ID, skuId: SKU_SUPPLY, skuName: 'TE2AI_供应链产品', quantity: 6, batchNo: 'TMV-B', ...lotPrices })

  // 院退货：一张单两行（A 退 3、B 退 2），市场审批时同一事务写两条门店出库流水
  setSession(storeA1Session())
  const { id: returnDocId } = await biz.createReturnForRestock({
    sourceOrgNodeId: STA1_ID, targetOrgNodeId: MKA_ORG,
    items: [{ lotId: lotA, quantity: 3, reason: '#360 冒烟' }, { lotId: lotB, quantity: 2, reason: '#360 冒烟' }],
  })
  setSession(marketASession())
  await biz.approveReturnForRestock({ returnDocId, auditRemark: '#360 冒烟' })

  // 调整：A +1（10 - 3 + 1 = 8）
  await insertAdjustment(lotA, 1, '#360 冒烟调整')

  // ════ 按批号：一个批次依次入库 / 出库 / 调整三条 ════
  setSession(storeA1Session())
  const byBatch = await mv.listInventoryMovements({ locationId: STA1_ID, batchNo: 'TMV-A' })
  const rawA = await rawMovements('m.lot_id = $1', [lotA])
  check('按批号返回 3 行（入库 / 出库 / 调整）',
    byBatch.total === 3 && byBatch.rows.length === 3
      && same(byBatch.rows.map((r) => r.direction), ['入库', '出库', '调整']),
    JSON.stringify(byBatch.rows.map((r) => [r.direction, r.quantityDelta, r.quantityBefore, r.quantityAfter])))
  check('方向、数量、前后结存、单号与 inventory_movements 逐行一致',
    same(byBatch.rows.map(pick), rawA.map(pick)), JSON.stringify(rawA.map(pick)))
  const outRow = byBatch.rows.find((r) => r.direction === '出库')
  const [outDoc] = outRow?.docId
    ? await pgQuery(`SELECT doc_type, source_org_node_id FROM inventory_docs WHERE id = $1`, [outRow.docId])
    : []
  check('出库行单号指向院退货相关单据，单据类型与对方主体（市场A）取自 JOIN',
    Boolean(outRow?.docId) && outRow.docType === outDoc?.doc_type && outDoc?.source_org_node_id != null
      && typeof outRow.counterpartyName === 'string' && outRow.counterpartyName.length > 0,
    `doc=${outRow?.docId} type=${outRow?.docType} 对方=${outRow?.counterpartyName}`)
  const seedRow = byBatch.rows[0]
  check('无单据流水（种子入库）单号留空', seedRow.docId === null && seedRow.docType === null, JSON.stringify(seedRow))
  const [lotAFinal] = await pgQuery(`SELECT quantity_on_hand FROM inventory_stock_lots WHERE id = $1`, [lotA])
  check('最后一条流水的变动后结存 = 批次在手量',
    byBatch.rows[2].quantityAfter === Number(lotAFinal.quantity_on_hand) && (await lotQuantity(lotA)) === 8,
    `after=${byBatch.rows[2].quantityAfter} on_hand=${lotAFinal.quantity_on_hand}`)

  // ════ 按商品编号：两个批次的全部流水，带批号 ════
  const bySku = await mv.listInventoryMovements({ locationId: STA1_ID, skuCode: SKU_SUPPLY })
  const rawSku = await rawMovements('m.location_id = $1 AND m.sku_id = $2', [STA1_ID, SKU_SUPPLY])
  check('按商品编号列出两个批次全部流水', bySku.total === rawSku.length
    && same(bySku.rows.map(pick), rawSku.map(pick))
    && new Set(bySku.rows.map((r) => r.batchNo)).size === 2
    && bySku.rows.every((r) => r.batchNo === 'TMV-A' || r.batchNo === 'TMV-B'),
  `total=${bySku.total} raw=${rawSku.length} 批号=${[...new Set(bySku.rows.map((r) => r.batchNo))]}`)
  const sameTxOut = rawSku.filter((r) => r.direction === '出库')
  check('前置：院退货两条出库流水 created_at 相同（同一事务）',
    sameTxOut.length === 2 && sameTxOut[0].createdAt === sameTxOut[1].createdAt, JSON.stringify(sameTxOut))

  // ════ 日期区间（上海自然日）════
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
  const inRange = await mv.listInventoryMovements({ locationId: STA1_ID, batchNo: 'TMV-A', startDate: today, endDate: today })
  const future = await mv.listInventoryMovements({ locationId: STA1_ID, batchNo: 'TMV-A', startDate: '2099-01-01' })
  check('日期区间含今天 → 3 行；起始日在未来 → 0 行', inRange.total === 3 && future.total === 0,
    `today=${today} inRange=${inRange.total} future=${future.total}`)

  // ════ 权限 / 入参 ════
  setSession(storeA2Session())
  await expectThrow('门店A2 查门店A1 → PERMISSION_DENIED', /PERMISSION_DENIED/, () =>
    mv.listInventoryMovements({ locationId: STA1_ID, batchNo: 'TMV-A' }))
  setSession(supplyChainSession())
  await expectThrow('总部 scope 不展开门店 → PERMISSION_DENIED（§9.2）', /PERMISSION_DENIED/, () =>
    mv.listInventoryMovements({ locationId: STA1_ID, batchNo: 'TMV-A' }))
  setSession(storeA1Session())
  await expectThrow('商品编号与批号都为空 → INVALID_PARAMS', /INVALID_PARAMS/, () =>
    mv.listInventoryMovements({ locationId: STA1_ID }))
  await expectThrow('门店库存员无 inventory:export → 导出被拒', /PERMISSION_DENIED/, () =>
    mv.exportInventoryMovements({ location: STA1_ID, sku: SKU_SUPPLY }, { limit: 10 }))

  // ════ keyset 翻页：45 条同一 created_at 的流水 ════
  const lotC = await insertSeedLot({ locationId: STA1_ID, skuId: SKU_SUPPLY, skuName: 'TE2AI_供应链产品', quantity: 1, batchNo: 'TMV-C', ...lotPrices })
  await pgQuery(`
    DO $$
    DECLARE i int; cur numeric;
    BEGIN
      FOR i IN 1..45 LOOP
        SELECT quantity_on_hand INTO cur FROM inventory_stock_lots WHERE id = ${Number(lotC)};
        INSERT INTO inventory_movements (movement_key, lot_id, location_id, sku_id, direction,
               quantity_delta, quantity_before, quantity_after, remark)
        VALUES ('TE2AI-mv-page:' || i || ':' || clock_timestamp(), ${Number(lotC)}, '${STA1_ID}', '${SKU_SUPPLY}', '调整',
                1, cur, cur + 1, '#360 翻页');
      END LOOP;
    END $$`)
  const rawC = await rawMovements('m.lot_id = $1', [lotC])
  const pageTimes = new Set(rawC.slice(1).map((r) => r.createdAt))
  check('前置：TMV-C 共 46 条，其中 45 条 created_at 完全相同', rawC.length === 46 && pageTimes.size === 1,
    `rows=${rawC.length} distinct_created_at=${pageTimes.size}`)

  const forward = []
  let page = await mv.listInventoryMovements({ locationId: STA1_ID, batchNo: 'TMV-C', pageSize: 20 })
  const pageFlags = [[page.hasPrev, page.hasNext]]
  forward.push(...page.rows.map((r) => r.id))
  // 次数上限：游标不推进时干净地红，不死循环
  for (let guard = 0; page.hasNext && guard < 10; guard += 1) {
    page = await mv.listInventoryMovements({
      locationId: STA1_ID, batchNo: 'TMV-C', pageSize: 20, after: String(page.rows[page.rows.length - 1].id),
    })
    pageFlags.push([page.hasPrev, page.hasNext])
    forward.push(...page.rows.map((r) => r.id))
  }
  check('向后翻页（after）不漏行、不重行，顺序同 id 正序',
    same(forward, rawC.map((r) => r.id)) && new Set(forward).size === forward.length,
    `pages=${pageFlags.length} flags=${JSON.stringify(pageFlags)} got=${forward.length}`)
  check('翻页标志：首页无上一页、末页无下一页',
    same(pageFlags[0], [false, true]) && same(pageFlags[pageFlags.length - 1], [true, false]), JSON.stringify(pageFlags))

  const backward = [...page.rows.map((r) => r.id)]
  for (let guard = 0; page.hasPrev && guard < 10; guard += 1) {
    page = await mv.listInventoryMovements({
      locationId: STA1_ID, batchNo: 'TMV-C', pageSize: 20, before: String(page.rows[0].id),
    })
    backward.unshift(...page.rows.map((r) => r.id))
  }
  check('向前翻页（before）同样不漏行、不重行', same(backward, rawC.map((r) => r.id)),
    `got=${backward.length}`)

  // ════ 导出：keyset 分批，行数 = 页面总数 ════
  setSession(marketASession())
  const exported = []
  for await (const row of iterateExportPages((options) =>
    mv.exportInventoryMovements({ location: STA1_ID, sku: SKU_SUPPLY }, { ...options, limit: 7 }))) {
    exported.push(row)
  }
  setSession(storeA1Session())
  const skuTotal = (await mv.listInventoryMovements({ locationId: STA1_ID, skuCode: SKU_SUPPLY })).total
  const rawAll = await rawMovements('m.location_id = $1 AND m.sku_id = $2', [STA1_ID, SKU_SUPPLY])
  check('导出行数 = 页面查询总数，且与原表逐行一致（7 行一批跨页）',
    exported.length === skuTotal && same(exported.map(pick), rawAll.map(pick)),
    `export=${exported.length} total=${skuTotal} raw=${rawAll.length}`)

  // ════ issue 验收 SQL：每个批次最后一条流水 quantity_after = quantity_on_hand ════
  const mismatch = await pgQuery(`
    SELECT l.id, l.batch_no, l.quantity_on_hand, m.quantity_after
      FROM inventory_stock_lots l
      JOIN LATERAL (SELECT quantity_after FROM inventory_movements
                     WHERE lot_id = l.id ORDER BY id DESC LIMIT 1) m ON true
     WHERE m.quantity_after <> l.quantity_on_hand`)
  check('验收 SQL：最后一条流水结存 ≠ 批次在手量的批次 0 行', mismatch.length === 0, JSON.stringify(mismatch))
} catch (e) {
  check('冒烟执行', false, e?.stack ?? String(e))
} finally {
  try {
    await cleanupInventoryFixture()
  } catch (e) {
    report.push(`⚠️ 清理失败：${e.message}`)
  }
  await closePool()
  console.log(report.join('\n'))
  console.log(failed === 0 ? `\n全部通过（${report.length} 项）` : `\n失败 ${failed} 项`)
  process.exit(failed === 0 ? 0 : 1)
}
