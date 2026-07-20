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
 *        - INSERT INTO sale_payment_allocatable_items ... ON CONFLICT (sale_payment_id, sale_item_id) DO UPDATE
 *        - 非定向按 pending_received − 已记 amount 剩余实付比例摊
 *        - UPDATE sale_order_payments SET allocation_status='待分配'
 *        - guard：仅「销售单/转换单」+ 排除 legacy（legacy_source==='workfine'）
 *   3. payNotify autoAllocateOnlinePayment 用新约束名 uq_sale_alloc_item_emp_role_payment +
 *      INSERT 写 sale_payment_id + 提成档位基准为 eventAmount（本次回款额）。
 *   4. payNotify index.js 运行时源码不再出现旧约束名 uq_sale_alloc_item_emp_role（不含 _payment）。
 *
 * 风格参照 cross-end-sql-snapshot.test.js / cross-end-refund-freeze-notify-snapshot.test.js。
 */
const fs = require('node:fs')
const path = require('node:path')

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

  payNotifyIndexJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/payNotify/index.js'),
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

  test('四端均含 INSERT INTO sale_payment_allocatable_items ... ON CONFLICT (sale_payment_id, sale_item_id) DO UPDATE', () => {
    const re =
      /INSERT INTO sale_payment_allocatable_items[\s\S]{0,500}ON CONFLICT \(sale_payment_id, sale_item_id\)[\s\S]{0,160}DO UPDATE SET amount = EXCLUDED\.amount/
    for (const [end, src] of ENDS()) {
      expect(src, `${end} 缺 INSERT ... ON CONFLICT DO UPDATE upsert`).toMatch(re)
    }
  })

  test('四端非定向均按两段式瀑布（pend_cap = pending_received − 已记 amount；溢出再按 sale_cap）摊', () => {
    // 2026-06-28 重构：非定向分摊从单段「剩余实付比例」改为两段式瀑布（与 recalcPaidSessionsForOrder STEP1 数学一致）
    //   第一段产能 pend_cap_i = max(0, pending_received_i − prior_allocated_i)（剩余实付）
    //   第二段产能 sale_cap_i = max(0, sale_amount_i − max(pending_received_i, prior_allocated_i))（应付余量）
    for (const [end, src] of ENDS()) {
      // prior 已记可分配额（sale_payment_allocatable_items 合计）
      expect(src, `${end} 缺 prior = priorMap.get(...) || 0`).toMatch(
        /const prior = priorMap\.get\(i\.sale_item_id\)\s*\|\|\s*0/,
      )
      // pending_received 取数
      expect(src, `${end} 缺 pending = Number(i.pending_received)`).toMatch(
        /const pending = Number\(i\.pending_received\)/,
      )
      // 第一段产能 pend_cap = pending − prior（剩余实付）
      expect(src, `${end} 缺 pendCap 公式 (pending - prior)`).toMatch(
        /pendCap:\s*Math\.max\(0,\s*Math\.round\(\(pending\s*-\s*prior\)\s*\*\s*100\)\s*\/\s*100\)/,
      )
      // 第二段产能 sale_cap = sale_amount − max(pending, prior)（应付余量）
      expect(src, `${end} 缺 saleCap 公式 (saleAmt - Math.max(pending, prior))`).toMatch(
        /saleCap:\s*Math\.max\(0,\s*Math\.round\(\(saleAmt\s*-\s*Math\.max\(pending,\s*prior\)\)\s*\*\s*100\)\s*\/\s*100\)/,
      )
      // 两段式分摊：phase1 按 pendCap、phase2 按 saleCap
      expect(src, `${end} 缺 phase1 按 pendCap 铺`).toMatch(/cap:\s*c\.pendCap/)
      expect(src, `${end} 缺 phase2 按 saleCap 铺`).toMatch(/cap:\s*c\.saleCap/)
      // 剩余实付来源：sale_payment_allocatable_items 已记可分配额合计
      expect(src, `${end} 缺已记可分配额合计查询`).toMatch(
        /COALESCE\(SUM\(amount::numeric\), 0\) AS allocated[\s\S]{0,80}FROM sale_payment_allocatable_items/,
      )
    }
  })

  test("四端均置回款主流水行 UPDATE sale_order_payments SET allocation_status='待分配'", () => {
    const re = /UPDATE sale_order_payments SET allocation_status = '待分配'/
    for (const [end, src] of ENDS()) {
      expect(src, `${end} 缺 allocation_status='待分配' 置位`).toMatch(re)
    }
  })

  test('四端转换单兜底一致：无「购买」行时取全部「转入」行按 sale_amount 比例摊 SPAI（含 admin TS 版，修多转入行异品类提成归因）', () => {
    for (const [end, src] of ENDS()) {
      expect(src, `${end} 缺转换单 items.length === 0 兜底分支`).toMatch(/items\.length === 0/)
      expect(src, `${end} 缺转换单 item_direction='转入' 兜底`).toMatch(/item_direction = '转入'/)
      // 2026-07-20 修 #2：转换单多转入行不再 LIMIT 1 全挂首行（致异品类提成归因错），改为取全部转入行按 sale_amount 比例摊
      expect(src, `${end} 转换单兜底仍残留 LIMIT 1`).not.toMatch(/item_direction = '转入'[\s\S]{0,120}LIMIT 1/)
      expect(src, `${end} 缺转换单 SELECT sale_amount（按比例摊需取 sale_amount）`).toMatch(/SELECT sale_item_id, sale_amount::numeric AS sale_amount, sales_category[\s\S]{0,80}item_direction = '转入'/)
      expect(src, `${end} 缺转换单按 sale_amount 比例摊（最大余数法 convCaps + exact = evtCents*c.cap/totalW）`).toMatch(/convCaps[\s\S]{0,400}exact = \(evtCents \* c\.cap\) \/ totalW/)
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

  test('用新约束名 uq_sale_alloc_item_emp_role_payment 做 ON CONFLICT', () => {
    expect(autoBody).toMatch(/ON CONFLICT ON CONSTRAINT uq_sale_alloc_item_emp_role_payment DO NOTHING/)
  })

  test('INSERT sale_allocations 写入 sale_payment_id 列', () => {
    expect(autoBody).toMatch(/INSERT INTO sale_allocations[\s\S]{0,200}sale_payment_id/)
  })

  test('提成档位基准为 eventAmount（本次回款额）', () => {
    expect(autoBody).toMatch(/lookupSalesRate\(roleType, salesCategory, eventAmount\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 断言 4：payNotify index.js 运行时源码不残留旧约束名（不含 _payment 后缀）
// ─────────────────────────────────────────────────────────────────────────────
describe('断言4：payNotify index.js 不再出现旧约束名 uq_sale_alloc_item_emp_role（不含 _payment）', () => {
  test('全文不含旧约束名 uq_sale_alloc_item_emp_role（未跟 _payment）', () => {
    const src = readFile(FILES.payNotifyIndexJs)
    // 负向先行：匹配 uq_sale_alloc_item_emp_role 但其后不紧跟 _payment（即旧名）
    expect(src).not.toMatch(/uq_sale_alloc_item_emp_role(?!_payment)/)
    // 正向：新约束名仍在
    expect(src).toMatch(/uq_sale_alloc_item_emp_role_payment/)
  })
})
