/**
 * 跨端「按回款分配」一致性守护测试（no-shared-cloudfunctions 约定）
 *
 * 「按回款逐笔分配」捕获 helper capturePaymentAllocatables / refreshOrderAllocationRollup
 * 是四端独立副本（admin TS + staffApi/clientApi/payNotify 三个 pg 版），外加 payNotify
 * 内联的线上自动分配 autoAllocateOnlinePayment。本测试直接 readFileSync 比对源文件，
 * 任一端语义漂移即触发失败，提示维护者同步其它端。
 *
 * 守护对象与断言：
 *   1. staff / payNotify / clientApi 三个 pg 版 capturePaymentAllocatables 函数体字面一致
 *      （剥离各文件头注释块后，比较 capturePaymentAllocatables 核心代码相等）。
 *   2. 四端（含 admin src/lib/payment-allocatable.ts）都含关键不变片段：
 *        - INSERT INTO sale_payment_item_receipts ... ON CONFLICT (sale_payment_id, sale_item_id) DO UPDATE
 *        - 非定向按 pending_received − 已记 receipt amount 剩余实付比例摊
 *        - UPDATE sale_order_payments SET allocation_status='待分配'
 *        - guard：仅「销售单/转换单」+ 排除 legacy（legacy_source==='workfine'）
 *   3. payNotify autoAllocateOnlinePayment 写 sale_payment_item_allocations 子分配 +
 *      提成档位基准为 eventAmount（本次回款额）。
 *   4. payNotify index.js 运行时源码不再写旧 sale_allocations / 旧约束名。
 *
 * 风格参照 cross-end-sql-snapshot.test.js / cross-end-refund-freeze-notify-snapshot.test.js。
 */
const fs = require('node:fs')
const path = require('node:path')

const ARCHIVED_MIGRATIONS_DIR = path.resolve(
  __dirname,
  '../../../../../db/migrations/_archive_pre_baseline_20260806/sql',
)

const FILES = {
  staffCaptureJs: path.resolve(__dirname, '../../utils/payment-allocatable.js'),
  clientCaptureJs: path.resolve(
    __dirname,
    '../../../../../fengyu-client/cloudfunctions/clientApi/utils/payment-allocatable.js',
  ),
  payNotifyCaptureJs: path.resolve(
    __dirname,
    '../../../../../fengyu-client/cloudfunctions/payNotify/payment-allocatable.js',
  ),
  adminCaptureTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/payment-allocatable.ts'),
  receiptMigration0082Sql: path.join(ARCHIVED_MIGRATIONS_DIR, '0082_harsh_firebird.sql'),
  positiveReceiptRebuild0083Sql: path.join(ARCHIVED_MIGRATIONS_DIR, '0083_positive_receipt_rebuild.sql'),
  clearFullRefundStatus0084Sql: path.join(ARCHIVED_MIGRATIONS_DIR, '0084_clear_full_refund_allocation_status.sql'),
  refundReceiptExistingBackfill0085Sql: path.join(ARCHIVED_MIGRATIONS_DIR, '0085_refund_receipt_existing_backfill.sql'),
  overpayReceiptItemBackfill0086Sql: path.join(ARCHIVED_MIGRATIONS_DIR, '0086_overpay_receipt_item_backfill.sql'),
  overpayReceiptItemRemap0090Sql: path.join(ARCHIVED_MIGRATIONS_DIR, '0090_remap_overpay_receipts_by_item_excess.sql'),
  overpayReceiptDrain0029Sql: path.resolve(__dirname, '../../../../../db/migrations/0029_repair_overpay_item_receipts.sql'),
  refundRolePoolRepair0036Sql: path.resolve(__dirname, '../../../../../db/migrations/0036_repair_refund_role_pool_allocations.sql'),
  refundAllocationMirrorBackfill0087Sql: path.join(ARCHIVED_MIGRATIONS_DIR, '0087_refund_allocation_mirror_backfill.sql'),

  payNotifyIndexJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/payNotify/index.js'),
  staffOrderJs: path.resolve(__dirname, '../../routes/order.js'),
  adminRefundsTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/refunds.ts'),
}

function readFile(p) {
  return fs.readFileSync(p, 'utf8')
}

/**
 * 提取命名函数体（含函数签名），用大括号配对截取。
 * 先以圆括号配对跳过参数列表（兼容解构参数 `{ a, b }`），再以大括号配对截取函数体。
 * 适用于 `async function NAME(...) { ... }`（含前缀 export）。
 */
function extractFnBody(src, name) {
  const re = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const m = re.exec(src)
  if (!m) throw new Error(`未找到函数 ${name}`)
  const start = m.index
  let i = src.indexOf('(', start)
  // 跳过参数列表（圆括号配对；解构参数里的 {} 在此仅作普通字符）
  let pdepth = 0
  for (; i < src.length; i++) {
    if (src[i] === '(') pdepth++
    else if (src[i] === ')') {
      pdepth--
      if (pdepth === 0) {
        i++
        break
      }
    }
  }
  const bodyStart = src.indexOf('{', i)
  if (bodyStart < 0) throw new Error(`函数 ${name} 缺少函数体起始 {`)
  let bdepth = 0
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') bdepth++
    else if (src[j] === '}') {
      bdepth--
      if (bdepth === 0) return src.slice(start, j + 1)
    }
  }
  throw new Error(`函数 ${name} 大括号未闭合`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 断言 1：三个 pg 版 capturePaymentAllocatables 函数体字面一致
// ─────────────────────────────────────────────────────────────────────────────
describe('断言1：staff / clientApi / payNotify 三个 pg 版 capturePaymentAllocatables 函数体字面一致', () => {
  let staffBody, clientBody, payNotifyBody

  beforeAll(() => {
    staffBody = extractFnBody(readFile(FILES.staffCaptureJs), 'capturePaymentAllocatables')
    clientBody = extractFnBody(readFile(FILES.clientCaptureJs), 'capturePaymentAllocatables')
    payNotifyBody = extractFnBody(readFile(FILES.payNotifyCaptureJs), 'capturePaymentAllocatables')
  })

  test('三端函数体均非空（成功提取）', () => {
    expect(staffBody.length).toBeGreaterThan(100)
    expect(clientBody.length).toBeGreaterThan(100)
    expect(payNotifyBody.length).toBeGreaterThan(100)
  })

  test('staff vs clientApi 函数体字面相等（漂移 → fail，提示同步）', () => {
    expect(clientBody).toBe(staffBody)
  })

  test('staff vs payNotify 函数体字面相等（漂移 → fail，提示同步）', () => {
    expect(payNotifyBody).toBe(staffBody)
  })

  test('Snapshot 守护：canonical capturePaymentAllocatables 函数体文本快照', () => {
    expect(staffBody).toMatchSnapshot()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 断言 2：四端（含 admin TS）关键不变片段
// ─────────────────────────────────────────────────────────────────────────────
describe('断言2：四端 capturePaymentAllocatables 关键不变片段（含 admin TS 版）', () => {
  const ENDS = () => [
    ['staff', readFile(FILES.staffCaptureJs)],
    ['clientApi', readFile(FILES.clientCaptureJs)],
    ['payNotify', readFile(FILES.payNotifyCaptureJs)],
    ['admin', readFile(FILES.adminCaptureTs)],
  ]

  test('四端均含 INSERT INTO sale_payment_item_receipts ... ON CONFLICT (sale_payment_id, sale_item_id) DO UPDATE', () => {
    const re =
      /INSERT INTO sale_payment_item_receipts[\s\S]{0,500}ON CONFLICT \(sale_payment_id, sale_item_id\)[\s\S]{0,160}DO UPDATE SET amount = EXCLUDED\.amount/
    for (const [end, src] of ENDS()) {
      expect(src, `${end} 缺 INSERT ... ON CONFLICT DO UPDATE upsert`).toMatch(re)
    }
  })

  test('四端非定向均按两段式瀑布（pend_cap = pending_received − 已记 amount；溢出再按 sale_cap）摊', () => {
    // 2026-06-28 重构：非定向分摊从单段「剩余实付比例」改为两段式瀑布（与 recalcPaidSessionsForOrder STEP1 数学一致）
    //   第一段产能 pend_cap_i = max(0, pending_received_i − prior_allocated_i)（剩余实付）
    //   第二段产能 sale_cap_i = max(0, sale_amount_i − max(pending_received_i, prior_allocated_i))（应付余量）
    for (const [end, src] of ENDS()) {
      // prior 已记可分配额（sale_payment_item_receipts 合计）
      expect(src, `${end} 缺 prior = priorMap.get(...) || 0`).toMatch(
        /const prior = priorMap\.get\(i\.sale_item_id\)\s*\|\|\s*0/,
      )
      // pending_received 取数
      expect(src, `${end} 缺 pending = Number(i.pending_received)`).toMatch(
        /const pending = Number\(i\.pending_received\)/,
      )
      // 第一段产能 pend_cap = pending − prior（剩余实付）
      expect(src, `${end} 缺 pendCap 公式 (pending - prior)`).toMatch(
        /pendCap:\s*Math\.max\(0,\s*roundCents\(pending\s*-\s*prior\)\)/,
      )
      // 第二段产能 sale_cap = sale_amount − max(pending, prior)（应付余量）
      expect(src, `${end} 缺 saleCap 公式 (saleAmt - Math.max(pending, prior))`).toMatch(
        /saleCap:\s*Math\.max\(0,\s*roundCents\(saleAmt\s*-\s*Math\.max\(pending,\s*prior\)\)\)/,
      )
      // 两段式分摊：phase1 按 pendCap、phase2 按 saleCap
      expect(src, `${end} 缺 phase1 按 pendCap 铺`).toMatch(/cap:\s*c\.pendCap/)
      expect(src, `${end} 缺 phase2 按 saleCap 铺`).toMatch(/cap:\s*c\.saleCap/)
      // 剩余实付来源：sale_payment_item_receipts 已记正向 receipt 合计（退款 receipt 不进入后续回款捕获）
      expect(src, `${end} 缺已记正向可分配额合计查询`).toMatch(
        /COALESCE\(SUM\(spir\.amount::numeric\), 0\) AS allocated[\s\S]{0,140}FROM sale_payment_item_receipts spir/,
      )
      expect(src, `${end} 缺正向已支付流水过滤`).toMatch(
        /sop\.status = '已支付'[\s\S]{0,80}sop\.change_type IN \('首次支付','回款','储值卡抵扣'\)/,
      )
    }
  })

  test("四端均置回款主流水行 UPDATE sale_order_payments SET allocation_status='待分配'", () => {
    const re = /UPDATE\s+sale_order_payments[\s\S]{0,120}SET\s+allocation_status\s*=\s*'待分配'/
    for (const [end, src] of ENDS()) {
      expect(src, `${end} 缺 allocation_status='待分配' 置位`).toMatch(re)
    }
  })

  test('四端转换单兜底一致：无「购买」行时取全部「转出/转入」行按 sale_amount 有符号比例摊 receipt', () => {
    for (const [end, src] of ENDS()) {
      expect(src, `${end} 缺转换单 items.length === 0 兜底分支`).toMatch(/items\.length === 0/)
      expect(src, `${end} 缺转换单 item_direction IN ('转出', '转入') 兜底`).toMatch(/item_direction IN \('转出', '转入'\)/)
      expect(src, `${end} 转换单兜底仍残留 LIMIT 1`).not.toMatch(/item_direction IN \('转出', '转入'\)[\s\S]{0,120}LIMIT 1/)
      expect(src, `${end} 缺转换单 SELECT sale_amount（按比例摊需取 sale_amount）`).toMatch(/SELECT sale_item_id, sale_amount::numeric AS sale_amount, sales_category[\s\S]{0,120}item_direction IN \('转出', '转入'\)/)
      expect(src, `${end} 缺转换单有符号最大余数法`).toMatch(/allocateSignedCents[\s\S]{0,240}weightCents:\s*Math\.round\(Number\(r\.sale_amount\) \* 100\)/)
    }
  })

  test('四端 guard 一致：仅「销售单/转换单」+ 排除 legacy（workfine）', () => {
    for (const [end, src] of ENDS()) {
      expect(src, `${end} 缺销售单/转换单白名单`).toMatch(/ALLOCATABLE_ORDER_TYPES = \['销售单', '转换单'\]/)
      expect(src, `${end} 缺 legacy(workfine) 排除`).toMatch(/legacy_source === 'workfine'/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 断言 3：payNotify autoAllocateOnlinePayment 新约束 + sale_payment_id + eventAmount 档位
// ─────────────────────────────────────────────────────────────────────────────
describe('断言3：payNotify autoAllocateOnlinePayment 语义守护', () => {
  let autoBody

  beforeAll(() => {
    autoBody = extractFnBody(readFile(FILES.payNotifyIndexJs), 'autoAllocateOnlinePayment')
  })

  test('用 receipt_id + employee_id + role_type 做子分配幂等', () => {
    expect(autoBody).toMatch(/ON CONFLICT \(sale_payment_item_receipt_id, employee_id, role_type\) WHERE is_void = false DO NOTHING/)
  })

  test('INSERT sale_payment_item_allocations 写入 sale_payment_item_receipt_id 列', () => {
    expect(autoBody).toMatch(/INSERT INTO sale_payment_item_allocations[\s\S]{0,220}sale_payment_item_receipt_id/)
  })

  test('提成档位基准为 eventAmount（本次回款额）', () => {
    expect(autoBody).toMatch(/lookupSalesRate\(roleType, salesCategory, eventAmount\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 断言 4：payNotify index.js 运行时源码不残留旧 sale_allocations / 旧约束名
// ─────────────────────────────────────────────────────────────────────────────
describe('断言4：payNotify index.js 不再写旧 sale_allocations / 旧约束名', () => {
  test('全文不含旧约束名 uq_sale_alloc_item_emp_role 与 INSERT INTO sale_allocations', () => {
    const src = readFile(FILES.payNotifyIndexJs)
    expect(src).not.toMatch(/uq_sale_alloc_item_emp_role/)
    expect(src).not.toMatch(/INSERT INTO sale_allocations/)
    expect(src).toMatch(/INSERT INTO sale_payment_item_allocations/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 断言 5：退款审批后按 paid_sessions 净额收敛待分配状态
// ─────────────────────────────────────────────────────────────────────────────
describe('断言5：退款审批后重算 paid_sessions，再收敛营业额分配状态', () => {
  test('四端 payment-allocatable 均实现 reconcileAllocationStatusAfterRefund', () => {
    for (const [end, src] of [
      ['staff', readFile(FILES.staffCaptureJs)],
      ['clientApi', readFile(FILES.clientCaptureJs)],
      ['payNotify', readFile(FILES.payNotifyCaptureJs)],
      ['admin', readFile(FILES.adminCaptureTs)],
    ]) {
      expect(src, `${end} 缺 reconcileAllocationStatusAfterRefund`).toMatch(/reconcileAllocationStatusAfterRefund/)
      expect(src, `${end} 缺按 receipt 判断待分配`).toMatch(/FROM sale_payment_item_receipts spir/)
      expect(src, `${end} 缺子分配存在性判断`).toMatch(/FROM sale_payment_item_allocations spia/)
      expect(src, `${end} 缺非零 receipt 门控`).toMatch(/spir\.amount::numeric <> 0/)
      expect(src, `${end} 缺待分配收敛为已分配`).toMatch(/SET allocation_status = '已分配'/)
      expect(src, `${end} 缺全额退款净实收为 0 时清空 payment allocation_status`).toMatch(/full_refund_zero_net[\s\S]{0,420}SET allocation_status = NULL/)
      expect(src, `${end} 缺全额退款净实收判断`).toMatch(/GREATEST\(COALESCE\(so\.received::numeric, 0\) - COALESCE\(so\.refunded_amount::numeric, 0\), 0\) <= 0\.01/)
      expect(src, `${end} 缺订单 rollup 无回款状态时清空父订单状态`).toMatch(/ELSE NULL::allocation_status END/)
    }
  })

  test('staff/admin approveRefund 均在 recalcPaidSessionsForOrder 后调用 reconcileAllocationStatusAfterRefund', () => {
    const cases = [
      ['staff', readFile(FILES.staffOrderJs), 'await recalcPaidSessionsForOrder(client, refSaleOrderId)', 'await reconcileAllocationStatusAfterRefund(client, refSaleOrderId)'],
      ['admin', readFile(FILES.adminRefundsTs), 'await recalcPaidSessionsForOrder(tx, refSaleOrderId)', 'await reconcileAllocationStatusAfterRefund(tx, refSaleOrderId)'],
    ]
    for (const [end, src, recalc, reconcile] of cases) {
      const recalcIdx = src.indexOf(recalc)
      const reconcileIdx = src.indexOf(reconcile)
      expect(recalcIdx, `${end} 缺退款后 paid_sessions 重算`).toBeGreaterThan(-1)
      expect(reconcileIdx, `${end} 缺退款后分配状态收敛`).toBeGreaterThan(-1)
      expect(reconcileIdx, `${end} 必须先重算 paid_sessions 再收敛分配状态`).toBeGreaterThan(recalcIdx)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 断言 6：0082 receipt 迁移用实际退款额回填，禁止用旧 allocatable 冲销额伪造退款 receipt
// ─────────────────────────────────────────────────────────────────────────────
describe('断言6：0082 退款 receipt backfill 使用 note.items[].refundAmount 实退额', () => {
  let src

  beforeAll(() => {
    src = readFile(FILES.receiptMigration0082Sql)
  })

  test('旧 sale_payment_allocatable_items 回填不再处理退款流水', () => {
    expect(src).not.toMatch(/WHEN\s+sop\.change_type\s*=\s*'退款'\s+THEN\s+-ABS\(spai\.amount::numeric\)/)
    expect(src).toMatch(/FROM sale_payment_allocatable_items spai[\s\S]{0,420}WHERE sop\.change_type IN \('首次支付','回款','储值卡抵扣'\)/)
  })

  test('旧 sale_allocations 派生 receipt 回填不再处理退款流水', () => {
    expect(src).not.toMatch(/WHEN\s+sop\.change_type\s*=\s*'退款'\s+THEN\s+-ABS\(MAX\(ABS\(sa\.total_amount::numeric/)
    expect(src).toMatch(/WITH explicit_alloc_receipts AS \([\s\S]{0,900}AND sop\.change_type IN \('首次支付','回款','储值卡抵扣'\)/)
  })

  test('退款 receipt 单独从 note.items[].refundAmount 回填，并排除 OVERPAY 哨兵行', () => {
    expect(src).toMatch(/WITH note_refund_items AS \(/)
    expect(src).toMatch(/elem ->> 'refSaleItemId' AS sale_item_id/)
    expect(src).toMatch(/COALESCE\(\(elem ->> 'refundAmount'\)::numeric, 0\) AS refund_amount/)
    expect(src).toMatch(/sop\.change_type = '退款'[\s\S]{0,80}sop\.status = '已支付'/)
    expect(src).toMatch(/elem ->> 'refSaleItemId' <> 'OVERPAY'/)
  })

  test('无 note.items 的旧单项退款用 ref_sale_item_id + ABS(amount) 兜底', () => {
    expect(src).toMatch(/legacy_single_refund_items AS \(/)
    expect(src).toMatch(/sop\.ref_sale_item_id AS sale_item_id/)
    expect(src).toMatch(/ABS\(sop\.amount::numeric\) AS refund_amount/)
    expect(src).toMatch(/NOT EXISTS \([\s\S]{0,120}note_refund_items nri/)
  })

  test('退款 receipt upsert 必须用实际退款额覆盖旧值', () => {
    expect(src).toMatch(/refund_receipts AS \([\s\S]{0,900}-ABS\(SUM\(ri\.refund_amount\)\) AS amount/)
    expect(src).toMatch(/INSERT INTO sale_payment_item_receipts[\s\S]{0,520}FROM refund_receipts[\s\S]{0,220}ON CONFLICT \(sale_payment_id, sale_item_id\)[\s\S]{0,120}DO UPDATE SET amount = EXCLUDED\.amount/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 断言 7：0082 正向 receipt 按实际 payment.amount 重建逐笔归属
// ─────────────────────────────────────────────────────────────────────────────
describe('断言7：0082 正向 receipt backfill 修正逐笔支付归属', () => {
  let src, incrementalSrc, clearFullRefundSrc, refundReceiptRepairSrc, overpayReceiptRepairSrc, overpayReceiptRemapSrc, overpayReceiptDrainSrc, refundAllocationMirrorSrc, refundRolePoolRepairSrc

  beforeAll(() => {
    src = readFile(FILES.receiptMigration0082Sql)
    incrementalSrc = readFile(FILES.positiveReceiptRebuild0083Sql)
    clearFullRefundSrc = readFile(FILES.clearFullRefundStatus0084Sql)
    refundReceiptRepairSrc = readFile(FILES.refundReceiptExistingBackfill0085Sql)
    overpayReceiptRepairSrc = readFile(FILES.overpayReceiptItemBackfill0086Sql)
    overpayReceiptRemapSrc = readFile(FILES.overpayReceiptItemRemap0090Sql)
    overpayReceiptDrainSrc = readFile(FILES.overpayReceiptDrain0029Sql)
    refundAllocationMirrorSrc = readFile(FILES.refundAllocationMirrorBackfill0087Sql)
    refundRolePoolRepairSrc = readFile(FILES.refundRolePoolRepair0036Sql)
  })

  test('仅重建无旧分配/无新子分配且逐笔金额不一致的原生销售/转换单', () => {
    expect(src).toMatch(/_0082_positive_receipt_rebuild_orders/)
    expect(src).toMatch(/so\.sale_order_type IN \('销售单','转换单'\)/)
    expect(src).toMatch(/so\.legacy_source IS DISTINCT FROM 'workfine'/)
    expect(src).toMatch(/NOT EXISTS \([\s\S]{0,220}FROM sale_allocations sa[\s\S]{0,260}COALESCE\(sa\.is_void, false\) = false/)
    expect(src).toMatch(/JOIN sale_payment_item_allocations spia ON spia\.sale_payment_item_receipt_id = spir\.id/)
    expect(src).toMatch(/HAVING ABS\(p\.amount::numeric - COALESCE\(SUM\(r\.amount::numeric\), 0\)\) > 0\.01/)
  })

  test('重建逻辑沿用运行态两段式瀑布，并把有 receipt 的正向款项置为待分配', () => {
    expect(src).toMatch(/GREATEST\(0, pending_cents - prior_cents\)/)
    expect(src).toMatch(/GREATEST\(0, sale_amount_cents - GREATEST\(pending_cents, prior_cents\)\)/)
    expect(src).toMatch(/ORDER BY paid_at NULLS LAST, id/)
    expect(src).toMatch(/DELETE FROM sale_payment_item_receipts spir[\s\S]{0,260}sop\.change_type IN \('首次支付','回款','储值卡抵扣'\)/)
    expect(src).toMatch(/UPDATE sale_order_payments[\s\S]{0,120}SET allocation_status = '待分配'/)
  })

  test('0083 增量迁移保留同源修复块，覆盖已执行旧 0082 的数据库', () => {
    expect(incrementalSrc).toMatch(/_0082_positive_receipt_rebuild_orders/)
    expect(incrementalSrc).toMatch(/HAVING ABS\(p\.amount::numeric - COALESCE\(SUM\(r\.amount::numeric\), 0\)\) > 0\.01/)
    expect(incrementalSrc).toMatch(/ORDER BY paid_at NULLS LAST, id/)
    expect(incrementalSrc).toMatch(/UPDATE sale_order_payments[\s\S]{0,120}SET allocation_status = '待分配'/)
  })

  test('0083 同时收敛有净实收且无分配子行的误标已分配状态', () => {
    expect(incrementalSrc).toMatch(/stale_positive_payment_status AS \(/)
    expect(incrementalSrc).toMatch(/sop\.allocation_status = '已分配'/)
    expect(incrementalSrc).toMatch(/GREATEST\(COALESCE\(so\.received::numeric, 0\) - COALESCE\(so\.refunded_amount::numeric, 0\), 0\) > 0\.01/)
    expect(incrementalSrc).toMatch(/SET allocation_status = '待分配'/)
    expect(incrementalSrc).toMatch(/UPDATE sale_orders so[\s\S]{0,120}SET allocation_status = '待分配'/)
  })

  test('0084 清空全额退款且无有效分配明细的 payment/order 分配状态', () => {
    expect(clearFullRefundSrc).toMatch(/WITH full_refund_without_alloc AS \(/)
    expect(clearFullRefundSrc).toMatch(/so\.sale_order_type IN \('销售单','转换单'\)/)
    expect(clearFullRefundSrc).toMatch(/so\.legacy_source IS DISTINCT FROM 'workfine'/)
    expect(clearFullRefundSrc).toMatch(/GREATEST\(COALESCE\(so\.received::numeric, 0\) - COALESCE\(so\.refunded_amount::numeric, 0\), 0\) <= 0\.01/)
    expect(clearFullRefundSrc).toMatch(/UPDATE sale_order_payments sop[\s\S]{0,140}SET allocation_status = NULL/)
    expect(clearFullRefundSrc).toMatch(/UPDATE sale_orders so[\s\S]{0,120}SET allocation_status = NULL/)
  })

  test('0085 覆盖已执行旧 0082 的数据库：补退款 receipt 并排除 WorkFine 历史单', () => {
    expect(refundReceiptRepairSrc).toMatch(/WITH note_refund_items AS \(/)
    expect(refundReceiptRepairSrc).toMatch(/elem ->> 'refSaleItemId' AS sale_item_id/)
    expect(refundReceiptRepairSrc).toMatch(/COALESCE\(\(elem ->> 'refundAmount'\)::numeric, 0\)/)
    expect(refundReceiptRepairSrc).toMatch(/sop\.change_type = '退款'[\s\S]{0,120}sop\.status = '已支付'/)
    expect(refundReceiptRepairSrc).toMatch(/so\.sale_order_type IN \('销售单','转换单'\)/)
    expect(refundReceiptRepairSrc).toMatch(/so\.legacy_source IS DISTINCT FROM 'workfine'/)
    expect(refundReceiptRepairSrc).toMatch(/elem ->> 'refSaleItemId' <> 'OVERPAY'/)
    expect(refundReceiptRepairSrc).toMatch(/ON CONFLICT \(sale_payment_id, sale_item_id\)[\s\S]{0,120}DO UPDATE SET amount = EXCLUDED\.amount/)
  })

  test('0085 清理无 payment 但 order 残留待分配的零实收/全退单', () => {
    expect(refundReceiptRepairSrc).toMatch(/WITH full_refund_without_alloc AS \(/)
    expect(refundReceiptRepairSrc).toMatch(/so\.allocation_status IS NOT NULL/)
    expect(refundReceiptRepairSrc).toMatch(/OR EXISTS \([\s\S]{0,180}sop\.allocation_status IS NOT NULL/)
    expect(refundReceiptRepairSrc).toMatch(/UPDATE sale_order_payments sop[\s\S]{0,140}SET allocation_status = NULL/)
    expect(refundReceiptRepairSrc).toMatch(/UPDATE sale_orders so[\s\S]{0,120}SET allocation_status = NULL/)
  })

  test('0086 把 OVERPAY 余数退款映射到真实 item receipt 并重算 paid_sessions', () => {
    expect(overpayReceiptRepairSrc).toMatch(/_0086_overpay_receipt_mappings/)
    expect(overpayReceiptRepairSrc).toMatch(/elem ->> 'refSaleItemId' = 'OVERPAY'/)
    expect(overpayReceiptRepairSrc).toMatch(/LOWER\(COALESCE\(elem ->> 'isOverpay', 'false'\)\) = 'true'/)
    expect(overpayReceiptRepairSrc).toMatch(/so\.legacy_source IS DISTINCT FROM 'workfine'/)
    expect(overpayReceiptRepairSrc).toMatch(/prior_refund_amount/)
    expect(overpayReceiptRepairSrc).toMatch(/ON CONFLICT \(sale_payment_id, sale_item_id\)[\s\S]{0,120}DO UPDATE SET amount = EXCLUDED\.amount/)
    expect(overpayReceiptRepairSrc).toMatch(/UPDATE sale_items si[\s\S]{0,360}FROM sale_payment_item_receipts spir/)
    expect(overpayReceiptRepairSrc).toMatch(/SET paid_sessions = CASE/)
    expect(overpayReceiptRepairSrc).toMatch(/datafix\.overpayItemReceiptBackfill/)
  })

  test('0090 按行级超额容量重映射 OVERPAY receipt 并删除错误子项', () => {
    expect(overpayReceiptRemapSrc).toMatch(/_0090_overpay_receipt_targets/)
    expect(overpayReceiptRemapSrc).toMatch(/elem ->> 'refSaleItemId' = 'OVERPAY'/)
    expect(overpayReceiptRemapSrc).toMatch(/LOWER\(COALESCE\(elem ->> 'isOverpay', 'false'\)\) = 'true'/)
    expect(overpayReceiptRemapSrc).toMatch(/overpay_capacity_cents/)
    expect(overpayReceiptRemapSrc).toMatch(/COALESCE\(si\.session_count, 0\) - COALESCE\(si\.remaining_sessions, 0\)/)
    expect(overpayReceiptRemapSrc).toMatch(/COALESCE\(si\.paid_sessions, 0\) - GREATEST/)
    expect(overpayReceiptRemapSrc).toMatch(/DELETE FROM sale_payment_item_receipts spir/)
    expect(overpayReceiptRemapSrc).toMatch(/NOT EXISTS \([\s\S]{0,160}_0090_overpay_receipt_targets/)
    expect(overpayReceiptRemapSrc).toMatch(/ON CONFLICT \(sale_payment_id, sale_item_id\)[\s\S]{0,120}DO UPDATE SET amount = EXCLUDED\.amount/)
    expect(overpayReceiptRemapSrc).toMatch(/_0090_refund_allocation_targets/)
    expect(overpayReceiptRemapSrc).toMatch(/DELETE FROM sale_payment_item_allocations spia/)
    expect(overpayReceiptRemapSrc).toMatch(/INSERT INTO sale_payment_item_allocations/)
    expect(overpayReceiptRemapSrc).toMatch(/ON CONFLICT \(sale_payment_item_receipt_id, employee_id, role_type\) WHERE is_void = false/)
    expect(overpayReceiptRemapSrc).toMatch(/SET paid_sessions = CASE/)
    expect(overpayReceiptRemapSrc).toMatch(/datafix\.overpayReceiptItemRemap/)
  })

  test('0029 把 OVERPAY 退款排空到真正承载实收的商品行', () => {
    expect(overpayReceiptDrainSrc).toMatch(/_0029_receipt_targets/)
    expect(overpayReceiptDrainSrc).toMatch(/spir\.sale_payment_id <> opr\.sale_payment_id/)
    expect(overpayReceiptDrainSrc).toMatch(/COALESCE\(rr\.refund_cents, 0\)/)
    expect(overpayReceiptDrainSrc).not.toMatch(/selectedItemIds/)
    expect(overpayReceiptDrainSrc).toMatch(/cannot map every refunded cent to a funded sale item/)
    expect(overpayReceiptDrainSrc).toMatch(/DELETE FROM sale_payment_item_allocations/)
    expect(overpayReceiptDrainSrc).toMatch(/INSERT INTO sale_payment_item_allocations/)
    expect(overpayReceiptDrainSrc).toMatch(/SET received = COALESCE\(GREATEST\(0/)
    expect(overpayReceiptDrainSrc).toMatch(/THEN '已退款'::order_status/)
    expect(overpayReceiptDrainSrc).toMatch(/datafix\.overpayItemReceiptDrain/)
  })

  test('0087 为退款 receipt 补负数营业额子分配并清空全退单分配状态', () => {
    expect(refundAllocationMirrorSrc).toMatch(/_0087_refund_allocation_targets/)
    expect(refundAllocationMirrorSrc).toMatch(/sop\.change_type = '退款'[\s\S]{0,120}sop\.status = '已支付'/)
    expect(refundAllocationMirrorSrc).toMatch(/so\.sale_order_type IN \('销售单','转换单'\)/)
    expect(refundAllocationMirrorSrc).toMatch(/so\.legacy_source IS DISTINCT FROM 'workfine'/)
    expect(refundAllocationMirrorSrc).toMatch(/JOIN sale_payment_item_allocations spia[\s\S]{0,180}spia\.allocated_amount::numeric > 0/)
    expect(refundAllocationMirrorSrc).toMatch(/other_negative_total_cents/)
    expect(refundAllocationMirrorSrc).toMatch(/ON CONFLICT \(sale_payment_item_receipt_id, employee_id, role_type\) WHERE is_void = false[\s\S]{0,220}DO UPDATE SET/)
    expect(refundAllocationMirrorSrc).toMatch(/RAISE EXCEPTION '0087 refund allocation mirror backfill left nonzero full-refund allocation net'/)
    expect(refundAllocationMirrorSrc).toMatch(/UPDATE sale_order_payments sop[\s\S]{0,120}SET allocation_status = NULL/)
    expect(refundAllocationMirrorSrc).toMatch(/UPDATE sale_orders so[\s\S]{0,120}SET allocation_status = NULL/)
    expect(refundAllocationMirrorSrc).toMatch(/datafix\.refundAllocationMirrorBackfill/)
    expect(refundAllocationMirrorSrc).toMatch(/datafix\.fullRefundAllocationStatusClear/)
  })

  test('0036 按 role_type 独立修复历史退款营业额与提成', () => {
    const multipleRefundGuardAt = refundRolePoolRepairSrc.indexOf(
      'refund role-pool repair does not support multiple paid refunds per sale item',
    )
    const singleRefundFilterAt = refundRolePoolRepairSrc.indexOf('rt.refund_count = 1')
    const obsoleteDetectionAt = refundRolePoolRepairSrc.indexOf('obsolete_currents AS')
    const obsoleteVoidAt = refundRolePoolRepairSrc.indexOf(
      'UPDATE sale_payment_item_allocations current',
    )
    const targetUpsertAt = refundRolePoolRepairSrc.indexOf(
      'INSERT INTO sale_payment_item_allocations (',
    )
    const obsoleteDetectionSrc = refundRolePoolRepairSrc.slice(obsoleteDetectionAt, obsoleteVoidAt)
    const obsoleteVoidSrc = refundRolePoolRepairSrc.slice(obsoleteVoidAt, targetUpsertAt)

    expect(refundRolePoolRepairSrc).toMatch(/_0035_refund_role_pool_receipts/)
    expect(refundRolePoolRepairSrc).toMatch(/_0035_refund_role_pool_targets/)
    expect(refundRolePoolRepairSrc).toMatch(/LOCK TABLE sale_order_payments, sale_payment_item_receipts IN SHARE MODE/)
    expect(refundRolePoolRepairSrc).toMatch(/HAVING COUNT\(DISTINCT refund_receipt\.sale_payment_id\) > 1/)
    expect(multipleRefundGuardAt).toBeGreaterThanOrEqual(0)
    expect(singleRefundFilterAt).toBeGreaterThan(multipleRefundGuardAt)
    expect(refundRolePoolRepairSrc).toMatch(/PARTITION BY refund_receipt_id, role_type/)
    expect(refundRolePoolRepairSrc).toMatch(/positive_receipt_cents/)
    expect(refundRolePoolRepairSrc).toMatch(/role_target_cents/)
    expect(refundRolePoolRepairSrc).toMatch(/commission_cents/)
    expect(obsoleteDetectionAt).toBeGreaterThanOrEqual(0)
    expect(obsoleteVoidAt).toBeGreaterThan(obsoleteDetectionAt)
    expect(targetUpsertAt).toBeGreaterThan(obsoleteVoidAt)
    expect(obsoleteDetectionSrc).toMatch(/FROM _0035_refund_role_pool_receipts/)
    expect(obsoleteVoidSrc).toMatch(/SET is_void = true,[\s\S]*voided_at = NOW\(\)/)
    expect(obsoleteVoidSrc).toMatch(/FROM _0035_refund_role_pool_receipts/)
    expect(obsoleteVoidSrc).toMatch(/NOT EXISTS \(/)
    expect(obsoleteVoidSrc).toMatch(/target\.refund_receipt_id = current\.sale_payment_item_receipt_id/)
    expect(obsoleteVoidSrc).toMatch(/target\.employee_id = current\.employee_id/)
    expect(obsoleteVoidSrc).toMatch(/target\.role_type = current\.role_type/)
    expect(refundRolePoolRepairSrc).toMatch(/ON CONFLICT \(sale_payment_item_receipt_id, employee_id, role_type\) WHERE is_void = false[\s\S]{0,220}DO UPDATE SET/)
    expect(refundRolePoolRepairSrc).toMatch(/datafix\.refundRolePoolAllocation/)
    expect(refundRolePoolRepairSrc).toMatch(/refund role-pool allocation invariant still mismatched after repair/)
  })
})
