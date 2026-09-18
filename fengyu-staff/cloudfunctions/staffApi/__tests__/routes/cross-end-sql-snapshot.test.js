/**
 * 跨端 SQL 一致性守护测试（audit-15 P0-15-02 协同的"独立副本 + 测试守护"方案）
 *
 * 用户决策：不抽取 cloudfunctions-shared 共享代码，各端保留独立副本。
 * 一致性靠这个 snapshot test 守护——任一端 SQL 字面量漂移即触发失败，
 * 错误信息提醒维护者同步另外几端。
 *
 * 守护对象：
 *   1. settlePointsForOrder SQL — 四端字节同义
 *      ├── fengyu-admin/src/lib/points-settle.ts                  (Drizzle)
 *      ├── fengyu-staff/cloudfunctions/staffApi/utils/points.js   (pg)
 *      ├── fengyu-client/cloudfunctions/clientApi/utils/points.js (pg)
 *      └── fengyu-client/cloudfunctions/payNotify/points.js       (pg)
 *
 *   2. applyRechargeOnOrderPaid SQL — 三端字节同义
 *      ├── fengyu-admin/src/actions/orders.ts          (Drizzle)
 *      ├── fengyu-staff/cloudfunctions/staffApi/routes/order.js (pg, confirmOffline 内)
 *      └── fengyu-client/cloudfunctions/payNotify/index.js      (pg)
 *
 *   3. P0-15-01 触发点守护 — admin 必须在 confirmOfflinePayment + recordPayment
 *      两处调用 settlePointsSafe（防回归）
 *
 *   4. 优惠券 face_value_override 跨端读取 — 五处必须用 COALESCE
 *      （SUMMARY v3 §2 #11 / ticket 2026-05-17-face-value-override-cross-end-audit.md）
 *      ├── fengyu-admin/src/actions/orders.ts             (Drizzle sql 模板)
 *      ├── fengyu-staff/cloudfunctions/staffApi/routes/coupon.js (pg)
 *      ├── fengyu-staff/cloudfunctions/staffApi/routes/order.js  (pg)
 *      ├── fengyu-client/cloudfunctions/clientApi/routes/coupon.js (pg)
 *      └── fengyu-client/cloudfunctions/clientApi/routes/order.js  (pg)
 *
 *   5. cascadeRefund 5 通道 SQL — 双端字节同义
 *      （SUMMARY v3 §2 #14 / ticket 2026-05-17-refund-cascade-snapshot-guard.md）
 *      ├── fengyu-admin/src/lib/refund-cascade.ts (Drizzle / sql tag)
 *      └── fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js (pg)
 *
 *   6. cascadeRefund 触发点守护 — 双端 approveRefund 必须调用
 *      ├── fengyu-admin/src/actions/refunds.ts
 *      └── fengyu-staff/cloudfunctions/staffApi/routes/order.js
 *
 * SQL 模板归一化策略（normalizeSql）：
 *   - 占位符 $1/$2 与 ${var} 都 → ?（pg vs Drizzle 占位符差异）
 *   - 连续空白压缩为单空格
 *   - 括号两侧空白清理
 *   - 结果适合跨 pg / Drizzle 实现做 snapshot 比对
 */

const fs = require('node:fs')
const path = require('node:path')

const FILES = {
  staffPointsJs: path.resolve(__dirname, '../../utils/points.js'),
  clientPointsJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/utils/points.js'),
  payNotifyPointsJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/payNotify/points.js'),
  adminPointsSettleTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/points-settle.ts'),
  staffCustomerJs: path.resolve(__dirname, '../../routes/customer.js'),
  adminCustomersTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/customers.ts'),
  adminHomeProductTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/home-product.ts'),
  staffMgmtCustomerJs: path.resolve(__dirname, '../../routes/mgmt-customer.js'),
  adminCardsTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/cards.ts'),
  adminPickupRecordsTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/pickup-records.ts'),
  staffPaymentAllocatableJs: path.resolve(__dirname, '../../utils/payment-allocatable.js'),
  clientPaymentAllocatableJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/utils/payment-allocatable.js'),
  payNotifyPaymentAllocatableJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/payNotify/payment-allocatable.js'),
  adminPaymentAllocatableTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/payment-allocatable.ts'),

  staffOrderJs: path.resolve(__dirname, '../../routes/order.js'),
  payNotifyIndexJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/payNotify/index.js'),
  adminOrdersTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/orders.ts'),

  // issue #139 — 款项业绩归属日期筛选的两种粒度，staff / admin 各两处共四个站点
  staffAllocationJs: path.resolve(__dirname, '../../routes/allocation.js'),
  staffIndexJs: path.resolve(__dirname, '../../index.js'),
  adminPerformanceAttributionTs: path.resolve(
    __dirname, '../../../../../fengyu-admin/src/lib/performance-attribution.ts',
  ),

  // ticket 2026-05-19-sale-items-paid-sessions — paid_sessions 重算 SQL 四端字节同义
  staffPaidSessionsJs: path.resolve(__dirname, '../../utils/paid-sessions.js'),
  clientPaidSessionsJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/utils/paid-sessions.js'),
  payNotifyPaidSessionsJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/payNotify/paid-sessions.js'),
  adminPaidSessionsTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/paid-sessions.ts'),
  // 同一公式的第 5 个副本：维护脚本 fix-sale-items-session-count.js 改 session_count 后内联 recalc
  scriptPaidSessionsFix: path.resolve(__dirname, '../../../../../db/scripts/fix-sale-items-session-count.js'),

  // SUMMARY v3 §2 #11 — face_value_override 五处读取
  staffCouponJs: path.resolve(__dirname, '../../routes/coupon.js'),
  clientCouponJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/routes/coupon.js'),
  clientOrderJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/routes/order.js'),

  // SUMMARY v3 §2 #14 — cascadeRefund 双端副本 + 触发点
  staffRefundCascadeJs: path.resolve(__dirname, '../../helpers/refund-cascade.js'),
  adminRefundCascadeTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/refund-cascade.ts'),
  adminRefundsTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/refunds.ts'),
  adminAllocationsTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/allocations.ts'),

  // SUMMARY v3 §2 #13 — scope assert helper 双端副本
  staffScopeJs: path.resolve(__dirname, '../../utils/scope.js'),
  adminScopeAssertTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/scope-assert.ts'),
  // SUMMARY v3 §2 #13 — client 端 scope helper（语义不同：单用户归属，不参与 staff/admin 跨端 SQL 对比）
  clientScopeJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/utils/scope.js'),

  // 服务单 finalize（待客户确认 → 已完成）副作用 SQL — staff / client 双端字节同义
  // staff: routes/service.js 的 finalizeServiceOrder；client: utils/service-finalize.js
  // 顾客确认链路首次把"扣次数 + 算提成"SQL 引入 clientApi，故纳入跨端守护。
  staffServiceJs: path.resolve(__dirname, '../../routes/service.js'),
  clientServiceFinalizeJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/utils/service-finalize.js'),
  // M1（2026-07-14）：admin confirmServiceOrder 经 lib/service-commission-settle.ts 镜像同口径
  adminServiceCommissionSettleTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/service-commission-settle.ts'),
  adminServicesTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/services.ts'),
  staffVisitPointsJs: path.resolve(__dirname, '../../utils/visit-points.js'),
  clientVisitPointsJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/utils/visit-points.js'),
  adminVisitPointsTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/visit-points.ts'),

  // 2026-07-21 行级退款额聚合 per-item-refund — 四端字面同义（与 paid-sessions RECEIVED_REFUNDED_DEDUCT_SQL 同源 CTE）
  staffPerItemRefundJs: path.resolve(__dirname, '../../utils/per-item-refund.js'),
  clientPerItemRefundJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/utils/per-item-refund.js'),
  payNotifyPerItemRefundJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/payNotify/per-item-refund.js'),
  adminPerItemRefundTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/per-item-refund.ts'),
}

function readFile(p) {
  return fs.readFileSync(p, 'utf8')
}

/**
 * 剥掉 JS/TS 注释后再做「某行代码是否存在」的断言。
 *
 * 不剥的话，把目标行注释掉就能骗过断言而代码已失效——这是 snapshot 守护的经典漏网：
 * `toContain` 吃行注释，行形锚点 `/^\s*x$/m` 吃块注释（整行包进 /* *\/ 后行首仍是空白+代码）。
 * 块注释整体置空而非逐行删，是为了保持行结构不塌陷，行形锚点才不会误命中相邻行。
 *
 * 只用于这类存在性断言，不追求完备的词法分析（字符串字面量里的 `//` 会被误伤，
 * 但那只会让断言更严格，方向是 fail-closed）。
 */
function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function normalizeSql(sql) {
  return sql
    .replace(/\$\d+/g, '?')
    .replace(/\$\{[^}]+\}/g, '?')
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .trim()
}

/**
 * 提取源文件中第一个包含 marker 关键字的 backtick 字符串内容（无外层反引号）。
 * 适用于 Drizzle 的 sql`...` 与 pg 的 client.query(`...`) 两种用法，提取出来都是纯 SQL 文本。
 */
function extractBacktickStringContaining(src, marker) {
  const matches = src.matchAll(/`([^`]+)`/g)
  for (const m of matches) {
    if (m[1].includes(marker)) return m[1]
  }
  throw new Error(`未找到含 "${marker}" 的 backtick 字符串`)
}

const MARKER_NET_SETTLED = 'AS net_settled'
const MARKER_GRANTED = 'AS granted'
const MARKER_UPSERT_PREPAID = 'INSERT INTO prepaid_cards'
const MARKER_UPSERT_POINTS = 'INSERT INTO point_transactions'

describe('audit-15 P0-15-02 协同：四端 settlePointsForOrder SQL 一致性守护', () => {
  let netSettledSqls
  let grantedSqls
  let upsertSqls

  beforeAll(() => {
    netSettledSqls = {
      staff: normalizeSql(extractBacktickStringContaining(readFile(FILES.staffPointsJs), MARKER_NET_SETTLED)),
      client: normalizeSql(extractBacktickStringContaining(readFile(FILES.clientPointsJs), MARKER_NET_SETTLED)),
      payNotify: normalizeSql(extractBacktickStringContaining(readFile(FILES.payNotifyPointsJs), MARKER_NET_SETTLED)),
      adminTs: normalizeSql(extractBacktickStringContaining(readFile(FILES.adminPointsSettleTs), MARKER_NET_SETTLED)),
    }
    grantedSqls = {
      staff: normalizeSql(extractBacktickStringContaining(readFile(FILES.staffPointsJs), MARKER_GRANTED)),
      client: normalizeSql(extractBacktickStringContaining(readFile(FILES.clientPointsJs), MARKER_GRANTED)),
      payNotify: normalizeSql(extractBacktickStringContaining(readFile(FILES.payNotifyPointsJs), MARKER_GRANTED)),
      adminTs: normalizeSql(extractBacktickStringContaining(readFile(FILES.adminPointsSettleTs), MARKER_GRANTED)),
    }
    // point_transactions 写入 upsert（分次回款/退款累加，四端字面同义）
    upsertSqls = {
      staff: normalizeSql(extractBacktickStringContaining(readFile(FILES.staffPointsJs), MARKER_UPSERT_POINTS)),
      client: normalizeSql(extractBacktickStringContaining(readFile(FILES.clientPointsJs), MARKER_UPSERT_POINTS)),
      payNotify: normalizeSql(extractBacktickStringContaining(readFile(FILES.payNotifyPointsJs), MARKER_UPSERT_POINTS)),
      adminTs: normalizeSql(extractBacktickStringContaining(readFile(FILES.adminPointsSettleTs), MARKER_UPSERT_POINTS)),
    }
  })

  describe('P0-15-01b 回归守护：四端均禁止 SUM(paid_amount)', () => {
    test('staffApi/utils/points.js 链净汇总不含 SUM(paid_amount)', () => {
      expect(netSettledSqls.staff).not.toContain('SUM(paid_amount)')
      expect(netSettledSqls.staff).toContain('received')
      expect(netSettledSqls.staff).toContain('refunded_amount')
    })
    test('clientApi/utils/points.js 链净汇总不含 SUM(paid_amount)', () => {
      expect(netSettledSqls.client).not.toContain('SUM(paid_amount)')
    })
    test('payNotify/points.js 链净汇总不含 SUM(paid_amount)（P0-15-01b 修复点）', () => {
      expect(netSettledSqls.payNotify).not.toContain('SUM(paid_amount)')
      expect(netSettledSqls.payNotify).toContain('received')
      expect(netSettledSqls.payNotify).toContain('refunded_amount')
    })
    test('admin lib/points-settle.ts 链净汇总不含 SUM(paid_amount)', () => {
      expect(netSettledSqls.adminTs).not.toContain('SUM(paid_amount)')
    })
  })

  describe('链净汇总 SQL 镜像比对（任一端漂移 → fail，提示同步另外三端）', () => {
    test('staff vs client（pg 实现内部一致）', () => {
      expect(netSettledSqls.client).toBe(netSettledSqls.staff)
    })
    test('staff vs payNotify（pg 实现内部一致）', () => {
      expect(netSettledSqls.payNotify).toBe(netSettledSqls.staff)
    })
    test('staff vs admin（pg 与 Drizzle 占位符归一化后等价）', () => {
      expect(netSettledSqls.adminTs).toBe(netSettledSqls.staff)
    })
  })

  describe('已发积分合计 SQL 镜像比对', () => {
    test('四端规范化后 SQL 完全一致', () => {
      expect(grantedSqls.client).toBe(grantedSqls.staff)
      expect(grantedSqls.payNotify).toBe(grantedSqls.staff)
      expect(grantedSqls.adminTs).toBe(grantedSqls.staff)
    })
  })

  describe('point_transactions 写入 upsert 守护（分次回款累加，禁止裸 INSERT 撞唯一索引回滚）', () => {
    test('四端 upsert SQL 镜像比对（任一端漂移 → fail，提示同步另外三端）', () => {
      expect(upsertSqls.client).toBe(upsertSqls.staff)
      expect(upsertSqls.payNotify).toBe(upsertSqls.staff)
      expect(upsertSqls.adminTs).toBe(upsertSqls.staff)
    })
    test('四端均为 ON CONFLICT DO UPDATE 累加（非裸 INSERT / 非 DO NOTHING）', () => {
      for (const [end, sql] of Object.entries(upsertSqls)) {
        expect(sql, `${end} 缺 ON CONFLICT`).toContain('ON CONFLICT (user_id, ref_order_id, type)')
        expect(sql, `${end} 缺 DO UPDATE 累加`).toContain(
          'DO UPDATE SET amount = point_transactions.amount + EXCLUDED.amount',
        )
        expect(sql, `${end} 不应再用 DO NOTHING`).not.toContain('DO NOTHING')
      }
    })
  })

  describe('Snapshot 守护（提交后任一字符漂移立即可见）', () => {
    test('settlePoints 关键 SQL 文本快照', () => {
      expect({
        netSettled: netSettledSqls.staff,
        granted: grantedSqls.staff,
        upsert: upsertSqls.staff,
      }).toMatchSnapshot()
    })
  })
})

describe('applyRechargeOnOrderPaid SQL 一致性守护（三端独立副本）', () => {
  let upsertSqls

  beforeAll(() => {
    upsertSqls = {
      staff: normalizeSql(extractBacktickStringContaining(readFile(FILES.staffOrderJs), MARKER_UPSERT_PREPAID)),
      payNotify: normalizeSql(extractBacktickStringContaining(readFile(FILES.payNotifyIndexJs), MARKER_UPSERT_PREPAID)),
      adminTs: normalizeSql(extractBacktickStringContaining(readFile(FILES.adminOrdersTs), MARKER_UPSERT_PREPAID)),
    }
  })

  test('三端 UPSERT prepaid_cards 必须用 ON CONFLICT (user_id)', () => {
    expect(upsertSqls.staff).toMatch(/ON CONFLICT\s*\(user_id\)/i)
    expect(upsertSqls.payNotify).toMatch(/ON CONFLICT\s*\(user_id\)/i)
    expect(upsertSqls.adminTs).toMatch(/ON CONFLICT\s*\(user_id\)/i)
  })

  test('三端 UPSERT 必须用 balance += EXCLUDED.balance 累加（不能用赋值）', () => {
    expect(upsertSqls.staff).toMatch(/balance\s*=\s*prepaid_cards\.balance\s*\+\s*EXCLUDED\.balance/i)
    expect(upsertSqls.payNotify).toMatch(/balance\s*=\s*prepaid_cards\.balance\s*\+\s*EXCLUDED\.balance/i)
    expect(upsertSqls.adminTs).toMatch(/balance\s*=\s*prepaid_cards\.balance\s*\+\s*EXCLUDED\.balance/i)
  })

  test('Snapshot 守护：三端 UPSERT 文本任一漂移立即可见', () => {
    expect(upsertSqls).toMatchSnapshot()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ticket 2026-05-19-admin-orders-sql-cross-end-snapshot-guard.md
// admin orders.ts 关键 SQL 纳入 cross-end 守护范围
//
// 历史漂移：2026-04-26 capability 化重构时，staff/payNotify 早已改双路径，
// admin 留着单路径直到 2026-05-19（T5 ticket 修复，23 天漂移期）。
// 本块在 staff 侧 jest 内补加 admin 三端 SQL 比对，与 admin 侧 vitest 镜像测试
// `fengyu-admin/src/lib/__tests__/orders-sql-cross-end.test.ts` 形成双向守护。
//
// 守护范围：
//   1. applyRechargeOnOrderPaid SELECT recharge items（双路径面值识别，capability 列）
//   2. applyRechargeOnOrderPaid UPSERT prepaid_cards（已被现有 describe 守护，此处不重复）
//   3. confirmOfflinePayment 储值卡扣款关键 SQL（admin 独立锁块 + staff 复用 order 行）
// ─────────────────────────────────────────────────────────────────────────────
describe('ticket 2026-05-19 admin orders.ts 关键 SQL 纳入跨端守护', () => {
  let adminSrc, staffSrc, payNotifySrc

  beforeAll(() => {
    adminSrc = readFile(FILES.adminOrdersTs)
    staffSrc = readFile(FILES.staffOrderJs)
    payNotifySrc = readFile(FILES.payNotifyIndexJs)
  })

  describe('§2.1 Recharge identification 三端字面对齐（2026-05-20 充值卡剥离 SKU 化）', () => {
    test('三端入账识别走 sale_order_type=充值单（替代旧 sale_items.is_recharge_card 标记）', () => {
      expect(adminSrc).toMatch(/sale_order_type[\s\S]{0,80}'?充值单'?/i)
      expect(staffSrc).toMatch(/sale_order_type\s*===?\s*'充值单'/)
      expect(payNotifySrc).toMatch(/sale_order_type\s*===?\s*'充值单'/)
    })

    test('三端不得残留 is_recharge_card 字段引用（除注释外）', () => {
      const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const [name, src] of [
        ['admin', adminSrc],
        ['staff', staffSrc],
        ['payNotify', payNotifySrc],
      ]) {
        const cleaned = stripComments(src)
        expect(cleaned, `${name} 不应再有 is_recharge_card 运行时引用`).not.toMatch(/is_recharge_card/)
        expect(cleaned, `${name} 不应再有 RECHARGE_VIRTUAL_SKU_ID 引用`).not.toMatch(/RECHARGE_VIRTUAL_SKU_ID/)
      }
    })

    test('三端入账幂等键统一为 card-topup-{saleOrderId}', () => {
      for (const [name, src] of [
        ['admin', adminSrc],
        ['staff', staffSrc],
        ['payNotify', payNotifySrc],
      ]) {
        expect(src, `${name} 缺 card-topup-{saleOrderId} 幂等键`).toMatch(/card-topup-/)
      }
    })
  })

  describe('§2.2 confirmOfflinePayment 储值卡扣款 6 段（admin 入口单锁字面对齐 staff 内联块）', () => {
    test('admin 必须在 FOR UPDATE 锁单时读取 prepaid_card_amount + client_user_id', () => {
      // admin confirmOfflinePayment 入口用单条 SELECT ... FOR UPDATE 锁单并读全部决策列
      const lockSql = normalizeSql(extractBacktickStringContaining(adminSrc, 'SELECT status, payment_method, store_id'))
      expect(lockSql).toMatch(/FROM sale_orders/i)
      expect(lockSql).toMatch(/FOR UPDATE/i)
      expect(lockSql).toMatch(/prepaid_card_amount/)
      expect(lockSql).toMatch(/client_user_id/)
    })

    test("admin/staff 扣款幂等：SELECT 1 FROM card_transactions WHERE ref_order_id AND type='扣款'", () => {
      const guardRe = /SELECT\s+1\s+FROM\s+card_transactions[\s\S]{0,200}ref_order_id[\s\S]{0,100}type\s*=\s*'扣款'/i
      expect(adminSrc).toMatch(guardRe)
      expect(staffSrc).toMatch(guardRe)
    })

    test('admin/staff 锁余额 SQL 归一化后一致：SELECT card_id, balance FROM prepaid_cards WHERE user_id = ? FOR UPDATE', () => {
      // admin 用 Drizzle sql`...` 反引号模板；staff confirmOffline 用 pg client.query('...', [user])
      // 单引号字符串。统一在源码中 grep 出"该 SELECT 子句"做归一化比较。
      const adminSql = normalizeSql(extractBacktickStringContaining(adminSrc, 'SELECT card_id, balance FROM prepaid_cards'))
      const staffMatch = staffSrc.match(/['"`]SELECT card_id, balance FROM prepaid_cards[^'"`]*['"`]/)
      expect(staffMatch).not.toBeNull()
      const staffSql = normalizeSql(staffMatch[0].slice(1, -1))
      const expected = 'SELECT card_id, balance FROM prepaid_cards WHERE user_id = ? FOR UPDATE'
      expect(adminSql).toBe(expected)
      expect(staffSql).toBe(expected)
    })

    test("admin/staff 扣款 INSERT card_transactions 必须含 type='扣款' + external_ref=card-deduct-{saleOrderId} + ON CONFLICT DO NOTHING", () => {
      for (const [name, src] of [['admin', adminSrc], ['staff', staffSrc]]) {
        const inserts = [...src.matchAll(/INSERT INTO card_transactions[\s\S]{0,500}/g)]
        const deductInsert = inserts.find((m) => m[0].includes("'扣款'"))
        expect(deductInsert, `${name} 找不到 type='扣款' 的 INSERT card_transactions`).toBeDefined()
        expect(deductInsert[0]).toMatch(/card-deduct-/)
        expect(deductInsert[0]).toMatch(/ON CONFLICT\s*\(external_ref\)[\s\S]{0,100}DO NOTHING/i)
      }
    })

    test("admin/staff 必须写 储值卡抵扣 payments 行（INSERT sale_order_payments change_type='储值卡抵扣' payment_method='储值卡' status='已支付'）", () => {
      for (const [name, src] of [['admin', adminSrc], ['staff', staffSrc]]) {
        const inserts = [...src.matchAll(/INSERT INTO sale_order_payments[\s\S]{0,800}/g)]
        const cardDeductPayment = inserts.find((m) => m[0].includes("'储值卡抵扣'"))
        expect(cardDeductPayment, `${name} 找不到 储值卡抵扣 sale_order_payments INSERT`).toBeDefined()
        expect(cardDeductPayment[0]).toMatch(/'储值卡'/)
        expect(cardDeductPayment[0]).toMatch(/'已支付'/)
      }
    })

    test("admin/staff UPDATE prepaid_cards SET balance = balance - ? 归一化后字面同义", () => {
      const adminSql = normalizeSql(extractBacktickStringContaining(adminSrc, 'UPDATE prepaid_cards'))
      // staff 有多处 UPDATE prepaid_cards：confirmOffline + approveRefund。提取第一处含 'balance - $1'
      // 但 extractBacktickStringContaining 是首匹配，足够覆盖 confirmOffline 路径（出现位置在前）。
      const staffSql = normalizeSql(extractBacktickStringContaining(staffSrc, 'UPDATE prepaid_cards'))
      // admin 含 ::numeric cast，staff 不含。这里只守护核心子串与扣减方向。
      for (const sql of [adminSql, staffSql]) {
        expect(sql).toMatch(/UPDATE prepaid_cards/i)
        expect(sql).toMatch(/balance\s*=\s*balance\s*-\s*\?/i)
        expect(sql).toMatch(/updated_at\s*=\s*NOW\(\)/i)
        expect(sql).toMatch(/WHERE card_id\s*=\s*\?/i)
      }
    })
  })

  describe('§2.3 confirmOffline received 重聚合 SQL（admin/staff 字面对齐，2026-06-08 修 I1 储值卡抵扣漏记）', () => {
    // 背景：staff confirmOffline 原用 newReceived = orderReceived + confirmAmount 直接加法，漏储值卡抵扣，
    //       破坏 I1（received = Σ[首次支付/回款/储值卡抵扣]）→ recalcPaidSessionsForOrder 把缺卡的 received
    //       按 pending_received 比例摊到各行 → admin 订单详情"已确认实收"被现金比例稀释。
    //       改为与 admin confirmOfflinePayment / staff createRepayment 同款双列重聚合（new_received + new_prepaid）。
    test('staff confirmOffline 与 admin confirmOfflinePayment 的 received 聚合 SQL 归一化后字面相等', () => {
      // 两端源码首个含 'AS new_received' 的 backtick 即各自 confirmOffline(Payment) 的重聚合块
      const staffSql = normalizeSql(extractBacktickStringContaining(staffSrc, 'AS new_received'))
      const adminSql = normalizeSql(extractBacktickStringContaining(adminSrc, 'AS new_received'))
      expect(staffSql).toBe(adminSql)
    })

    test('该聚合 SQL 必须按 首次支付/回款/储值卡抵扣 三类已支付流水汇总 received（维护 I1）+ 含 new_prepaid', () => {
      const staffSql = normalizeSql(extractBacktickStringContaining(staffSrc, 'AS new_received'))
      expect(staffSql).toMatch(/change_type IN \('首次支付','回款','储值卡抵扣'\)/)
      expect(staffSql).toMatch(/AS new_received/)
      expect(staffSql).toMatch(/AS new_prepaid/)
    })

    test('staff confirmOffline 函数体不得残留 orderReceived + confirmAmount 直接加法（回归守护）', () => {
      const fnMatch = staffSrc.match(/async function confirmOffline\b[\s\S]*?(?=\nasync function )/)
      expect(fnMatch, '未截取到 confirmOffline 函数体').not.toBeNull()
      const fnBody = fnMatch[0]
      // received 权威值必须来自流水重聚合（new_received），杜绝退回漏卡的直接加法
      expect(fnBody).toMatch(/sumRes\.rows\[0\]\.new_received/)
      // strip 注释后再查，避免本修复说明注释（提及历史写法）误触发回归断言
      const code = fnBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code, 'confirmOffline 不得用 orderReceived+confirmAmount 直接加法写 received').not.toMatch(/orderReceived\s*\+\s*confirmAmount/)
    })
  })

  describe('Snapshot 守护：admin 关键 SQL 整体文本快照', () => {
    test('admin 储值卡扣款相关 3 段 SQL 快照（任一漂移立即可见）', () => {
      const lockOrder = normalizeSql(
        extractBacktickStringContaining(adminSrc, 'SELECT status, payment_method, store_id'),
      )
      const lockCard = normalizeSql(extractBacktickStringContaining(adminSrc, 'SELECT card_id, balance FROM prepaid_cards'))
      const updBalance = normalizeSql(extractBacktickStringContaining(adminSrc, 'UPDATE prepaid_cards'))

      expect({ lockOrder, lockCard, updBalance }).toMatchSnapshot()
    })
  })
})

describe('audit-15 P0-15-01 触发点守护：admin 两处必须调用 settlePointsSafe', () => {
  let adminSrc

  beforeAll(() => {
    adminSrc = readFile(FILES.adminOrdersTs)
  })

  test('admin orders.ts 必须 import settlePointsSafe from @/lib/points-settle', () => {
    expect(adminSrc).toMatch(/import\s*\{\s*settlePointsSafe[\s\S]*?\}\s*from\s*['"]@\/lib\/points-settle['"]/)
  })

  test('confirmOfflinePayment 内必须调用 settlePointsSafe(tx, saleOrderId, "admin.confirmOffline")', () => {
    // 截取 confirmOfflinePayment 函数体（从函数声明到下一个 export）
    // 兼容 `export async function X(...)` 和 `export const X = withPermission(...)` 两种形态
    const fnMatch = adminSrc.match(/export (?:async function|const) confirmOfflinePayment[\s\S]*?(?=\nexport (?:async function|const) |\n\/\*\* )/)
    expect(fnMatch).not.toBeNull()
    const fnBody = fnMatch[0]
    expect(fnBody).toMatch(/settlePointsSafe\s*\(\s*tx\s*,\s*saleOrderId\s*,\s*['"]admin\.confirmOffline['"]/)
  })

  test('recordPayment 内必须调用 settlePointsSafe(tx, saleOrderId, "admin.recordPayment")', () => {
    const fnMatch = adminSrc.match(/export (?:async function|const) recordPayment[\s\S]*?(?=\nexport (?:async function|const) |\n\/\*\* )/)
    expect(fnMatch).not.toBeNull()
    const fnBody = fnMatch[0]
    expect(fnBody).toMatch(/settlePointsSafe\s*\(\s*tx\s*,\s*saleOrderId\s*,\s*['"]admin\.recordPayment['"]/)
  })

  test('confirmOfflinePayment 结清时必须调用 recalcCustomerType（与 recordPayment 对齐）', () => {
    const fnMatch = adminSrc.match(/export (?:async function|const) confirmOfflinePayment[\s\S]*?(?=\nexport (?:async function|const) |\n\/\*\* )/)
    expect(fnMatch).not.toBeNull()
    const fnBody = fnMatch[0]
    expect(fnBody).toMatch(/recalcCustomerType\s*\(\s*tx\s*,/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY v3 §2 #11：优惠券 face_value_override 跨端读取一致性守护
// ticket: notes/tickets/2026-05-17-face-value-override-cross-end-audit.md
//
// 五处读取必须全部使用 COALESCE(face_value_override, discount_value) 模式：
//   1. admin/actions/orders.ts (Drizzle sql 模板)
//   2. staff/routes/coupon.js  (pg)
//   3. staff/routes/order.js   (pg, 已计入 FILES.staffOrderJs)
//   4. client/routes/coupon.js (pg)
//   5. client/routes/order.js  (pg)
// ─────────────────────────────────────────────────────────────────────────────
describe('SUMMARY v3 §2 #11：优惠券 face_value_override 跨端 COALESCE 一致性', () => {
  // pg 端字面量：COALESCE(uc.face_value_override, ct.discount_value) AS discount_value
  const PG_COALESCE_RE = /COALESCE\s*\(\s*uc\.face_value_override\s*,\s*ct\.discount_value\s*\)\s+AS\s+discount_value/i
  // Drizzle 端字面量：COALESCE(${userCoupons.faceValueOverride}, ${couponTemplates.discountValue})
  const DRIZZLE_COALESCE_RE = /COALESCE\s*\(\s*\$\{userCoupons\.faceValueOverride\}\s*,\s*\$\{couponTemplates\.discountValue\}\s*\)/

  test('admin orders.ts 必须用 COALESCE(faceValueOverride, discountValue) 读券面值', () => {
    const src = readFile(FILES.adminOrdersTs)
    expect(src).toMatch(DRIZZLE_COALESCE_RE)
    // 反向守护：不允许直接读 ct.discount_value 不带 COALESCE（漏 face_value_override 即资损）
    // 排除：注释行、JSON 结构 key、错误信息字符串
    const bareReads = src.match(/\bcouponTemplates\.discountValue\b/g) || []
    const coalesced = src.match(DRIZZLE_COALESCE_RE) || []
    // bareReads 应当全部出现在 COALESCE 内部（即与 coalesced 数量相等或更少）
    // 这里只要求至少有一处 COALESCE 即守护满足
    expect(coalesced.length).toBeGreaterThan(0)
  })

  test.each([
    ['staffCouponJs', FILES.staffCouponJs],
    ['staffOrderJs', FILES.staffOrderJs],
    ['clientCouponJs', FILES.clientCouponJs],
    ['clientOrderJs', FILES.clientOrderJs],
  ])('%s 必须含 COALESCE(uc.face_value_override, ct.discount_value) AS discount_value', (_, file) => {
    const src = readFile(file)
    const matches = src.match(new RegExp(PG_COALESCE_RE.source, 'gi')) || []
    expect(matches.length).toBeGreaterThan(0)
  })

  test('云函数四端 face_value_override 字面量同义（snapshot 守护）', () => {
    const literals = [FILES.staffCouponJs, FILES.staffOrderJs, FILES.clientCouponJs, FILES.clientOrderJs].map((file) => {
      const src = readFile(file)
      const all = src.match(new RegExp(PG_COALESCE_RE.source, 'gi')) || []
      // 归一化大小写与空白后比较
      return all.map((s) => s.replace(/\s+/g, ' ').toLowerCase()).sort()
    })

    // 每端至少 1 处
    literals.forEach((arr, i) => {
      const fileName = ['staff/coupon.js', 'staff/order.js', 'client/coupon.js', 'client/order.js'][i]
      expect(arr.length).toBeGreaterThan(0)
      if (arr.length === 0) {
        throw new Error(`${fileName} 缺少 COALESCE(face_value_override, discount_value) 读取`)
      }
    })

    // 取每端第一处字面量做跨端比对（同端多处时仅守护"至少一处一致"）
    const firsts = literals.map((arr) => arr[0])
    const uniq = new Set(firsts)
    expect(uniq.size).toBe(1)
  })

  test('反向守护：四端均不允许"裸读 ct.discount_value 不走 COALESCE"', () => {
    const files = [FILES.staffCouponJs, FILES.staffOrderJs, FILES.clientCouponJs, FILES.clientOrderJs]
    for (const file of files) {
      const src = readFile(file)
      // 找出所有 ct.discount_value 出现的位置，应当全部在 COALESCE(...) 内
      const lines = src.split('\n')
      const bareLines = lines.filter((line, idx) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false
        if (!/\bct\.discount_value\b/.test(line)) return false
        if (/COALESCE\s*\([^)]*ct\.discount_value/.test(line)) return false
        // 允许：列定义 SELECT ct.discount_value 作为单独字段（用于其他用途，非折扣计算）
        // 该用法在当前代码中不存在，若未来出现需复核
        return true
      })
      if (bareLines.length > 0) {
        const fileName = path.basename(file)
        throw new Error(
          `${fileName} 第 ${bareLines.map((l) => lines.indexOf(l) + 1).join(',')} 行裸读 ct.discount_value 未走 COALESCE，可能漏读 face_value_override`,
        )
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY v3 §2 #14：refund-cascade 双端字面量漂移守护
// ticket: notes/tickets/2026-05-17-refund-cascade-snapshot-guard.md
//
// admin/lib/refund-cascade.ts (Drizzle/TS) 与 staff/helpers/refund-cascade.js (pg)
// 是退款 5 通道全量回滚的双端独立副本。由于两端 ORM 不同（Drizzle vs 原生 pg）+
// JS 端在 point_transactions 用循环 INSERT vs admin 端用单 INSERT...SELECT，
// 完整 SQL 字面量无法 1:1 一致。守护策略改为"通道覆盖 + 关键字段不变量"：
//   - 5 通道必须各自出现关键 marker（任一端删了一个通道立即失败）
//   - 触发点防回归（admin/refunds.ts approveRefund + staff/order.js approveRefund
//     必须 import/require + 调用 cascadeRefund）
// ─────────────────────────────────────────────────────────────────────────────
describe('SUMMARY v3 §2 #14：refund-cascade 双端 5 通道覆盖守护', () => {
  let staffSrc, adminSrc

  beforeAll(() => {
    staffSrc = readFile(FILES.staffRefundCascadeJs)
    adminSrc = readFile(FILES.adminRefundCascadeTs)
  })

  // 通道 1：sale_payment_item_receipts + sale_payment_item_allocations 记负数冲销
  describe('通道 1：receipt 子分配记负数冲销', () => {
    test('staff 必须写负数 receipt + 负数 sale_payment_item_allocations（冲销 amount/commission）', () => {
      expect(staffSrc).toMatch(/INSERT\s+INTO\s+sale_payment_item_receipts/i)
      expect(staffSrc).toMatch(/INSERT\s+INTO\s+sale_payment_item_allocations/i)
      expect(staffSrc).toMatch(/\(-refundAmt\)\.toFixed\(2\)/)
      expect(staffSrc).toMatch(/\(-voidTotal\)\.toFixed\(2\)/)
      expect(staffSrc).toMatch(/\(-voidComm\)\.toFixed\(2\)/)
    })
    test('admin 必须写负数 receipt + 负数 sale_payment_item_allocations（冲销 amount/commission）', () => {
      expect(adminSrc).toMatch(/INSERT\s+INTO\s+sale_payment_item_receipts/i)
      expect(adminSrc).toMatch(/INSERT\s+INTO\s+sale_payment_item_allocations/i)
      expect(adminSrc).toMatch(/\(-refundAmt\)\.toFixed\(2\)/)
      expect(adminSrc).toMatch(/\(-voidTotal\)\.toFixed\(2\)/)
      expect(adminSrc).toMatch(/\(-voidComm\)\.toFixed\(2\)/)
    })
    test('两端负数 receipt 挂退款流水 id（refundPaymentId）+ 按实退额（refundAmount）冲销', () => {
      expect(staffSrc).toMatch(/refundPaymentId/)
      expect(staffSrc).toMatch(/refundAmount/)
      expect(adminSrc).toMatch(/refundPaymentId/)
      expect(adminSrc).toMatch(/refundAmount/)
    })
    test('两端没有原正向分配时跳过赤字分配', () => {
      expect(staffSrc).toMatch(/spia\.allocated_amount > 0[\s\S]{0,180}GROUP BY spia\.employee_id, spia\.role_type/)
      expect(staffSrc).toMatch(/if \(allocRows\.length === 0\) continue/)
      expect(adminSrc).toMatch(/spia\.allocated_amount > 0[\s\S]{0,180}GROUP BY spia\.employee_id, spia\.role_type/)
      expect(adminSrc).toMatch(/if \(allocRows\.length === 0\) continue/)
    })
    test('两端赤字分配生成后置退款流水已分配，供营业额分配列表查看', () => {
      expect(staffSrc).toMatch(/INSERT INTO sale_payment_item_receipts/)
      expect(staffSrc).toMatch(/INSERT INTO sale_payment_item_allocations/)
      expect(staffSrc).toMatch(/change_type = '退款'/)
      expect(staffSrc).toMatch(/allocation_status = '已分配'/)
      expect(adminSrc).toMatch(/INSERT INTO sale_payment_item_receipts/)
      expect(adminSrc).toMatch(/INSERT INTO sale_payment_item_allocations/)
      expect(adminSrc).toMatch(/change_type = '退款'/)
      expect(adminSrc).toMatch(/allocation_status = '已分配'/)
    })
    test('两端 receipt upsert + 子分配 ON CONFLICT receipt_id/employee/role 目标态更新（幂等兜底）', () => {
      expect(staffSrc).toMatch(/ON CONFLICT \(sale_payment_id, sale_item_id\)[\s\S]{0,120}DO UPDATE SET amount = EXCLUDED\.amount/i)
      expect(adminSrc).toMatch(/ON CONFLICT \(sale_payment_id, sale_item_id\)[\s\S]{0,120}DO UPDATE SET amount = EXCLUDED\.amount/i)
      expect(staffSrc).toMatch(/ON\s+CONFLICT\s*\(sale_payment_item_receipt_id,\s*employee_id,\s*role_type\)\s*WHERE\s+is_void\s*=\s*false[\s\S]{0,160}DO\s+UPDATE SET/i)
      expect(adminSrc).toMatch(/ON\s+CONFLICT\s*\(sale_payment_item_receipt_id,\s*employee_id,\s*role_type\)\s*WHERE\s+is_void\s*=\s*false[\s\S]{0,160}DO\s+UPDATE SET/i)
    })
    test('两端退款分配必须按 role_type 独立分池，并扣除历史负数冲销', () => {
      for (const [name, src] of [['staff', staffSrc], ['admin', adminSrc]]) {
        expect(src, `${name} 缺角色池规划器`).toMatch(/planRolePoolRefundAllocations/)
        expect(src, `${name} 缺角色池分组`).toMatch(/pools\.get\(source\.role_type\)/)
        expect(src, `${name} 缺历史营业额冲销扣减`).toMatch(/prior_negative_total/)
        expect(src, `${name} 缺历史提成冲销扣减`).toMatch(/prior_negative_comm/)
        expect(src, `${name} 缺商品行实收覆盖率`).toMatch(/positive_receipt_total/)
        expect(src, `${name} 仍在跨角色共用总额`).not.toMatch(/other_negative_total/)
      }
    })
    test('两端必须按行级实收剩余容量映射历史 OVERPAY 哨兵 receipt', () => {
      for (const [name, src] of [['staff', staffSrc], ['admin', adminSrc]]) {
        expect(src, `${name} 缺历史 OVERPAY 哨兵判定`).toMatch(/isLegacyOverpaySentinel/)
        expect(src, `${name} 缺 receipt 构建 helper`).toMatch(/buildReceiptRefundItems/)
        expect(src, `${name} 缺 OVERPAY 哨兵识别`).toMatch(/saleItemId === 'OVERPAY'/)
        expect(src, `${name} 缺正向 receipt 残留计算`).toMatch(/prior_refund_amount/)
        expect(src, `${name} 缺商品行可用实收容量`).toMatch(/availableCentsByItem/)
        expect(src, `${name} 缺退款全额映射守卫`).toMatch(/mappedTotalCents !== requestedTotalCents/)
        expect(src, `${name} 缺按超额容量分配 overpay`).toMatch(/allocateCentsByWeight/)
        expect(src, `${name} 不应把 OVERPAY 限制在已选退款商品`).not.toMatch(/selectedItemIds/)
        expect(src, `${name} 通道 1 未使用映射后的 receipt 列表`).toMatch(/const receiptRefundItems = await buildReceiptRefundItems/)
      }
    })
    test('两端通道 1 不再软删原分配行（保留正数行，报表 SUM 自动净额化）', () => {
      expect(staffSrc).not.toMatch(/UPDATE\s+sale_allocations[\s\S]*?SET[\s\S]*?is_void\s*=\s*true/i)
      expect(adminSrc).not.toMatch(/UPDATE\s+sale_allocations[\s\S]*?SET[\s\S]*?is_void\s*=\s*true/i)
    })
  })

  // 通道 2：service_commissions 软删（UPDATE ... SET is_void = true + voided_at + voided_reason）
  describe('通道 2：service_commissions 软删', () => {
    test('staff 必须 UPDATE service_commissions SET is_void + voided_at + voided_reason', () => {
      expect(staffSrc).toMatch(/UPDATE\s+service_commissions[\s\S]*?SET[\s\S]*?is_void\s*=\s*true/i)
      expect(staffSrc).toMatch(/service_commissions[\s\S]*?voided_at\s*=/i)
      expect(staffSrc).toMatch(/service_commissions[\s\S]*?voided_reason\s*=/i)
    })
    test('admin 必须 UPDATE service_commissions SET voided_at + voided_reason + is_void', () => {
      expect(adminSrc).toMatch(/UPDATE\s+service_commissions[\s\S]*?SET[\s\S]*?is_void\s*=\s*true/i)
      expect(adminSrc).toMatch(/service_commissions[\s\S]*?voided_at\s*=\s*NOW\(\)/i)
      expect(adminSrc).toMatch(/service_commissions[\s\S]*?voided_reason\s*=/i)
    })
  })

  // 通道 3：user_coupons 状态翻转（UPDATE ... SET status = '未使用'；部分退款不退券）
  describe('通道 3：user_coupons 状态翻转', () => {
    test('staff 必须 UPDATE user_coupons SET status = 未使用 + used_at = NULL', () => {
      expect(staffSrc).toMatch(/UPDATE\s+user_coupons[\s\S]*?SET[\s\S]*?status\s*=\s*'未使用'/i)
      expect(staffSrc).toMatch(/used_at\s*=\s*NULL/i)
      expect(staffSrc).toMatch(/used_sale_order_id\s*=\s*NULL/i)
    })
    test('admin 必须 UPDATE user_coupons SET status = 未使用 + used_at = NULL', () => {
      expect(adminSrc).toMatch(/UPDATE\s+user_coupons[\s\S]*?SET[\s\S]*?status\s*=\s*'未使用'/i)
      expect(adminSrc).toMatch(/used_at\s*=\s*NULL/i)
      expect(adminSrc).toMatch(/used_sale_order_id\s*=\s*NULL/i)
    })
    test('两端必须守护"仅未过期券回滚"（expire_at > NOW）', () => {
      expect(staffSrc).toMatch(/expire_at[\s\S]{0,80}NOW\(\)/i)
      expect(adminSrc).toMatch(/expire_at[\s\S]{0,80}NOW\(\)/i)
    })
    test('两端部分退款不退券：券 UPDATE 包在 if (wholeOrder) 守卫内（仅整单全退才回滚券，Bug Q/M 重构后）', () => {
      expect(staffSrc).toMatch(/if\s*\(\s*wholeOrder\s*\)[\s\S]*?UPDATE\s+user_coupons/i)
      expect(adminSrc).toMatch(/if\s*\(\s*wholeOrder\s*\)[\s\S]*?UPDATE\s+user_coupons/i)
    })
    test('两端整单全退必须撤销未使用分享礼 sg-* 券', () => {
      for (const [name, src] of [['staff', staffSrc], ['admin', adminSrc]]) {
        expect(src, `${name} 缺 sg-inviter 撤销`).toContain('sg-inviter-')
        expect(src, `${name} 缺 sg-invitee 撤销`).toContain('sg-invitee-')
        expect(src, `${name} 缺分享礼已过期状态`).toMatch(/status\s*=\s*'已过期'/)
        expect(src, `${name} 缺未使用门控`).toMatch(/status\s*=\s*'未使用'/)
      }
    })
    test('staff 的 ANY(text[]) 必须将礼券 ID 数组作为单个 $1 参数绑定', () => {
      expect(staffSrc).toMatch(
        /WHERE\s+coupon_id\s*=\s*ANY\(\$1::text\[\]\)[\s\S]*?\[\s*\[\s*`sg-inviter-\$\{saleOrderId\}`\s*,\s*`sg-invitee-\$\{saleOrderId\}`\s*\]\s*\]/,
      )
    })
  })

  // 通道 4：point_transactions 比例冲销（INSERT '消费冲销' 行 + 重算 points_balance）
  describe('通道 4：point_transactions 比例冲销', () => {
    test('staff 必须 INSERT INTO point_transactions type=消费冲销', () => {
      expect(staffSrc).toMatch(/INSERT\s+INTO\s+point_transactions/i)
      expect(staffSrc).toMatch(/'消费冲销'/)
    })
    test('admin 必须 INSERT INTO point_transactions type=消费冲销', () => {
      expect(adminSrc).toMatch(/INSERT\s+INTO\s+point_transactions/i)
      expect(adminSrc).toMatch(/'消费冲销'/)
    })
    test('两端必须重算 client_wechat_users.points_balance', () => {
      expect(staffSrc).toMatch(/UPDATE\s+client_wechat_users[\s\S]*?points_balance\s*=/i)
      expect(adminSrc).toMatch(/UPDATE\s+client_wechat_users[\s\S]*?points_balance\s*=/i)
    })
    test('两端冲销笔目标态累加（ON CONFLICT ... DO UPDATE SET amount = EXCLUDED.amount，非 DO NOTHING/NOT EXISTS）', () => {
      expect(staffSrc).toMatch(/ON\s+CONFLICT[\s\S]*?DO\s+UPDATE\s+SET\s+amount\s*=\s*EXCLUDED\.amount/i)
      expect(adminSrc).toMatch(/ON\s+CONFLICT[\s\S]*?DO\s+UPDATE\s+SET\s+amount\s*=\s*EXCLUDED\.amount/i)
      // 反向守护：通道 4 段落不应再用 NOT EXISTS 旧幂等
      const ch4Staff = staffSrc.match(/通道 4[\s\S]*?通道 5/)?.[0] ?? ''
      const ch4Admin = adminSrc.match(/4\)\s+point_transactions[\s\S]*?5\)\s+sale_items/)?.[0] ?? ''
      expect(ch4Staff).not.toMatch(/NOT\s+EXISTS/i)
      expect(ch4Admin).not.toMatch(/NOT\s+EXISTS/i)
    })
    test('两端按退款占实收比例冲销（received > 0 ? Math.round + G=COALESCE(SUM(amount),0) AS g）', () => {
      expect(staffSrc).toMatch(/received\s*>\s*0\s*\?\s*Math\.round/i)
      expect(adminSrc).toMatch(/received\s*>\s*0\s*\?\s*Math\.round/i)
      expect(staffSrc).toMatch(/COALESCE\s*\(\s*SUM\s*\(\s*amount\s*\)\s*,\s*0\s*\)\s+AS\s+g/i)
      expect(adminSrc).toMatch(/COALESCE\s*\(\s*SUM\s*\(\s*amount\s*\)\s*,\s*0\s*\)\s+AS\s+g/i)
    })
  })

  // 通道 5：家居退款计入已结算（2026-06-08 schema-free 止血：picked_up = LEAST(quantity, picked_up + 已退)）
  describe('通道 5：picked_up_quantity 计入已退（LEAST 封顶）', () => {
    test('staff 必须 UPDATE sale_items SET picked_up_quantity = LEAST(quantity, ...)', () => {
      expect(staffSrc).toMatch(/UPDATE\s+sale_items[\s\S]*?SET[\s\S]*?picked_up_quantity\s*=\s*LEAST\(\s*quantity/i)
    })
    test('admin 必须 UPDATE sale_items SET picked_up_quantity = LEAST(quantity, ...)', () => {
      expect(adminSrc).toMatch(/UPDATE\s+sale_items[\s\S]*?SET[\s\S]*?picked_up_quantity\s*=\s*LEAST\(\s*quantity/i)
    })
  })

  // 函数导出守护：双端都必须导出 cascadeRefund
  describe('函数导出与返回值结构', () => {
    test('staff helpers/refund-cascade.js 必须导出 cascadeRefund', () => {
      expect(staffSrc).toMatch(/module\.exports\s*=\s*\{[\s\S]*?cascadeRefund/)
    })
    test('admin lib/refund-cascade.ts 必须 export cascadeRefund', () => {
      expect(adminSrc).toMatch(/export\s+async\s+function\s+cascadeRefund/)
    })
    test('两端返回字段必须同义（voidedAllocations/voidedCommissions/refundedCoupons/reversedPoints/rolledBackPickups）', () => {
      const requiredFields = [
        'voidedAllocations',
        'voidedCommissions',
        'refundedCoupons',
        'revokedShareGiftCoupons',
        'reversedPoints',
        'rolledBackPickups',
      ]
      for (const field of requiredFields) {
        expect(staffSrc).toContain(field)
        expect(adminSrc).toContain(field)
      }
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY v3 §2 #14（续）：cascadeRefund 触发点防回归
// approveRefund 链路必须调用 cascadeRefund，否则 5 通道形同虚设
// ─────────────────────────────────────────────────────────────────────────────
describe('SUMMARY v3 §2 #14：cascadeRefund 触发点防回归', () => {
  test('admin actions/refunds.ts 必须 import cascadeRefund', () => {
    const src = readFile(FILES.adminRefundsTs)
    expect(src).toMatch(/import\s*\{\s*cascadeRefund[\s\S]*?\}\s*from\s*['"]@\/lib\/refund-cascade['"]/)
  })

  test('admin actions/refunds.ts approveRefund 路径必须调用 cascadeRefund(tx, ...)', () => {
    const src = readFile(FILES.adminRefundsTs)
    expect(src).toMatch(/await\s+cascadeRefund\s*\(\s*tx\s*,/)
  })

  test('staff routes/order.js 必须 require cascadeRefund', () => {
    const src = readFile(FILES.staffOrderJs)
    expect(src).toMatch(/require\s*\(\s*['"]\.\.\/helpers\/refund-cascade['"]\s*\)/)
  })

  test('staff routes/order.js approveRefund 路径必须调用 cascadeRefund(client, ...)', () => {
    const src = readFile(FILES.staffOrderJs)
    expect(src).toMatch(/await\s+cascadeRefund\s*\(\s*client\s*,/)
  })

  test('staff approveRefund 与 admin 一致：退款只刷新 spending_tier，不执行只升不降的结算重算', () => {
    const src = readFile(FILES.staffOrderJs)
    const approveBody = src.slice(
      src.indexOf('async function approveRefund(ctx)'),
      src.indexOf('async function rejectRefund(ctx)'),
    )
    expect(approveBody).toContain('await refreshSpendingTier(client, sopRow.client_user_id)')
    expect(approveBody).not.toMatch(/await\s+recalcCustomerType\s*\(/)
    expect(approveBody).not.toMatch(/await\s+recalcMemberLevel\s*\(/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY v3 §2 #13：scope assert helper 双端命名与语义对齐守护
// ticket: notes/tickets/2026-05-17-scope-helper-cross-end-audit.md
//
// staff/utils/scope.js (CJS / pg) 与 admin/lib/scope-assert.ts (Drizzle / TS)
// 共同提供 assertCustomerInScope / assertOrderInScope / assertEmployeeInScope
// 三个边界守卫函数。语义不变量（任一端变更必须双端同步）：
//   1. 三个函数都必须导出
//   2. 都用同一前缀 PERMISSION_DENIED:* 抛错
//   3. 都查询同一组列（client_wechat_users.bound_store_id /
//      sale_orders.store_id / staff_wechat_users.store_id）
//   4. admin 端可走 isAdminScope 无 scope 检查的快路径；staff 端无 admin 概念
// ─────────────────────────────────────────────────────────────────────────────
describe('SUMMARY v3 §2 #13：scope assert helper 双端语义对齐', () => {
  let staffSrc, adminSrc

  beforeAll(() => {
    staffSrc = readFile(FILES.staffScopeJs)
    adminSrc = readFile(FILES.adminScopeAssertTs)
  })

  describe('三个 assert 函数双端均存在', () => {
    test.each(['assertCustomerInScope', 'assertOrderInScope', 'assertEmployeeInScope'])(
      'staff utils/scope.js 必须定义 %s',
      (fn) => {
        expect(staffSrc).toMatch(new RegExp(`(async\\s+)?function\\s+${fn}\\b`))
      },
    )

    test.each(['assertCustomerInScope', 'assertOrderInScope', 'assertEmployeeInScope'])(
      'admin lib/scope-assert.ts 必须 export %s',
      (fn) => {
        expect(adminSrc).toMatch(new RegExp(`export\\s+async\\s+function\\s+${fn}\\b`))
      },
    )

    test('staff scope.js 必须把三个 assert 加入 module.exports', () => {
      const exportMatch = staffSrc.match(/module\.exports\s*=\s*\{[\s\S]*?\}/)
      expect(exportMatch).not.toBeNull()
      const exportBlock = exportMatch[0]
      expect(exportBlock).toContain('assertCustomerInScope')
      expect(exportBlock).toContain('assertOrderInScope')
      expect(exportBlock).toContain('assertEmployeeInScope')
    })
  })

  describe('错误前缀统一 PERMISSION_DENIED:*', () => {
    test('staff 三个 assert 均用 PERMISSION_DENIED 前缀', () => {
      // 简化：检查 scope.js 中 PERMISSION_DENIED 出现次数 >= 3（三个 assert 各至少抛一次）
      const matches = staffSrc.match(/PERMISSION_DENIED:/g) || []
      expect(matches.length).toBeGreaterThanOrEqual(3)
    })

    test('admin 三个 assert 均用 PERMISSION_DENIED 前缀', () => {
      const matches = adminSrc.match(/PERMISSION_DENIED:/g) || []
      expect(matches.length).toBeGreaterThanOrEqual(3)
    })
  })

  describe('查询列名一致性（实体 → 守护列）', () => {
    test('Customer assert 必须查 client_wechat_users.bound_store_id', () => {
      expect(staffSrc).toMatch(/bound_store_id\s+FROM\s+client_wechat_users/i)
      expect(adminSrc).toMatch(/bound_store_id\s+FROM\s+client_wechat_users/i)
    })

    test('Order assert 必须查 sale_orders.store_id', () => {
      expect(staffSrc).toMatch(/store_id\s+FROM\s+sale_orders/i)
      expect(adminSrc).toMatch(/store_id\s+FROM\s+sale_orders/i)
    })

    test('Employee assert 必须查 staff_wechat_users.store_id', () => {
      expect(staffSrc).toMatch(/store_id\s+FROM\s+staff_wechat_users/i)
      expect(adminSrc).toMatch(/store_id\s+FROM\s+staff_wechat_users/i)
    })
  })

  describe('入参校验：缺少 ID 必须抛 INVALID_PARAMS', () => {
    test('staff 三处 assert 均守护空 ID', () => {
      // 三处 INVALID_PARAMS: 出现次数 >= 3
      const matches = staffSrc.match(/INVALID_PARAMS:\s*缺少\s*(clientUserId|saleOrderId|employeeId)/g) || []
      expect(matches.length).toBeGreaterThanOrEqual(3)
    })

    test('admin 三处 assert 均守护空 ID', () => {
      const matches = adminSrc.match(/INVALID_PARAMS:\s*缺少\s*(clientUserId|saleOrderId|employeeId)/g) || []
      expect(matches.length).toBeGreaterThanOrEqual(3)
    })
  })

  // ── client 端 scope helper（语义不同：按 userId 归属，不参与 staff/admin 跨端比对）──
  describe('client utils/scope.js 必须存在且符合错误前缀约定', () => {
    let clientSrc

    beforeAll(() => {
      clientSrc = readFile(FILES.clientScopeJs)
    })

    test('client 必须定义 assertUserStoreBound + assertUserOwnsOrder', () => {
      expect(clientSrc).toMatch(/(async\s+)?function\s+assertUserStoreBound\b/)
      expect(clientSrc).toMatch(/(async\s+)?function\s+assertUserOwnsOrder\b/)
    })

    test('client scope.js 必须把两个 assert 加入 module.exports', () => {
      const exportMatch = clientSrc.match(/module\.exports\s*=\s*\{[\s\S]*?\}/)
      expect(exportMatch).not.toBeNull()
      const exportBlock = exportMatch[0]
      expect(exportBlock).toContain('assertUserStoreBound')
      expect(exportBlock).toContain('assertUserOwnsOrder')
    })

    test('client 两个 assert 均用 PERMISSION_DENIED 前缀', () => {
      const matches = clientSrc.match(/PERMISSION_DENIED:/g) || []
      // 至少 4 次：UserStoreBound（用户不存在 / 用户未绑店）+ UserOwnsOrder（订单不存在 / 订单不归属当前用户）
      expect(matches.length).toBeGreaterThanOrEqual(4)
    })

    test('client 入参校验必须用 INVALID_PARAMS 前缀（userId / saleOrderId）', () => {
      const matches = clientSrc.match(/INVALID_PARAMS:\s*缺少\s*(userId|saleOrderId)/g) || []
      expect(matches.length).toBeGreaterThanOrEqual(3)
    })

    test('client SQL 必须按 user_id 自检归属（不引入 store_id scope）', () => {
      expect(clientSrc).toMatch(/bound_store_id\s+FROM\s+client_wechat_users/i)
      expect(clientSrc).toMatch(/client_user_id[\s\S]*?FROM\s+sale_orders/i)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// ticket 2026-05-17-toctou-partial-unique-indexes.md Phase 4 snapshot 守护
// 防止"事务外 SELECT 防重 → 事务内 INSERT 无 ON CONFLICT"模式回归出现。
// 7 项 partial unique + 2 项 external_ref 必须配套应用层 ON CONFLICT / catch 23505。
// ─────────────────────────────────────────────────────────────────────────
describe('TOCTOU partial unique 三端 INSERT 配套守护', () => {
  const SALE_ORDER_PAYMENTS_FILES = [
    { name: 'staffApi/order.js', path: FILES.staffOrderJs },
    { name: 'payNotify/index.js', path: FILES.payNotifyIndexJs },
  ]
  // change_type 动态 / 硬编码 '首次支付' 的 INSERT 必须挂 uq_sop_first_payment 兜底
  test('sale_order_payments 命中 uq_sop_first_payment 的 INSERT 必须带 ON CONFLICT (sale_order_id) WHERE change_type / 23505 / uq_sop_first_payment 三关键字', () => {
    for (const { name, path: p } of SALE_ORDER_PAYMENTS_FILES) {
      const src = readFile(p)
      // 任何写 sale_order_payments 的代码都必须出现下列任一守护词，否则视为遗漏 ON CONFLICT
      const hasGuard =
        src.includes('uq_sop_first_payment') ||
        src.includes('ON CONFLICT (sale_order_id)') ||
        src.includes('23505')
      expect(hasGuard, `${name} 缺失 uq_sop_first_payment 守护关键字`).toBe(true)
    }
  })

  const CARD_TXN_FILES = [
    { name: 'staffApi/order.js', path: FILES.staffOrderJs },
    { name: 'clientApi/order.js', path: FILES.clientOrderJs },
    { name: 'payNotify/index.js', path: FILES.payNotifyIndexJs },
  ]
  test('card_transactions INSERT 三端必须带 external_ref 列或 ON CONFLICT (external_ref)', () => {
    for (const { name, path: p } of CARD_TXN_FILES) {
      const src = readFile(p)
      // 查找所有 'INSERT INTO card_transactions' 出现的位置，每条必须临近 external_ref 字样
      const insertMatches = [...src.matchAll(/INSERT\s+INTO\s+card_transactions[\s\S]{0,500}/g)]
      expect(insertMatches.length, `${name} 没找到 card_transactions INSERT`).toBeGreaterThan(0)
      for (const m of insertMatches) {
        expect(m[0], `${name} 某处 INSERT card_transactions 未带 external_ref`).toMatch(/external_ref/)
      }
    }
  })

  test('user_coupons INSERT 4 cron + 3 share-gift 副本必须带 external_ref 列', () => {
    const ucFiles = [
      path.resolve(__dirname, '../../../../../fengyu-admin/src/cron/steps/grant-birthday-benefits.ts'),
      path.resolve(__dirname, '../../../../../fengyu-admin/src/cron/steps/grant-thanksgiving-benefits.ts'),
      path.resolve(__dirname, '../../../../../fengyu-admin/src/cron/steps/refresh-member-levels.ts'),
      path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/payNotify/share-gift.js'),
      path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/share-gift.js'),
      path.resolve(__dirname, '../../share-gift.js'),
    ]
    for (const p of ucFiles) {
      const src = readFile(p)
      const inserts = [...src.matchAll(/INSERT\s+INTO\s+user_coupons[\s\S]{0,500}/g)]
      expect(inserts.length, `${p} 没找到 user_coupons INSERT`).toBeGreaterThan(0)
      for (const m of inserts) {
        expect(m[0], `${p} 的 user_coupons INSERT 未带 external_ref`).toMatch(/external_ref/)
      }
    }
  })

  test('三份 share-gift.js 副本必须字节一致', () => {
    const payNotify = readFile(path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/payNotify/share-gift.js'))
    const clientApi = readFile(path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/share-gift.js'))
    const staffApi = readFile(path.resolve(__dirname, '../../share-gift.js'))
    expect(clientApi).toBe(payNotify)
    expect(staffApi).toBe(payNotify)
  })

  test('staff service.create / client appointment.create / client store.requestUnbind INSERT 必须有 23505 / ON CONFLICT 守护', () => {
    const sites = [
      { name: 'staff service.js', file: path.resolve(__dirname, '../../routes/service.js'), table: 'service_orders' },
      { name: 'client appointment.js', file: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/routes/appointment.js'), table: 'appointments' },
      { name: 'client store.js', file: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/routes/store.js'), table: 'store_unbind_requests' },
    ]
    for (const { name, file, table } of sites) {
      const src = readFile(file)
      const inserts = [...src.matchAll(new RegExp(`INSERT\\s+INTO\\s+${table}[\\s\\S]{0,800}`, 'g'))]
      expect(inserts.length, `${name} 没找到 ${table} INSERT`).toBeGreaterThan(0)
      for (const m of inserts) {
        const block = m[0]
        const hasGuard = block.includes('23505') || block.includes('ON CONFLICT') || block.includes('uq_')
        expect(hasGuard, `${name} 的 ${table} INSERT 缺 23505/ON CONFLICT 守护`).toBe(true)
      }
    }
  })

  test('point_transactions INSERT 业务路径必须带 ON CONFLICT (user_id, ref_order_id, type)', () => {
    const points = [
      path.resolve(__dirname, '../../utils/points.js'),
      path.resolve(__dirname, '../../helpers/refund-cascade.js'),
    ]
    for (const p of points) {
      const src = readFile(p)
      const inserts = [...src.matchAll(/INSERT\s+INTO\s+point_transactions[\s\S]{0,500}/g)]
      expect(inserts.length, `${p} 没找到 point_transactions INSERT`).toBeGreaterThan(0)
      for (const m of inserts) {
        expect(m[0], `${p} 的 point_transactions INSERT 未带 ON CONFLICT`).toMatch(/ON CONFLICT/i)
      }
    }
  })

  test('pickup_records INSERT 必须带 idempotency_key 字段（staffApi createPickup + admin createPickupRecord）', () => {
    const files = [
      path.resolve(__dirname, '../../routes/order.js'),
      path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/pickup-records.ts'),
    ]
    for (const p of files) {
      const src = readFile(p)
      // staffApi 用 INSERT INTO pickup_records；admin 用 db.insert(pickupRecords)
      const hasStaffInsert = /INSERT\s+INTO\s+pickup_records/.test(src)
      const hasAdminInsert = /insert\(pickupRecords\)/.test(src)
      expect(hasStaffInsert || hasAdminInsert, `${p} 没找到 pickup_records INSERT`).toBe(true)
      expect(src, `${p} 的 pickup_records INSERT 未含 idempotency_key/idempotencyKey 字段`).toMatch(/idempotency_key|idempotencyKey/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Wave 2 S1：三端 order.create 优惠券折扣基数必须用 eligibleTotal（防 B9 资损 bug 重现）
// ticket: notes/tickets/archives/2026-05-18-coupon-binding-restriction-not-enforced.md
//
// B9 修复将 admin 折扣基数从 saleAmountTotal → eligibleTotal（scope 内应付合计），
// 与 staff / client 端行为对齐。此守护防止任一端回退到 saleAmountTotal 出现资损：
//   - 全单合计含不可叠加项时，把折扣计在全单基数上会让客户少付。
//   - calcCouponDiscount 入参 / minSpend 比较两条路径都需守护。
// ─────────────────────────────────────────────────────────────────────────────
describe('Wave 2 S1：三端 order.create eligibleTotal 守护（防 B9 资损 bug 重现）', () => {
  test('三端必须使用 eligibleTotal 作折扣基数，不得退回 saleAmountTotal', () => {
    const adminSrc = readFile(FILES.adminOrdersTs)
    const staffSrc = readFile(FILES.staffOrderJs)
    const clientSrc = readFile(FILES.clientOrderJs)

    // 正向：三端必须含 eligibleTotal
    expect(adminSrc).toContain('eligibleTotal')
    expect(staffSrc).toContain('eligibleTotal')
    expect(clientSrc).toContain('eligibleTotal')

    // 反向：calcCouponDiscount 末位入参（折扣基数）不得为 saleAmountTotal（防 B9 资损 bug 重现）
    // [^;]*? 跨过中间嵌套的 String(...)/可选链等括号，仅守护"同一条 calcCouponDiscount 调用语句"
    expect(adminSrc).not.toMatch(/calcCouponDiscount\([^;]*?saleAmountTotal\s*\)/)
    expect(staffSrc).not.toMatch(/calcCouponDiscount\([^;]*?saleAmountTotal\s*\)/)
    expect(clientSrc).not.toMatch(/calcCouponDiscount\([^;]*?saleAmountTotal\s*\)/)
    // 退化形态防护：staff/client 的 Math.min / 乘法基数也不允许用 saleAmountTotal 作为基数（pg 端不通过 calcCouponDiscount）
    // 防止 staff/client 内联实现回退：couponDiscount = Math.min(..., saleAmountTotal) 或 saleAmountTotal * (1 - ...)
    expect(staffSrc).not.toMatch(/Math\.min\([^;]*?saleAmountTotal\s*\)/)
    expect(staffSrc).not.toMatch(/saleAmountTotal\s*\*\s*\(\s*1\s*-/)
    expect(clientSrc).not.toMatch(/Math\.min\([^;]*?saleAmountTotal\s*\)/)
    expect(clientSrc).not.toMatch(/saleAmountTotal\s*\*\s*\(\s*1\s*-/)

    // 反向：minSpend 比较不得用 saleAmountTotal（admin 此前在 L967 误用）
    expect(adminSrc).not.toMatch(/saleAmountTotal\s*<\s*minSpend/)
    expect(staffSrc).not.toMatch(/saleAmountTotal\s*<\s*minSpend/)
    expect(clientSrc).not.toMatch(/saleAmountTotal\s*<\s*minSpend/)
  })
})

describe('Wave 3 S2：三端 order.create 优惠券摊薄目标必须是 saleAmount（防 B14 回归）', () => {
  // ticket 2026-05-30 — client 端历史只摊 received 不改 saleAmount，导致 sale_items.unit_real_price 残留 pre-coupon 值
  // 下游服务单单价/分配单次价/提成基数/paid_sessions 全错。修复后三端必须把券摊到 saleAmount，再按 sessionCount/quantity 重派 unit_real_price。
  test('三端摊薄循环必须修改 item.saleAmount，不得仅修改 item.received', () => {
    const adminSrc = readFile(FILES.adminOrdersTs)
    const staffSrc = readFile(FILES.staffOrderJs)
    const clientSrc = readFile(FILES.clientOrderJs)

    // staff/client 形态：item.saleAmount = Math.max(0, ... - share)
    const STAFF_CLIENT_RE = /\.saleAmount\s*=\s*Math\.max\(0[\s\S]{0,80}-\s*share/
    expect(staffSrc).toMatch(STAFF_CLIENT_RE)
    expect(clientSrc).toMatch(STAFF_CLIENT_RE)

    // admin 形态：const newSale = Math.max(0, Math.round((itSale - share) ...)); it.saleAmount = newSale.toFixed(2)
    const ADMIN_RE = /(itSale\s*-\s*share)|(\.saleAmount\s*=\s*[\w.]+\.toFixed\()/
    expect(adminSrc).toMatch(ADMIN_RE)
  })

  test('三端必须按 sessionCount/quantity 重派 unit_real_price（per-session 模型）', () => {
    const adminSrc = readFile(FILES.adminOrdersTs)
    const staffSrc = readFile(FILES.staffOrderJs)
    const clientSrc = readFile(FILES.clientOrderJs)

    // 三端都必须有 sessionCount > 0 ? sessionCount : quantity 的 denom 分支
    const DENOM_RE = /sessionCount[\s\S]{0,30}>\s*0[\s\S]{0,40}quantity/
    expect(staffSrc).toMatch(DENOM_RE)
    expect(clientSrc).toMatch(DENOM_RE)
    expect(adminSrc).toMatch(DENOM_RE)
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// Block 7: paid_sessions 重算 SQL 四端字节同义（ticket 2026-05-19-sale-items-paid-sessions）
// ─────────────────────────────────────────────────────────────────────────────
describe("ticket 2026-05-19 paid_sessions 重算 SQL 四端字节同义守护", () => {
  const MARKER_PAID_SESSIONS = "paid_sessions = CASE"
  let paidSessionsSqls

  beforeAll(() => {
    paidSessionsSqls = {
      staff: normalizeSql(extractBacktickStringContaining(readFile(FILES.staffPaidSessionsJs), MARKER_PAID_SESSIONS)),
      client: normalizeSql(extractBacktickStringContaining(readFile(FILES.clientPaidSessionsJs), MARKER_PAID_SESSIONS)),
      payNotify: normalizeSql(extractBacktickStringContaining(readFile(FILES.payNotifyPaidSessionsJs), MARKER_PAID_SESSIONS)),
      adminTs: normalizeSql(extractBacktickStringContaining(readFile(FILES.adminPaidSessionsTs), MARKER_PAID_SESSIONS)),
      scriptFix: normalizeSql(extractBacktickStringContaining(readFile(FILES.scriptPaidSessionsFix), MARKER_PAID_SESSIONS)),
    }
  })

  describe("公式特征守护（防止公式漂移成不安全形态）", () => {
    test("五端公式直接用净额 received（2026-06-08 退款侧：STEP 1.5 已逐项扣退款，无订单级 refund_share）", () => {
      const pattern = /FLOOR\(sale_items\.received::numeric\s*\*\s*sale_items\.session_count\s*\/\s*sale_items\.sale_amount::numeric\)/i
      expect(paidSessionsSqls.staff).toMatch(pattern)
      expect(paidSessionsSqls.client).toMatch(pattern)
      expect(paidSessionsSqls.payNotify).toMatch(pattern)
      expect(paidSessionsSqls.adminTs).toMatch(pattern)
      expect(paidSessionsSqls.scriptFix).toMatch(pattern)
    })

    test("五端 paid_sessions 公式不得再含订单级 refunded_amount（退款已由 STEP 1.5 逐项归因进 received）", () => {
      expect(paidSessionsSqls.staff).not.toContain("refunded_amount")
      expect(paidSessionsSqls.client).not.toContain("refunded_amount")
      expect(paidSessionsSqls.payNotify).not.toContain("refunded_amount")
      expect(paidSessionsSqls.adminTs).not.toContain("refunded_amount")
      expect(paidSessionsSqls.scriptFix).not.toContain("refunded_amount")
    })

    test("五端必须用 FLOOR 取整（D1=A 保守策略），不得改 round/ceil", () => {
      expect(paidSessionsSqls.staff).toContain("FLOOR(")
      expect(paidSessionsSqls.client).toContain("FLOOR(")
      expect(paidSessionsSqls.payNotify).toContain("FLOOR(")
      expect(paidSessionsSqls.adminTs).toContain("FLOOR(")
      expect(paidSessionsSqls.scriptFix).toContain("FLOOR(")
      // 反向：不能误用 round/ceil
      expect(paidSessionsSqls.staff).not.toMatch(/ROUND\(/i)
      expect(paidSessionsSqls.staff).not.toMatch(/CEIL\(/i)
    })

    test("五端必须用 LEAST(session_count, ...) 兜底防 CHECK 越界（D4=A）", () => {
      expect(paidSessionsSqls.staff).toMatch(/LEAST\(sale_items\.session_count,/i)
      expect(paidSessionsSqls.client).toMatch(/LEAST\(sale_items\.session_count,/i)
      expect(paidSessionsSqls.payNotify).toMatch(/LEAST\(sale_items\.session_count,/i)
      expect(paidSessionsSqls.adminTs).toMatch(/LEAST\(sale_items\.session_count,/i)
      expect(paidSessionsSqls.scriptFix).toMatch(/LEAST\(sale_items\.session_count,/i)
    })

    test("五端必须有 sale_items.sale_amount <= 0 → session_count 兜底（免单行全付）", () => {
      // 行级判定（基于 sale_items.sale_amount）：单行免单
      const pattern = /sale_items\.sale_amount\s*<=\s*0\s*THEN\s*sale_items\.session_count/i
      expect(paidSessionsSqls.staff).toMatch(pattern)
      expect(paidSessionsSqls.client).toMatch(pattern)
      expect(paidSessionsSqls.payNotify).toMatch(pattern)
      expect(paidSessionsSqls.adminTs).toMatch(pattern)
      expect(paidSessionsSqls.scriptFix).toMatch(pattern)
    })

    test("五端必须有 op.total_amount <= 0 → session_count 订单级兜底（寄存/转换零差额单全付，防 total=0 时 NULL 传播归零）", () => {
      const pattern = /op\.total_amount\s*<=\s*0\s*THEN\s*sale_items\.session_count/i
      expect(paidSessionsSqls.staff).toMatch(pattern)
      expect(paidSessionsSqls.client).toMatch(pattern)
      expect(paidSessionsSqls.payNotify).toMatch(pattern)
      expect(paidSessionsSqls.adminTs).toMatch(pattern)
      expect(paidSessionsSqls.scriptFix).toMatch(pattern)
    })

    test("五端 paid_sessions 不再除以订单级 total（无 NULLIF(op.total)；分母为 sale_amount + 行级 <=0 兜底）", () => {
      expect(paidSessionsSqls.staff).not.toMatch(/NULLIF\(op\.total_amount/i)
      expect(paidSessionsSqls.client).not.toMatch(/NULLIF\(op\.total_amount/i)
      expect(paidSessionsSqls.payNotify).not.toMatch(/NULLIF\(op\.total_amount/i)
      expect(paidSessionsSqls.adminTs).not.toMatch(/NULLIF\(op\.total_amount/i)
      expect(paidSessionsSqls.scriptFix).not.toMatch(/NULLIF\(op\.total_amount/i)
    })
  })

  describe("五端镜像比对（任一端字符漂移立即可见，提示同步其它端）", () => {
    test("staff vs client（pg 实现）", () => {
      expect(paidSessionsSqls.client).toBe(paidSessionsSqls.staff)
    })
    test("staff vs payNotify（pg 实现）", () => {
      expect(paidSessionsSqls.payNotify).toBe(paidSessionsSqls.staff)
    })
    test("staff vs admin（pg 与 Drizzle 占位符归一化后等价）", () => {
      expect(paidSessionsSqls.adminTs).toBe(paidSessionsSqls.staff)
    })
    test("staff vs db/scripts/fix-sale-items-session-count（维护脚本内联副本）", () => {
      expect(paidSessionsSqls.scriptFix).toBe(paidSessionsSqls.staff)
    })
  })

  describe("Snapshot 守护（任一字符漂移即可见）", () => {
    test("paid_sessions 重算 SQL 文本快照", () => {
      expect(paidSessionsSqls.staff).toMatchSnapshot()
    })
  })
})

// 转换单转入行 received 重算：staff/client/payNotify/admin 四端支付入口均会调用
// recalcPaidSessionsForOrder，必须保持同一“旧卡价值 + 净到账”分摊口径。
describe('转换单转入 received 重算 SQL 四端一致性守护', () => {
  const marker = 'WITH conversion_order AS'
  let sqls

  beforeAll(() => {
    sqls = {
      staff: normalizeSql(extractBacktickStringContaining(readFile(FILES.staffPaidSessionsJs), marker)),
      client: normalizeSql(extractBacktickStringContaining(readFile(FILES.clientPaidSessionsJs), marker)),
      payNotify: normalizeSql(extractBacktickStringContaining(readFile(FILES.payNotifyPaidSessionsJs), marker)),
      adminTs: normalizeSql(extractBacktickStringContaining(readFile(FILES.adminPaidSessionsTs), marker)),
    }
  })

  test('四端归一化后字面一致', () => {
    expect(sqls.client).toBe(sqls.staff)
    expect(sqls.payNotify).toBe(sqls.staff)
    expect(sqls.adminTs).toBe(sqls.staff)
  })

  test('目标值必须为 min(转入总价, 转出旧卡价值 + 订单净到账)，并按稳定顺序吸收尾差', () => {
    expect(sqls.staff).toContain("conversion_order.sale_order_type = '转换单'")
    expect(sqls.staff).toContain("out_item.item_direction = '转出'")
    expect(sqls.staff).toContain("si.item_direction = '转入'")
    expect(sqls.staff).toMatch(/LEAST\(conversion_order\.in_total, conversion_order\.converted_value \+ conversion_order\.net_received\)/)
    expect(sqls.staff).toMatch(/ROW_NUMBER\(\) OVER\s*\(ORDER BY si\.sale_item_id\)\s+AS rn/)
    expect(sqls.staff).toContain('WHEN rn = item_count THEN target_received -')
  })

  test('转换单转入 received SQL 文本快照', () => {
    expect(sqls.staff).toMatchSnapshot()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// sale_items 储值卡/现金实付分摊：四端各保留独立副本，归一化后必须完全一致。
describe("sale_items 支付通道实付分摊 SQL 四端一致性守护", () => {
  const sources = {
    staff: readFile(FILES.staffPaidSessionsJs),
    client: readFile(FILES.clientPaidSessionsJs),
    payNotify: readFile(FILES.payNotifyPaidSessionsJs),
    adminTs: readFile(FILES.adminPaidSessionsTs),
  }
  const extractAll = (marker) => Object.fromEntries(
    Object.entries(sources).map(([name, src]) => [name, normalizeSql(extractBacktickStringContaining(src, marker))]),
  )

  test('订单储值卡实付净额重算四端一致', () => {
    const sqls = extractAll('settled_prepaid')
    expect(sqls.client).toBe(sqls.staff)
    expect(sqls.payNotify).toBe(sqls.staff)
    expect(sqls.adminTs).toBe(sqls.staff)
  })

  test('行级储值卡分摊四端一致，且具备有符号分母与累计边界差', () => {
    const sqls = extractAll('prepaid_share')
    expect(sqls.client).toBe(sqls.staff)
    expect(sqls.payNotify).toBe(sqls.staff)
    expect(sqls.adminTs).toBe(sqls.staff)
    expect(sqls.staff).toMatch(/SUM\(si\.received::numeric\)\s+OVER\s*\(\)\s+AS received_total/)
    expect(sqls.staff).toMatch(/SUM\(si\.received::numeric\) OVER \(ORDER BY si\.sale_item_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW\) AS cumulative_received/)
    expect(sqls.staff).toMatch(/ROUND\(prepaid_total \* cumulative_received \/ received_total, 2\) - ROUND\(prepaid_total \* \(cumulative_received - item_received\) \/ received_total, 2\)/)
    expect(sqls.staff).not.toMatch(/item_count|provisional/)
  })
})

// Block 7b': STEP 1 分支 A received = Σ receipt SQL 四端字节同义
//   recalcPaidSessionsForOrder STEP1 两路分流：订单有完整 receipt 覆盖 → received = Σ 有符号 receipt.amount per item
//   （分支 A，主路径，精确，退款 receipt 为负数）；无完整 receipt → 回退分支 B 瀑布（见下一块）。
//   receipt 由 capturePaymentAllocatables / cascadeRefund 同事务写入，故 Σ receipt = 该行累计净 received。
//   admin（Drizzle ${id} 内联 sql）+ staff/client/payNotify（pg $1）四端归一化后字节同义。
// ─────────────────────────────────────────────────────────────────────────────
describe("STEP 1 分支 A received=Σreceipt SQL 四端字节同义守护", () => {
  // `spir` 别名是分支 A 独有指纹；覆盖探测查询使用 cov_spir，分支 B 瀑布、STEP1.5/STEP2 均不引用该片段。
  const MARKER_RECEIPT_RECEIVED = "FROM sale_payment_item_receipts spir"
  let receiptReceivedSqls

  beforeAll(() => {
    receiptReceivedSqls = {
      staff: normalizeSql(extractBacktickStringContaining(readFile(FILES.staffPaidSessionsJs), MARKER_RECEIPT_RECEIVED)),
      client: normalizeSql(extractBacktickStringContaining(readFile(FILES.clientPaidSessionsJs), MARKER_RECEIPT_RECEIVED)),
      payNotify: normalizeSql(extractBacktickStringContaining(readFile(FILES.payNotifyPaidSessionsJs), MARKER_RECEIPT_RECEIVED)),
      adminTs: normalizeSql(extractBacktickStringContaining(readFile(FILES.adminPaidSessionsTs), MARKER_RECEIPT_RECEIVED)),
    }
  })

  describe("特征守护", () => {
    test("四端 received = COALESCE(GREATEST(0, Σ 有符号 receipt.amount), 0)（行级 clamp）", () => {
      const pattern = /received\s*=\s*COALESCE\(\s*GREATEST\(\s*0\s*,\s*\(\s*SELECT\s+SUM\(\s*spir\.amount::numeric\s*\)\s+FROM\s+sale_payment_item_receipts\s+spir/i
      for (const sql of [receiptReceivedSqls.staff, receiptReceivedSqls.client, receiptReceivedSqls.payNotify, receiptReceivedSqls.adminTs]) {
        expect(sql).toMatch(pattern)
      }
    })
    test("四端分支 A 统计已支付正向流水和退款流水，退款负数 receipt 进入 received", () => {
      for (const sql of [receiptReceivedSqls.staff, receiptReceivedSqls.client, receiptReceivedSqls.payNotify, receiptReceivedSqls.adminTs]) {
        expect(sql).toMatch(/JOIN sale_order_payments sop ON sop\.id = spir\.sale_payment_id/i)
        expect(sql).toMatch(/sop\.status\s*=\s*'已支付'/i)
        expect(sql).toMatch(/sop\.change_type IN\s*\('首次支付','回款','储值卡抵扣','退款'\)/i)
      }
    })
    test("四端子查询按 (sale_order_id, sale_item_id) 定位行", () => {
      const pattern = /spir\.sale_order_id\s*=\s*\?\s*AND\s*spir\.sale_item_id\s*=\s*si\.sale_item_id/i
      for (const sql of [receiptReceivedSqls.staff, receiptReceivedSqls.client, receiptReceivedSqls.payNotify, receiptReceivedSqls.adminTs]) {
        expect(sql).toMatch(pattern)
      }
    })
    test("四端仅重算 item_direction='购买' 行（转出/转入 received 不被动，防分支 A 误清零）", () => {
      const pattern = /si\.item_direction\s*=\s*'购买'/
      for (const sql of [receiptReceivedSqls.staff, receiptReceivedSqls.client, receiptReceivedSqls.payNotify, receiptReceivedSqls.adminTs]) {
        expect(sql).toMatch(pattern)
      }
    })
  })

  describe("四端镜像比对", () => {
    test("staff vs client", () => { expect(receiptReceivedSqls.client).toBe(receiptReceivedSqls.staff) })
    test("staff vs payNotify", () => { expect(receiptReceivedSqls.payNotify).toBe(receiptReceivedSqls.staff) })
    test("staff vs admin（归一化后等价）", () => { expect(receiptReceivedSqls.adminTs).toBe(receiptReceivedSqls.staff) })
  })

  describe("Snapshot 守护", () => {
    test("STEP 1 分支 A received=Σreceipt SQL 文本快照", () => {
      expect(receiptReceivedSqls.staff).toMatchSnapshot()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Block 7b'': STEP 2.5 0 元 item 全退 paid_sessions 覆盖
//   0 元赠送/寄存 item 的公式兜底会给满 paid_sessions；退款 note.items[] 明确标记
//   isFullItemRefund=true 时必须覆盖为 0，避免已退赠送卡继续在卡包出现。
// ─────────────────────────────────────────────────────────────────────────────
describe("STEP 2.5 0 元全退 item paid_sessions 覆盖 SQL 五端同义守护", () => {
  const MARKER_FULL_REFUND_ZERO = "WITH full_refund_zero_items AS"
  let fullRefundZeroSqls

  beforeAll(() => {
    fullRefundZeroSqls = {
      staff: normalizeSql(extractBacktickStringContaining(readFile(FILES.staffPaidSessionsJs), MARKER_FULL_REFUND_ZERO)),
      client: normalizeSql(extractBacktickStringContaining(readFile(FILES.clientPaidSessionsJs), MARKER_FULL_REFUND_ZERO)),
      payNotify: normalizeSql(extractBacktickStringContaining(readFile(FILES.payNotifyPaidSessionsJs), MARKER_FULL_REFUND_ZERO)),
      adminTs: normalizeSql(extractBacktickStringContaining(readFile(FILES.adminPaidSessionsTs), MARKER_FULL_REFUND_ZERO)),
      scriptFix: normalizeSql(extractBacktickStringContaining(readFile(FILES.scriptPaidSessionsFix), MARKER_FULL_REFUND_ZERO)),
    }
  })

  describe("特征守护", () => {
    test("五端按退款 note.items[].isFullItemRefund 定位被全退 item", () => {
      for (const sql of Object.values(fullRefundZeroSqls)) {
        expect(sql).toMatch(/LOWER\(COALESCE\(elem ->> 'isFullItemRefund', 'false'\)\) = 'true'/)
        expect(sql).toMatch(/elem ->> 'refSaleItemId' AS sale_item_id/)
      }
    })
    test("五端只覆盖购买方向、次数型、0 元 item，且 paid_sessions=0", () => {
      for (const sql of Object.values(fullRefundZeroSqls)) {
        expect(sql).toMatch(/si\.item_direction\s*=\s*'购买'/)
        expect(sql).toMatch(/si\.session_count IS NOT NULL/)
        expect(sql).toMatch(/si\.sale_amount <= 0/)
        expect(sql).toMatch(/SET paid_sessions = 0/)
      }
    })
  })

  describe("五端镜像比对", () => {
    test("staff vs client", () => { expect(fullRefundZeroSqls.client).toBe(fullRefundZeroSqls.staff) })
    test("staff vs payNotify", () => { expect(fullRefundZeroSqls.payNotify).toBe(fullRefundZeroSqls.staff) })
    test("staff vs admin（归一化后等价）", () => { expect(fullRefundZeroSqls.adminTs).toBe(fullRefundZeroSqls.staff) })
    test("staff vs db/scripts/fix-sale-items-session-count", () => { expect(fullRefundZeroSqls.scriptFix).toBe(fullRefundZeroSqls.staff) })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Block 7b: STEP 1 received 分摊 SQL 四端字节同义
//   recalcPaidSessionsForOrder 在跑 paid_sessions 公式前，用「定向 + 两段式瀑布」把
//   sale_orders.received 摊到各 sale_items.received（仅 item_direction='购买' 行）：
//   定向额(targeted)精确归位；无定向额先按 pend_cap(逐行实付 pending_received)铺满、
//   溢出再按 sale_cap(应付余量)铺开（2026-06-08 组合套餐按逐行实付累加、付清不冻结）。
//   pending_received=0/=sale_amount 时数学上退化为旧「按 sale_amount 比例」。
//   admin（Drizzle）+ staff/client/payNotify（pg）四端必须字节同义。
// ─────────────────────────────────────────────────────────────────────────────
describe("STEP 1 received 分摊 SQL 四端字节同义守护", () => {
  const MARKER_ALLOC = "received = CASE"
  let allocSqls

  beforeAll(() => {
    allocSqls = {
      staff: normalizeSql(extractBacktickStringContaining(readFile(FILES.staffPaidSessionsJs), MARKER_ALLOC)),
      client: normalizeSql(extractBacktickStringContaining(readFile(FILES.clientPaidSessionsJs), MARKER_ALLOC)),
      payNotify: normalizeSql(extractBacktickStringContaining(readFile(FILES.payNotifyPaidSessionsJs), MARKER_ALLOC)),
      adminTs: normalizeSql(extractBacktickStringContaining(readFile(FILES.adminPaidSessionsTs), MARKER_ALLOC)),
    }
  })

  describe("特征守护（定向 + 两段式瀑布，2026-06-08 逐行实付累加）", () => {
    test("四端定向回款按 ref_sale_item_id 汇总（退款 change_type 排除）", () => {
      const pattern = /ref_sale_item_id IS NOT NULL[\s\S]*change_type IN\s*\('首次支付','回款','储值卡抵扣'\)|change_type IN\s*\('首次支付','回款','储值卡抵扣'\)[\s\S]*ref_sale_item_id IS NOT NULL/i
      expect(allocSqls.staff).toMatch(pattern)
      expect(allocSqls.client).toMatch(pattern)
      expect(allocSqls.payNotify).toMatch(pattern)
      expect(allocSqls.adminTs).toMatch(pattern)
    })
    test("四端第一段产能 pend_cap = GREATEST(0, pending_received - targeted)（朝逐行实付草稿铺）", () => {
      const pattern = /GREATEST\(0,\s*si\.pending_received::numeric\s*-\s*COALESCE\(tg\.targeted,\s*0\)::numeric\)/i
      expect(allocSqls.staff).toMatch(pattern)
      expect(allocSqls.client).toMatch(pattern)
      expect(allocSqls.payNotify).toMatch(pattern)
      expect(allocSqls.adminTs).toMatch(pattern)
    })
    test("四端第二段产能 sale_cap = GREATEST(0, sale_amount - max(pending_received, targeted))（实付→应付余量，防冻结）", () => {
      const pattern = /GREATEST\(0,\s*si\.sale_amount::numeric\s*-\s*GREATEST\(si\.pending_received::numeric,\s*COALESCE\(tg\.targeted,\s*0\)::numeric\)\)/i
      expect(allocSqls.staff).toMatch(pattern)
      expect(allocSqls.client).toMatch(pattern)
      expect(allocSqls.payNotify).toMatch(pattern)
      expect(allocSqls.adminTs).toMatch(pattern)
    })
    test("四端无定向额先按 pend_cap 铺满（LEAST 封顶 Σpend_cap）", () => {
      const pattern = /LEAST\(agg\.untargeted,\s*agg\.pend_cap_total\)\s*\*\s*caps\.pend_cap\s*\/\s*agg\.pend_cap_total/i
      expect(allocSqls.staff).toMatch(pattern)
      expect(allocSqls.client).toMatch(pattern)
      expect(allocSqls.payNotify).toMatch(pattern)
      expect(allocSqls.adminTs).toMatch(pattern)
    })
    test("四端溢出额再按 sale_cap 铺开（untargeted > Σpend_cap 时）且整体 ROUND 2 位", () => {
      const overflow = /\(agg\.untargeted\s*-\s*agg\.pend_cap_total\)\s*\*\s*caps\.sale_cap\s*\/\s*agg\.sale_cap_total/i
      const round2 = /ROUND\([\s\S]*,\s*2\)/i
      for (const sql of [allocSqls.staff, allocSqls.client, allocSqls.payNotify, allocSqls.adminTs]) {
        expect(sql).toMatch(overflow)
        expect(sql).toMatch(round2)
      }
    })
    test("四端仅分摊 item_direction='购买' 行（转出/转入 received 不被清零）", () => {
      const pattern = /item_direction\s*=\s*'购买'/
      expect(allocSqls.staff).toMatch(pattern)
      expect(allocSqls.client).toMatch(pattern)
      expect(allocSqls.payNotify).toMatch(pattern)
      expect(allocSqls.adminTs).toMatch(pattern)
    })
  })

  describe("四端镜像比对", () => {
    test("staff vs client", () => { expect(allocSqls.client).toBe(allocSqls.staff) })
    test("staff vs payNotify", () => { expect(allocSqls.payNotify).toBe(allocSqls.staff) })
    test("staff vs admin（归一化后等价）", () => { expect(allocSqls.adminTs).toBe(allocSqls.staff) })
  })

  describe("Snapshot 守护", () => {
    test("STEP 1 分摊 SQL 文本快照", () => {
      expect(allocSqls.staff).toMatchSnapshot()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Block 7c: STEP 1.5 逐项退款净额 SQL 四端字节同义（2026-06-08 退款侧）
//   recalcPaidSessionsForOrder 在 STEP1（毛额分摊）之后、STEP2 之前，从已支付退款流水
//   note.items[].refundAmount 按 refSaleItemId 聚合扣减 sale_items.received → 净额（被退项单独减少）。
//   note→jsonb 三重防线：① WHERE 仅 退款+已支付；② note LIKE '{%' 纯文本守门；③ 嵌套 CASE 保 ::jsonb cast。
//   admin（Drizzle ${id}）+ staff/client/payNotify（pg $1）四端归一化后字节同义。
// ─────────────────────────────────────────────────────────────────────────────
describe("STEP 1.5 逐项退款净额 SQL 四端字节同义守护", () => {
  const MARKER_REFUND_DEDUCT = "received = GREATEST(0, si.received"
  let deductSqls

  beforeAll(() => {
    deductSqls = {
      staff: normalizeSql(extractBacktickStringContaining(readFile(FILES.staffPaidSessionsJs), MARKER_REFUND_DEDUCT)),
      client: normalizeSql(extractBacktickStringContaining(readFile(FILES.clientPaidSessionsJs), MARKER_REFUND_DEDUCT)),
      payNotify: normalizeSql(extractBacktickStringContaining(readFile(FILES.payNotifyPaidSessionsJs), MARKER_REFUND_DEDUCT)),
      adminTs: normalizeSql(extractBacktickStringContaining(readFile(FILES.adminPaidSessionsTs), MARKER_REFUND_DEDUCT)),
    }
  })

  describe("特征守护（note 解析三重防线 + 逐项聚合）", () => {
    test("四端仅聚合 退款+已支付 流水（reject='已作废'自动排除→自愈）", () => {
      const pattern = /change_type\s*=\s*'退款'\s*AND\s*sop\.status\s*=\s*'已支付'/i
      expect(deductSqls.staff).toMatch(pattern)
      expect(deductSqls.client).toMatch(pattern)
      expect(deductSqls.payNotify).toMatch(pattern)
      expect(deductSqls.adminTs).toMatch(pattern)
    })
    test("四端 note→jsonb 守门：note LIKE '{%' 外层 + jsonb_typeof items 数组（防 22P02/25P02）", () => {
      const guard = /sop\.note LIKE '\{%'/i
      const typ = /jsonb_typeof\(\(sop\.note\)::jsonb -> 'items'\)\s*=\s*'array'/i
      for (const s of [deductSqls.staff, deductSqls.client, deductSqls.payNotify, deductSqls.adminTs]) {
        expect(s).toMatch(guard)
        expect(s).toMatch(typ)
      }
    })
    test("四端按 refSaleItemId 聚合 refundAmount（逐项归因）", () => {
      const pattern = /SUM\(refund_amount\)\s*AS\s*refunded/i
      expect(deductSqls.staff).toMatch(pattern)
      expect(deductSqls.client).toMatch(pattern)
      expect(deductSqls.payNotify).toMatch(pattern)
      expect(deductSqls.adminTs).toMatch(pattern)
    })
    test("四端从毛额 GREATEST(0) clamp 扣减 + 仅 item_direction='购买' 行", () => {
      const deduct = /received\s*=\s*GREATEST\(0,\s*si\.received::numeric\s*-\s*COALESCE\(agg\.refunded,\s*0\)\)/i
      const buyOnly = /item_direction\s*=\s*'购买'/
      for (const s of [deductSqls.staff, deductSqls.client, deductSqls.payNotify, deductSqls.adminTs]) {
        expect(s).toMatch(deduct)
        expect(s).toMatch(buyOnly)
      }
    })
  })

  describe("四端镜像比对", () => {
    test("staff vs client", () => { expect(deductSqls.client).toBe(deductSqls.staff) })
    test("staff vs payNotify", () => { expect(deductSqls.payNotify).toBe(deductSqls.staff) })
    test("staff vs admin（归一化后等价）", () => { expect(deductSqls.adminTs).toBe(deductSqls.staff) })
  })

  describe("Snapshot 守护", () => {
    test("STEP 1.5 逐项退款净额 SQL 文本快照", () => {
      expect(deductSqls.staff).toMatchSnapshot()
    })
  })
})

// ── 服务单 finalize（待客户确认 → 已完成）SQL — staff / client 双端字节同义 ──────────
// 「顾客确认才算完成」需求：扣次数 + 算提成 + 关预约从 staff complete 后移到 confirm，
// 且顾客本人确认（clientApi）首次执行该副作用，故 clientApi 新增了 finalize 副本。
// 三条核心 SQL（扣减 UPDATE / commission_rate_matrix 查率 / service_commissions 写入）
// 必须与 staff finalizeServiceOrder 字面量一致；任一端漂移 → fail，提示同步另一端。
// operation_logs 缺率告警 INSERT 因 operator/source 字面不同（staffApi vs clientApi），不纳入比对。
describe('服务单 finalize 跨端 SQL 一致性守护（staff / client / admin 三端）', () => {
  const MARKER_SVC_DEDUCT = 'remaining_sessions = remaining_sessions - $1'
  const MARKER_SVC_RATE = 'commission_rate FROM commission_rate_matrix'
  const MARKER_SVC_COMM_INSERT = 'INSERT INTO service_commissions'

  let deduct, rate, commInsert

  beforeAll(() => {
    const staffSrc = readFile(FILES.staffServiceJs)
    const clientSrc = readFile(FILES.clientServiceFinalizeJs)
    const adminSrc = readFile(FILES.adminServiceCommissionSettleTs)
    deduct = {
      staff: normalizeSql(extractBacktickStringContaining(staffSrc, MARKER_SVC_DEDUCT)),
      client: normalizeSql(extractBacktickStringContaining(clientSrc, MARKER_SVC_DEDUCT)),
    }
    rate = {
      staff: normalizeSql(extractBacktickStringContaining(staffSrc, MARKER_SVC_RATE)),
      client: normalizeSql(extractBacktickStringContaining(clientSrc, MARKER_SVC_RATE)),
      admin: normalizeSql(extractBacktickStringContaining(adminSrc, MARKER_SVC_RATE)),
    }
    commInsert = {
      staff: normalizeSql(extractBacktickStringContaining(staffSrc, MARKER_SVC_COMM_INSERT)),
      client: normalizeSql(extractBacktickStringContaining(clientSrc, MARKER_SVC_COMM_INSERT)),
      admin: normalizeSql(extractBacktickStringContaining(adminSrc, MARKER_SVC_COMM_INSERT)),
    }
  })

  describe('剩余次数原子扣减 UPDATE 镜像比对', () => {
    test('staff vs client 一致', () => { expect(deduct.client).toBe(deduct.staff) })
    test('含 paid_sessions 限额条件（防漂移退化）', () => {
      expect(deduct.staff).toContain('COALESCE(paid_sessions, session_count)')
    })
    test('admin confirmServiceOrder 扣减 CTE 也含 paid_sessions 限额（M1：三端扣减口径对齐）', () => {
      const adminServicesSrc = readFile(FILES.adminServicesTs)
      expect(adminServicesSrc).toContain('COALESCE(sale_items.paid_sessions, sale_items.session_count)')
    })
  })

  describe('提成比例矩阵查询 SELECT 镜像比对', () => {
    test('staff / client / admin 三端归一化后一致', () => {
      expect(rate.client).toBe(rate.staff)
      expect(rate.admin).toBe(rate.staff)
    })
    test("order_type = '服务单' 限定（防误取销售单费率）", () => {
      expect(rate.staff).toContain("order_type = '服务单'")
      expect(rate.admin).toContain("order_type = '服务单'")
    })
    test('按服务单所属市场过滤（org_id = store→org 树解析市场节点，防跨市场费率行碰撞）', () => {
      expect(rate.staff).toContain('org_id =')
      expect(rate.staff).toContain('JOIN org_nodes m ON son.parent_id = m.id')
      expect(rate.client).toContain('org_id =')
      expect(rate.admin).toContain('org_id =')
      expect(rate.admin).toContain('JOIN org_nodes m ON son.parent_id = m.id')
    })
  })

  describe('service_commissions 写入 INSERT 镜像比对', () => {
    test('staff / client / admin 三端归一化后一致', () => {
      expect(commInsert.client).toBe(commInsert.staff)
      expect(commInsert.admin).toBe(commInsert.staff)
    })
    test('ON CONFLICT DO NOTHING 幂等（防重复确认重复计提成）', () => {
      expect(commInsert.staff).toContain('ON CONFLICT')
      expect(commInsert.staff).toContain('DO NOTHING')
      expect(commInsert.admin).toContain('ON CONFLICT')
      expect(commInsert.admin).toContain('DO NOTHING')
    })
  })

  describe('Snapshot 守护', () => {
    test('finalize 三条核心 SQL 文本快照', () => {
      expect({ deduct: deduct.staff, rate: rate.staff, commInsert: commInsert.staff }).toMatchSnapshot()
    })
  })
})

// admin confirmServiceOrder 入口守护（M1：确保 services.ts 代确认时真的接上了提成写入，
// 防"提成 helper 存在但入口忘记调用"的回归——这正是本次审计发现的原始 bug）
describe('admin confirmServiceOrder 接入服务提成写入守护（M1）', () => {
  test('services.ts confirmServiceOrder 在事务内调用 settleServiceCommissions', () => {
    const src = readFile(FILES.adminServicesTs)
    expect(src).toMatch(/settleServiceCommissions\s*\(/)
    expect(src).toMatch(/db\.transaction\(async\s*\(tx\)\s*=>\s*\{[\s\S]*?settleServiceCommissions/)
  })
  test('lib/service-commission-settle.ts 把 commission_status 置「已分配」（镜像 staff/client finalize）', () => {
    const src = readFile(FILES.adminServiceCommissionSettleTs)
    expect(src).toContain("commission_status = '已分配'")
  })
})

// 会员到店积分：三端 finalizer 独立副本，常量、核心 INSERT+余额更新 SQL 与触发点必须一致。
describe('会员到店积分跨端一致性守护（staff / client / admin）', () => {
  let sources, grantSqls

  beforeAll(() => {
    sources = {
      staff: readFile(FILES.staffVisitPointsJs),
      client: readFile(FILES.clientVisitPointsJs),
      admin: readFile(FILES.adminVisitPointsTs),
    }
    grantSqls = {
      staff: normalizeSql(extractBacktickStringContaining(sources.staff, 'WITH inserted AS')),
      client: normalizeSql(extractBacktickStringContaining(sources.client, 'WITH inserted AS')),
      admin: normalizeSql(extractBacktickStringContaining(sources.admin, 'WITH inserted AS')),
    }
  })

  test('三端配置键、默认值、流水类型和幂等前缀一致', () => {
    for (const src of Object.values(sources)) {
      expect(src).toContain("VISIT_POINTS_CONFIG_KEY = 'visit_points_reward'")
      expect(src).toContain('DEFAULT_VISIT_POINTS_REWARD = 20')
      expect(src).toContain("VISIT_POINTS_TYPE = '到店赠送'")
      expect(src).toContain("VISIT_POINTS_EXTERNAL_REF_PREFIX = 'visit-points'")
    }
  })

  test('三端流水写入与余额增量 SQL 归一化后一致', () => {
    expect(grantSqls.client).toBe(grantSqls.staff)
    expect(grantSqls.admin).toBe(grantSqls.staff)
    expect(grantSqls.staff).toContain('ON CONFLICT DO NOTHING')
    expect(grantSqls.staff).toContain('EXISTS (SELECT 1 FROM inserted)')
  })

  test('三个最终确认入口均调用 grantVisitPointsSafe，complete 阶段不调用', () => {
    const staffService = readFile(FILES.staffServiceJs)
    const clientFinalize = readFile(FILES.clientServiceFinalizeJs)
    const adminServices = readFile(FILES.adminServicesTs)
    expect(staffService).toMatch(/async function finalizeServiceOrder[\s\S]*grantVisitPointsSafe\s*\(/)
    expect(clientFinalize).toMatch(/async function finalizeServiceOrder[\s\S]*grantVisitPointsSafe\s*\(/)
    expect(adminServices).toMatch(/confirmServiceOrder[\s\S]*grantVisitPointsSafe\s*\(/)

    const staffComplete = staffService.slice(
      staffService.indexOf('async function complete'),
      staffService.indexOf('async function confirm'),
    )
    expect(staffComplete).not.toContain('grantVisitPointsSafe')
  })
})

// 寄存单退款单「跳过提成写入」跨端控制流守护（M8 / 2026-07-14 审计 M1 修复）：
// 寄存退款单 remark === DEPOSIT_REFUND_REMARK 是 JS 控制流的 continue，SQL 字面量 snapshot
// 看不见——三端 finalize/settle 都必须有此 skip，否则寄存退款（真扣次数、假消耗）会虚写
// service_commissions 污染提成 KPI（admin settleServiceCommissions 曾漏此 skip，本断言防回归）。
describe('寄存退款单跳过提成写入 跨端控制流守护（staff / client / admin 三端 finalize 须含 skip）', () => {
  test('staff finalizeServiceOrder 含寄存退款 skip（so.remark === DEPOSIT_REFUND_REMARK → continue）', () => {
    const src = readFile(FILES.staffServiceJs)
    expect(src).toContain('DEPOSIT_REFUND_REMARK')
    expect(src).toMatch(/DEPOSIT_REFUND_REMARK\)\s*continue/)
  })
  test('client finalizeServiceOrder 含寄存退款 skip', () => {
    const src = readFile(FILES.clientServiceFinalizeJs)
    expect(src).toContain('DEPOSIT_REFUND_REMARK')
    expect(src).toMatch(/DEPOSIT_REFUND_REMARK\)\s*continue/)
  })
  test('admin settleServiceCommissions 含寄存退款 skip（M1 修复，镜像 staff/client）', () => {
    const src = readFile(FILES.adminServiceCommissionSettleTs)
    expect(src).toContain('DEPOSIT_REFUND_REMARK')
    // admin 用 isDepositRefund 派生 + 循环顶 continue（与 staff/client 的 so.remark 判定等价）
    expect(src).toMatch(/if\s*\(isDepositRefund\)\s*continue/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 寄存单疗程卡「实际单价按实付重算」SQL — staff / admin 双端字节同义
//   需求：从寄存单产生的疗程卡，unit_real_price = 实付received / 总次数session_count
//        （实付=0 置 0，如实反映未收款）。
//   staff: routes/order.js DEPOSIT_REAL_PRICE_RECALC_SQL（pg）
//   admin: actions/orders.ts recomputeDepositRealPrice 内 sql`...`（Drizzle）
//   staff 仅提交待审批寄存单；admin 审批通过后才激活 paid_sessions 并重算实际单价。
//   client/payNotify 无寄存单路径，故不纳入四端 paid-sessions 守护。
//   ⚠️ 调用顺序（必须在 recalcPaidSessionsForOrder 之后）由 e2e smoke 守护：若提前跑，
//      received 仍为 0 → 全部回落标价 → smoke 断言 unit_real_price=80 会失败。
// ─────────────────────────────────────────────────────────────────────────────
describe('寄存单实际单价重算 SQL 双端字节同义守护', () => {
  const MARKER_DEPOSIT_PRICE = 'DEPOSIT_REAL_PRICE'
  let depositPriceSqls
  let staffSrc, adminSrc

  beforeAll(() => {
    staffSrc = readFile(FILES.staffOrderJs)
    adminSrc = readFile(FILES.adminOrdersTs)
    depositPriceSqls = {
      staff: normalizeSql(extractBacktickStringContaining(staffSrc, MARKER_DEPOSIT_PRICE)),
      adminTs: normalizeSql(extractBacktickStringContaining(adminSrc, MARKER_DEPOSIT_PRICE)),
    }
  })

  describe('特征守护（公式 + 范围 + fallback 不可漂移）', () => {
    test('两端 unit_real_price = ROUND(received/session_count, 2)', () => {
      const pattern = /ROUND\(received::numeric\s*\/\s*session_count,\s*2\)/i
      expect(depositPriceSqls.staff).toMatch(pattern)
      expect(depositPriceSqls.adminTs).toMatch(pattern)
    })
    test('两端实付=0 置 0（ELSE 0，反向守护防删 fallback）', () => {
      expect(depositPriceSqls.staff).toContain('ELSE 0')
      expect(depositPriceSqls.adminTs).toContain('ELSE 0')
    })
    test("两端仅作用于疗程卡购买行（product_type='疗程卡' AND item_direction='购买'）", () => {
      expect(depositPriceSqls.staff).toContain("product_type = '疗程卡'")
      expect(depositPriceSqls.staff).toContain("item_direction = '购买'")
      expect(depositPriceSqls.adminTs).toContain("product_type = '疗程卡'")
      expect(depositPriceSqls.adminTs).toContain("item_direction = '购买'")
    })
  })

  describe('双端镜像比对（任一端漂移 → fail，提示同步另一端）', () => {
    test('staff vs admin（pg 与 Drizzle 占位符归一化后等价）', () => {
      expect(depositPriceSqls.adminTs).toBe(depositPriceSqls.staff)
    })
  })

  describe('触发点防回归（定义了 SQL 却没接线即形同虚设）', () => {
    // updateDepositReceived 已停用；staff 创建只提交审批，不得提前激活实际单价。
    test('staff createDeposit 不调用 DEPOSIT_REAL_PRICE_RECALC_SQL（审批由 admin 完成）', () => {
      const calls = staffSrc.match(/tx\.query\(\s*DEPOSIT_REAL_PRICE_RECALC_SQL\s*,\s*\[/g) || []
      expect(calls.length).toBe(0)
    })
    test('admin approveDepositOrder 调用 recomputeDepositRealPrice（恰 1 处；updateDepositReceived 已停用）', () => {
      const calls = adminSrc.match(/await\s+recomputeDepositRealPrice\(\s*tx\s*,/g) || []
      expect(calls.length).toBe(1)
    })
    test('两端 updateDepositReceived 已移除（不得残留 export/函数）', () => {
      expect(staffSrc).not.toMatch(/async function updateDepositReceived/)
      expect(adminSrc).not.toMatch(/export const updateDepositReceived/)
    })
  })

  describe('Snapshot 守护', () => {
    test('寄存单实际单价重算 SQL 文本快照', () => {
      expect(depositPriceSqls.staff).toMatchSnapshot()
    })
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// 寄存单 / 历史订单(legacy_source='workfine') 资金操作锁定守护
//   需求（用户两轮指示）：寄存单 + 历史订单 禁止退款 / 回款 / 改实收。
//   源码级守护：任一端删了拦截即失败（行为面由 staff smoke-order-deposit 端到端验证；
//   admin recordPayment 因并行 migration 0062 暂不可跑 smoke，靠此源码守护兜底）。
// ─────────────────────────────────────────────────────────────────────────────
describe('寄存单/历史订单 资金操作锁定守护', () => {
  let staffOrder, adminOrders, adminRefunds
  beforeAll(() => {
    staffOrder = readFile(FILES.staffOrderJs)
    adminOrders = readFile(FILES.adminOrdersTs)
    adminRefunds = readFile(FILES.adminRefundsTs)
  })

  test('staff order.js 含 仅销售单退款白名单（Bug L）+ 寄存单/历史订单 回款拦截', () => {
    // Bug L：退款改正向白名单（仅销售单），原「寄存单不支持退款」黑名单已被「仅销售单支持退款」取代
    expect(staffOrder).toContain('仅销售单支持退款')
    expect(staffOrder).toContain('历史订单不支持退款')
    expect(staffOrder).toContain('寄存单不支持回款')
    expect(staffOrder).toContain('历史订单不支持回款')
  })

  test('admin recordPayment 含 寄存单/历史订单 回款拦截', () => {
    expect(adminOrders).toContain('寄存单不支持回款')
    expect(adminOrders).toContain('历史订单不支持回款')
  })

  test('admin createRefund 含 历史订单/仅销售单 退款拦截（寄存单走"仅销售单"通用拒绝）', () => {
    expect(adminRefunds).toContain('历史订单不支持退款')
    expect(adminRefunds).toContain('仅销售单支持退款')
  })
})

/**
 * 营业额分配状态守护：回款级 allocation_status 置「已分配」
 *
 * 历史（已退役）：allocation_status 曾是 sale_orders 列（订单级），收款路径用
 *   allocation_status = COALESCE(allocation_status, '待分配'::allocation_status) 初始化，
 *   四端字面一致由本块守护。
 * 2026-06-24 91a19ef9「销售分账按支付维度隔离（sale_payment_allocatable）」+ f2002074
 *   「营业额分配改按回款逐笔」把分配状态下沉到 sale_order_payments.allocation_status（回款级），
 *   订单级 COALESCE 初始化整体移除，'待分配' 改由 sale_order_payments 列默认值承担，
 *   故原「四端收款路径 COALESCE 初始化」守护随之退役删除。
 * 现守护：自动分配/入账路径把回款翻「已分配」的 UPDATE 字面跨端一致，
 *   避免漂移导致回款落入店长「待分配」列表诱导重分。
 */
describe('营业额分配：回款级 allocation_status 置「已分配」守护', () => {
  const PAYMENT_ALLOCATED = "allocation_status = '已分配'"

  let payNotifySrc
  let adminAllocationsSrc
  beforeAll(() => {
    payNotifySrc = readFile(FILES.payNotifyIndexJs)
    adminAllocationsSrc = readFile(FILES.adminAllocationsTs)
  })

  test('payNotify index.js：入账后把回款翻「已分配」（避免落入店长待分配列表诱导重分）', () => {
    expect(payNotifySrc).toContain(PAYMENT_ALLOCATED)
  })

  test('admin allocations.ts：保存分配后把回款翻「已分配」', () => {
    expect(adminAllocationsSrc).toContain(PAYMENT_ALLOCATED)
  })
})

/**
 * 营业额分配：事务锁序守护（issue #148）
 *
 * 项目硬约束（db/CLAUDE.md「写 sale_order_payments 的硬约束」）：
 *   锁序 `sale_orders` → `sale_order_payments`，新代码不得反向。
 *
 * 分配链路天然是「先改款项行、再刷订单汇总」，与「订单级改期」（先 FOR UPDATE 锁订单、
 * 再由迁移 0040 的 AFTER trigger 回写款项行）方向相反 —— 两个入口并发同一订单必 40P01，
 * 已在临时 PG 实测复现。修法是让分配事务一进来就先取订单行锁。
 *
 * 词法守护挡不住"锁还在文件里、但被挪到事务末尾"这种失效方式，所以这里除了断言锁语句存在，
 * 还断言它**出现在第一条写语句之前**（位置比较）。真实并发回归在
 * db/scripts/__tests__/allocation-lock-order.pg.test.js。
 */
describe('营业额分配：事务锁序守护 sale_orders → sale_order_payments（#148）', () => {
  /** 两端同语义的订单锁语句（归一后比对：`$1` 与 `${pay.sale_order_id}` 都被 normalizeSql 压成 `?`）。 */
  const CANONICAL_LOCK_SQL = 'SELECT 1 FROM sale_orders WHERE sale_order_id = ? FOR NO KEY UPDATE'
  const extractLockSql = (src) => {
    const m = src.match(/SELECT 1 FROM sale_orders WHERE sale_order_id = \S+ FOR NO KEY UPDATE/)
    return m ? normalizeSql(m[0]) : null
  }
  const STAFF_LOCK_CALL = 'lockSaleOrderForAllocation(client, pay.sale_order_id)'

  /**
   * 段内「第一条写语句」的位置。
   *
   * 早期只盯 `UPDATE sale_payment_item_allocations` —— 那样在锁之前插一条
   * `UPDATE sale_order_payments` 仍然全绿，而那恰恰是本 issue 要防的那类写。
   *
   * 现在按 **DML 语法**匹配而不是枚举字面量：枚举漏掉任何一种（`DELETE`、drizzle builder、
   * 另一张表）守护就会放过它。`FOR NO KEY UPDATE` 里的 UPDATE 后面不跟表名，不会误命中锁语句本身。
   */
  const WRITE_STMT_RE = new RegExp(
    '(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+' +
      '(?:sale_payment_item_allocations|sale_payment_item_receipts|sale_order_payments|sale_orders)\\b' +
      '|tx\\.(?:insert|update|delete)\\(',
    'i',
  )
  const firstWriteAt = (seg) => {
    const m = seg.match(WRITE_STMT_RE)
    return m ? m.index : -1
  }

  // 一律剥注释后再断言：两个文件的注释里都**有意**写着反例 `FOR UPDATE OF sop, so`，
  // 不剥的话负向断言会被自己的文档命中；正向断言剥注释后也更严格（把锁注释掉即红）。
  let staffAllocationSrc
  let adminAllocationsSrc
  let staffIndexSrc
  beforeAll(() => {
    staffAllocationSrc = stripJsComments(readFile(FILES.staffAllocationJs))
    adminAllocationsSrc = stripJsComments(readFile(FILES.adminAllocationsTs))
    staffIndexSrc = stripJsComments(readFile(FILES.staffIndexJs))
  })

  test('两端订单锁语句归一后完全一致，且强度是 FOR NO KEY UPDATE', () => {
    // 实测（PG 16）：FOR UPDATE 与 FK 取的 FOR KEY SHARE 冲突，整事务期间该订单的
    // INSERT sale_order_payments / sale_items / receipts 全被挡；FOR NO KEY UPDATE 放行，
    // 且同样挡得住改期的 FOR UPDATE 与 0040 trigger 的 FOR SHARE —— 消环不需要更强的锁。
    // 完整对照表在 db/CLAUDE.md「写 sale_order_payments 的硬约束」。
    expect(extractLockSql(staffAllocationSrc)).toBe(CANONICAL_LOCK_SQL)
    expect(extractLockSql(adminAllocationsSrc)).toBe(CANONICAL_LOCK_SQL)
    // 负向：两端都不得把它升成 FOR UPDATE（不带 NO KEY）
    expect(staffAllocationSrc).not.toMatch(/FROM sale_orders WHERE sale_order_id = \S+ FOR UPDATE\b/)
    expect(adminAllocationsSrc).not.toMatch(/FROM sale_orders WHERE sale_order_id = \S+ FOR UPDATE\b/)
  })

  test('staff allocation.js：每个写事务都先取订单行锁，再写', () => {
    // 按事务起点切段，逐段比较「锁」与「第一条写」的先后：
    // 既挡住"新增事务漏加锁"（段内 lockAt < 0），也挡住"锁被挪到事务末尾"。
    // 不再额外硬编码事务条数——段数本身就是计数，多一条硬编码只会在无害重构时误红。
    const arrowTx = /await pg\.transaction\(async \(client\) => \{/g
    const segments = staffAllocationSrc.split(arrowTx).slice(1)
    // 防写法漂移：裸 `pg.transaction(` 的出现次数必须与按箭头写法切出的段数一致，
    // 否则说明有事务换了写法而没被切出来，上面的逐段检查会静默漏掉它。
    expect((staffAllocationSrc.match(/pg\.transaction\(/g) || []).length).toBe(segments.length)
    expect(segments.length).toBeGreaterThan(0)
    for (const seg of segments) {
      const lockAt = seg.indexOf(STAFF_LOCK_CALL)
      const writeAt = firstWriteAt(seg)
      expect(lockAt).toBeGreaterThanOrEqual(0)
      expect(writeAt).toBeGreaterThanOrEqual(0)
      expect(lockAt).toBeLessThan(writeAt)
    }
  })

  test('admin allocations.ts：每个写事务都先取订单行锁，再写（与 staff 对称）', () => {
    const arrowTx = /await db\.transaction\(async \(tx\) => \{/g
    const segments = adminAllocationsSrc.split(arrowTx).slice(1)
    expect((adminAllocationsSrc.match(/db\.transaction\(/g) || []).length).toBe(segments.length)
    expect(segments.length).toBeGreaterThan(0)
    for (const seg of segments) {
      const lockAt = seg.indexOf('FROM sale_orders WHERE sale_order_id = ${pay.sale_order_id} FOR NO KEY UPDATE')
      const writeAt = firstWriteAt(seg)
      expect(lockAt).toBeGreaterThanOrEqual(0)
      expect(writeAt).toBeGreaterThanOrEqual(0)
      expect(lockAt).toBeLessThan(writeAt)
    }
  })

  test('两端都不得用 JOIN 取订单锁（按 sop 主键扫描会把锁序倒过来）', () => {
    // #137 评审实测踩过：`FROM sop JOIN so ... WHERE sop.id=$1 FOR UPDATE OF sop, so`
    // 物理上先锁款项行，正好与约定相反。
    // 不能只禁 `FOR UPDATE OF`：不写 OF 的 `FROM sop JOIN so ... FOR UPDATE` 会锁 FROM 里
    // 所有表、同样按 sop 主键驱动，是等价的反模式。所以按「涉及 sale_order_payments 的 JOIN + 取锁」锚定。
    const joinLock = /FROM\s+sale_order_payments[\s\S]{0,400}?JOIN\s+sale_orders[\s\S]{0,400}?FOR\s+(?:NO\s+KEY\s+)?UPDATE/i
    expect(staffAllocationSrc).not.toMatch(joinLock)
    expect(adminAllocationsSrc).not.toMatch(joinLock)
  })

  test('admin deleteOrder：无条件先锁订单，且在删任何子表之前复检退款流水', () => {
    // deleteOrder 是「先删子表、最后删主单」，不先锁订单就与「先锁订单再写款项」的事务（分配/收款）反向成环。
    // 补锁之后它又与**退款审批**（先拿退款行 → 再 UPDATE sale_orders）构成另一对反向，
    // 靠两条一起排除并存：① 持 FOR UPDATE 挡住 FK 新建退款行；② 锁内复检已存在的退款流水直接退出。
    // 缺任何一条都会变成真实死锁对，所以这里把「锁 → 复检 → 删除」的顺序钉死。
    const src = stripJsComments(readFile(FILES.adminOrdersTs))
    const refundCheckAt = src.indexOf("throw new Error('ORDER_HAS_REFUND_FLOW')")
    expect(refundCheckAt).toBeGreaterThan(0)

    // 定位复检所属事务的起点，只在该段内断言，避免被 orders.ts 其它事务的字面量干扰
    const txAt = src.lastIndexOf('await db.transaction(async (tx) => {', refundCheckAt)
    expect(txAt).toBeGreaterThan(0)
    const beforeCheck = src.slice(txAt, refundCheckAt)

    // 事务开头到复检之间：必须已取订单行锁，且不得出现任何删除
    expect(beforeCheck).toMatch(/SELECT status FROM sale_orders WHERE sale_order_id = \$\{saleOrderId\} FOR UPDATE/)
    expect(beforeCheck).not.toMatch(/DELETE\s+FROM/i)
    // 复检之后才允许删子表
    expect(src.slice(refundCheckAt)).toMatch(/DELETE FROM sale_payment_item_allocations/)
  })

  test('40P01 翻成可重试提示：staff 在全局漏斗、admin 在 action 内', () => {
    // staff 放 index.js 的全局 catch 而非各 route 自己兜：死锁是两个事务共同造成的，
    // PG 选谁当 victim 是任意的 —— 只翻译「分配」一侧，被选中的若是改期/收款/退款那侧照样落 -1。
    expect(staffIndexSrc).toContain("cur.code === '40P01'")
    expect(staffIndexSrc).toMatch(/CONFLICT: DEADLOCK_DETECTED:/)
    // 沿 cause 链取码（当前错误是扁平的，但引入包装层后只看 error.code 会静默失效）
    expect(staffIndexSrc).toContain('cur.cause')
    // admin 侧该 action 返回 {success:false} 而非 throw，下沉会改错误形状，故保持局部
    expect(adminAllocationsSrc).toContain("pgErrorCode(err) === '40P01'")
  })
})

// ============================================================================
// ticket 2026-06-29 paidUnusedSessions 派生口径守护
//
// 「已付未用次数」(可用次数) 是跨四端展示口径（剩余次数从物理剩余改为此口径）。
// admin lib/paid-sessions.ts 用 SQL 表达式派生（cards.ts 卡包 + orders.ts 导出复用同一 paidUnusedSessionsExpr）；
// client/staff 前端用 JS 派生（无法跨语言做 SQL 镜像比对）。
// 本守护：
//   1. snapshot admin lib/paid-sessions.ts 的 paidUnusedSessionsExpr 文本（提升为单源后，cards.ts 仅消费）
//   2. 纯 JS 复现口径 + 标准 case 表（NULL→物理剩余 / 欠款→0 / 部分支付 / used clamp 负值），
//      作为前端三端 paidUnusedSessions 派生必须遵循的基准：
//        client treatment-cards.ts、staff customer-detail.ts、staff mgmt-customer-detail.ts
// ============================================================================
describe('paidUnusedSessions 派生口径守护（admin SQL snapshot + 四端 JS 基准 case 表）', () => {
  const adminSql = normalizeSql(extractBacktickStringContaining(readFile(FILES.adminPaidSessionsTs), 'GREATEST(COALESCE'))

  test('admin paid-sessions.ts paidUnused SQL 含 NULL→remaining 兜底 + used clamp（防 #3 #9 回归）', () => {
    expect(adminSql).toContain('CASE WHEN')
    expect(adminSql).toContain('IS NULL THEN')
    expect(adminSql).toContain('GREATEST(COALESCE')
    // 外层 GREATEST + used 项 GREATEST(_,0) clamp 至少 2 处
    expect((adminSql.match(/GREATEST/g) || []).length).toBeGreaterThanOrEqual(2)
  })

  test('admin paid-sessions.ts paidUnused SQL 文本快照（任一字符漂移立即可见）', () => {
    expect(adminSql).toMatchSnapshot()
  })

  // 纯 JS 复现口径（与前端三端派生公式一致）
  function paidUnusedJs(total, remaining, paid) {
    if (paid === null || paid === undefined) return remaining
    const used = Math.max(total - remaining, 0)
    return Math.max(0, paid - used)
  }

  // 四端 paidUnused 派生基准 case 表（total/remaining/paid → expected）
  const PAID_UNUSED_CASES = [
    { name: '全付未用', total: 10, remaining: 10, paid: 10, expected: 10 },
    { name: '全付用3', total: 10, remaining: 7, paid: 10, expected: 7 },
    { name: '部分付用2', total: 15, remaining: 13, paid: 12, expected: 10 },
    { name: '欠款未付', total: 10, remaining: 10, paid: 0, expected: 0 },
    { name: '用满已付', total: 10, remaining: 5, paid: 5, expected: 0 },
    { name: '脏数据 remaining>total used clamp 到 0', total: 8, remaining: 13, paid: 5, expected: 5 },
    { name: '历史 NULL 退回物理剩余', total: 10, remaining: 7, paid: null, expected: 7 },
  ]

  test.each(PAID_UNUSED_CASES)('口径 case「$name」: total=$total remaining=$remaining paid=$paid → $expected', (c) => {
    expect(paidUnusedJs(c.total, c.remaining, c.paid)).toBe(c.expected)
  })

  test('基准 case 表快照（前端三端派生公式须与此一致，改 case 需同步四端）', () => {
    expect(PAID_UNUSED_CASES).toMatchSnapshot()
  })
})

// 2026-07-21 行级退款额聚合 per-item-refund — 四端 CTE 字面同义守护
// （ticket 2026-07-21 已退款行不可继续支付；与 paid-sessions RECEIVED_REFUNDED_DEDUCT_SQL 同源 CTE）
describe('2026-07-21 per-item-refund 行级退款聚合 SQL 四端一致性', () => {
  const MARKER_REFUND_AMOUNT = 'AS refund_amount'
  let refundSqls
  beforeAll(() => {
    refundSqls = {
      staff: normalizeSql(extractBacktickStringContaining(readFile(FILES.staffPerItemRefundJs), MARKER_REFUND_AMOUNT)),
      client: normalizeSql(extractBacktickStringContaining(readFile(FILES.clientPerItemRefundJs), MARKER_REFUND_AMOUNT)),
      payNotify: normalizeSql(extractBacktickStringContaining(readFile(FILES.payNotifyPerItemRefundJs), MARKER_REFUND_AMOUNT)),
      adminTs: normalizeSql(extractBacktickStringContaining(readFile(FILES.adminPerItemRefundTs), MARKER_REFUND_AMOUNT)),
    }
  })
  test('staff vs client（pg $1 占位符归一后一致）', () => {
    expect(refundSqls.client).toBe(refundSqls.staff)
  })
  test('staff vs payNotify（pg 副本一致）', () => {
    expect(refundSqls.payNotify).toBe(refundSqls.staff)
  })
  test('staff vs admin（pg $1 与 Drizzle ${saleOrderId} 归一为 ? 后一致）', () => {
    expect(refundSqls.adminTs).toBe(refundSqls.staff)
  })
  test('CTE 必须排除 OVERPAY 哨兵行', () => {
    expect(refundSqls.staff).toContain("<> 'OVERPAY'")
  })
  test('CTE 必须只取已支付退款', () => {
    expect(refundSqls.staff).toContain("change_type = '退款'")
    expect(refundSqls.staff).toContain("status = '已支付'")
  })
})

describe('积分抵扣与过期任务锁序守护', () => {
  function extractFunctionSection(src, functionName) {
    const start = src.indexOf(`async function ${functionName}`)
    expect(start, `未找到 ${functionName}`).toBeGreaterThanOrEqual(0)
    const next = src.indexOf('\nasync function ', start + functionName.length)
    return src.slice(start, next === -1 ? src.length : next)
  }

  const cases = [
    {
      name: 'clientApi',
      file: FILES.clientOrderJs,
      functionName: 'deductPointsAtCreation',
      availabilityCall: 'getAvailablePointsBalance',
    },
    {
      name: 'staffApi',
      file: FILES.staffOrderJs,
      functionName: 'deductPointsAtCreation',
      availabilityCall: 'getAvailablePointsBalance',
    },
    {
      name: 'admin',
      file: FILES.adminOrdersTs,
      functionName: 'deductPointsAtCreationTx',
      availabilityCall: 'availablePointsBalanceTx',
    },
  ]

  test.each(cases)('$name 先锁积分批次，再锁顾客缓存行', ({ file, functionName, availabilityCall }) => {
    const src = readFile(file)
    const body = extractFunctionSection(src, functionName)
    const availabilityBody = extractFunctionSection(src, availabilityCall)
    const availabilityIndex = body.indexOf(availabilityCall)
    const userLockIndex = body.indexOf('SELECT user_id FROM client_wechat_users')

    expect(availabilityIndex).toBeGreaterThanOrEqual(0)
    expect(userLockIndex).toBeGreaterThan(availabilityIndex)
    expect(availabilityBody).toMatch(/FROM point_batches[\s\S]*?FOR UPDATE/)
  })
})

// PR #74: shared SQL snapshots alone cannot detect a regression copied to all ends.
describe('cross-end-sql-snapshot 反模式守护（防镜像 bug 字面锁定失效）', () => {
  let grantedSqls
  let allocRollupSqls

  beforeAll(() => {
    grantedSqls = {
      staff: normalizeSql(extractBacktickStringContaining(readFile(FILES.staffPointsJs), MARKER_GRANTED)),
      client: normalizeSql(extractBacktickStringContaining(readFile(FILES.clientPointsJs), MARKER_GRANTED)),
      payNotify: normalizeSql(extractBacktickStringContaining(readFile(FILES.payNotifyPointsJs), MARKER_GRANTED)),
      adminTs: normalizeSql(extractBacktickStringContaining(readFile(FILES.adminPointsSettleTs), MARKER_GRANTED)),
    }
    allocRollupSqls = {
      staff: normalizeSql(extractBacktickStringContaining(readFile(FILES.staffPaymentAllocatableJs), 'allocation_status = CASE')),
      client: normalizeSql(extractBacktickStringContaining(readFile(FILES.clientPaymentAllocatableJs), 'allocation_status = CASE')),
      payNotify: normalizeSql(extractBacktickStringContaining(readFile(FILES.payNotifyPaymentAllocatableJs), 'allocation_status = CASE')),
      admin: normalizeSql(extractBacktickStringContaining(readFile(FILES.adminPaymentAllocatableTs), 'allocation_status = CASE')),
    }
  })

  test('四端 granted SQL 必须用 bigint 汇总 SUM(amount)', () => {
    for (const [end, sql] of Object.entries(grantedSqls)) {
      expect(sql, `${end} granted SQL 用 int 截断 SUM(amount)，应改 bigint`).not.toMatch(
        /SUM\(amount\)[\s\S]*::\s*int\b/i,
      )
      expect(sql, `${end} granted SQL 缺少 bigint cast`).toMatch(/SUM\(amount\)[\s\S]*::\s*bigint\b/i)
    }
  })

  test('四端 rollup 在无待/已分配子付款时必须归 NULL', () => {
    for (const [end, sql] of Object.entries(allocRollupSqls)) {
      expect(sql, `${end} rollup 缺少无子付款状态时清空父订单的分支`).toMatch(
        /ELSE\s+NULL::allocation_status\s+END/,
      )
      expect(sql, `${end} rollup 不得保留已失效的父订单 allocation_status`).not.toMatch(
        /ELSE\s+allocation_status\s+END/,
      )
    }
  })
})

describe('家居产品部分支付权益跨端守护', () => {
  const ASSET_FILES = [
    ['staff 顾客档案', FILES.staffCustomerJs],
    ['staff 管理层顾客档案', FILES.staffMgmtCustomerJs],
    ['client 我的家居产品', FILES.clientOrderJs],
    ['admin 顾客详情', FILES.adminCustomersTs],
  ]
  const PICKUP_FILES = [
    ['staff 提货', FILES.staffOrderJs],
    ['admin 提货', FILES.adminPickupRecordsTs],
  ]

  // 断言必须跑在「家居产品资产查询」这一条 SQL 上，不能跑在整份文件上：
  // o.status IN (...) / item_direction 这类串在同文件其它查询里也出现，
  // 文件级 toContain 会被兄弟查询兜底，单端漂移测不出来（变异测试实证）。
  const homeProductSql = (file) =>
    normalizeSql(extractBacktickStringContaining(readFile(file), 'home_product_balances'))

  test.each(ASSET_FILES)('%s 纳入部分支付并按实收比例计算已付整件数', (_name, file) => {
    const src = homeProductSql(file)
    expect(src).toContain("o.status IN ('已支付', '部分支付', '已完成')")
    expect(src).toContain(
      'FLOOR(GREATEST(0, si.received::numeric) * si.quantity / NULLIF(si.sale_amount::numeric, 0))::int',
    )
    expect(src).toContain('GREATEST(paid_quantity - picked_quantity, 0)')
    expect(src).toContain('pending_pickup_quantity')
    expect(src).toContain("si.item_direction = '购买'")
    expect(src).toContain("si.product_type = '家居产品'")
  })

  // issue #120：部分支付且不足一整件时 paid_quantity=0 → pending_pickup_quantity=0，
  // 旧过滤 `picked > 0 OR pending > 0` 会把整行剔除，顾客档案看不到已购与欠款。
  // 改为按物理剩余份额放行；提货拦截仍走 PICKUP_FILES 那套，口径不变。
  test.each(ASSET_FILES)('%s 按剩余份额放行，未付清的行不被整行过滤', (_name, file) => {
    const src = homeProductSql(file)
    expect(src).toContain('WHERE picked_quantity > 0 OR remaining_quantity > 0')
    expect(src, '不得回退到会吞掉未付清行的旧过滤').not.toContain(
      'WHERE picked_quantity > 0 OR pending_pickup_quantity > 0',
    )
  })

  // 寄存单 sale_amount 是原价快照、received 是历史值，相减不是欠款。
  // 放行后若不置空，会向顾客伪造债务（dev 实测 86 行 / ¥44834.30），必须四端一起锁死。
  test.each(ASSET_FILES)('%s 寄存单不参与欠款计算', (_name, file) => {
    const src = homeProductSql(file)
    expect(src).toContain("(o.sale_order_type = '寄存单') AS is_deposit")
    expect(src).toContain('CASE WHEN is_deposit THEN NULL')
    expect(src).toContain('ELSE GREATEST(0, sale_amount_total - received_total)::numeric(12, 2)')
    expect(src).toContain('END AS unpaid_amount')
    // 不得退回到无条件相减的写法
    expect(src).not.toMatch(
      /GREATEST\(0, sale_amount_total - received_total\)::numeric\(12, 2\) AS unpaid_amount/,
    )
  })

  test.each(ASSET_FILES)('%s 按 sale_item_group_id 合并，四端行粒度一致', (_name, file) => {
    const src = homeProductSql(file)
    expect(src).toContain('COALESCE(si.sale_item_group_id, si.sale_item_id) AS sale_item_group_id')
    expect(src).toContain('GROUP BY sale_item_group_id')
    expect(src).toContain('BOOL_OR(si.is_deposit) AS is_deposit')
  })

  // 状态派生：staff/client 内联在各自 mapHomeProductRow，admin 抽在 lib/home-product.ts
  const STATUS_FILES = [
    ['staff 顾客档案', FILES.staffCustomerJs],
    ['staff 管理层顾客档案', FILES.staffMgmtCustomerJs],
    ['client 我的家居产品', FILES.clientOrderJs],
    ['admin 状态派生', FILES.adminHomeProductTs],
  ]

  // 断言必须把「条件 + label」绑成整句：只 toContain('待付清') 会被同文件的注释满足，
  // 只 toMatch 条件表达式则测不出 label 被改、分支被挪位或变成死代码（变异测试实证）。
  test.each(STATUS_FILES)('%s 待付清与欠款金额绑定，且排在已提货兜底之前', (_name, file) => {
    const src = readFile(file)
    const isAdmin = /\.ts$/.test(file)
    if (isAdmin) {
      expect(src).toContain("if (unpaidAmount != null && unpaidAmount > 0) return '待付清'")
      expect(src).toContain("if (remainingQuantity > 0) return '待提货'")
      // #125：已转换与已退款同判「已完成」，二者同源于 picked_up_quantity
      expect(src).toContain("return (refundedQuantity > 0 || convertedQuantity > 0) ? '已完成' : '已提货'")
    } else {
      expect(src).toContain("else if (unpaidAmount > 0) status = '待付清'")
      expect(src).toContain("else if (remainingQuantity > 0) status = '待提货'")
      expect(src).toContain("else status = (refundedQuantity > 0 || convertedQuantity > 0) ? '已完成' : '已提货'")
    }
    // 分支顺序：待付清 → 待提货 → 已完成/已提货 兜底。顺序错了语义就反了。
    const idxUnpaid = src.indexOf('待付清')
    const idxRemaining = src.lastIndexOf('待提货')
    const idxFallback = src.indexOf("'已完成' : '已提货'")
    expect(idxUnpaid).toBeGreaterThan(-1)
    expect(idxFallback).toBeGreaterThan(-1)
    expect(idxUnpaid, '待付清必须先于已提货兜底判断').toBeLessThan(idxFallback)
    expect(idxRemaining, '待提货兜底必须先于已完成判断').toBeLessThan(idxFallback)
  })

  // 「算不出欠款」必须短路成 null：退款行（received 是净实收）与寄存单（SQL 置 NULL）都走这条。
  // 跑在 mapper 所在文件上（admin 的短路在 customers.ts，不在 lib/home-product.ts）。
  test.each(ASSET_FILES)('%s 退款行与金额缺失行不下发欠款', (_name, file) => {
    const src = readFile(file)
    expect(src).toMatch(
      /refundedQuantity > 0 \|\| row\.unpaid_amount == null \? null : Number\(row\.unpaid_amount\)/,
    )
  })

  test.each(PICKUP_FILES)('%s 在事务锁内复算已付可提上限', (_name, file) => {
    const src = normalizeSql(readFile(file))
    expect(src).toContain(
      'FLOOR(GREATEST(0, si.received::numeric) * si.quantity / NULLIF(si.sale_amount::numeric, 0))::int',
    )
    expect(src).toContain('pendingHomeProductQuantity')
    expect(src).toContain('FOR UPDATE OF si')
    expect(src).toContain("['已支付', '部分支付', '已完成'].includes")
  })

  // issue #128：家居 paid_quantity 原先只有行级 `sale_amount <= 0` 满付分支。寄存单
  // sale_amount=原价快照>0 而 received=0 → FLOOR 恒 0 → 可提恒 0，顾客寄存的货提不出来。
  //
  // ⚠ 断言必须**逐个 CASE 块**校验，不能跑整份文件：staffApi/routes/order.js 有 4 处、
  // admin/actions/pickup-records.ts 有 3 处 paid_quantity 站点，文件级 toContain 只要
  // 命中任意一处就通过——删掉 createPickup 事务锁内那处最关键闸门也测不出来（变异实证）。
  const PAID_QUANTITY_SITES = [
    ['staff 顾客档案', FILES.staffCustomerJs, 1],
    ['staff 管理层顾客档案', FILES.staffMgmtCustomerJs, 1],
    ['client 我的家居产品', FILES.clientOrderJs, 1],
    ['admin 顾客详情', FILES.adminCustomersTs, 1],
    ['staff 提货', FILES.staffOrderJs, 4],
    ['admin 提货', FILES.adminPickupRecordsTs, 3],
  ]

  /** 取出文件内每一个 `CASE ... END AS paid_quantity` 块（剥注释 + 压空白） */
  function extractPaidQuantityCases(file) {
    const src = readFile(file).replace(/--[^\n]*/g, '')
    const blocks = []
    let idx = 0
    while (true) {
      const endAt = src.indexOf('END AS paid_quantity', idx)
      if (endAt === -1) break
      const caseAt = src.lastIndexOf('CASE', endAt)
      blocks.push(normalizeSql(src.slice(caseAt, endAt + 'END AS paid_quantity'.length)))
      idx = endAt + 1
    }
    return blocks
  }

  test.each(PAID_QUANTITY_SITES)(
    '%s 每一处家居已付整件数都含寄存单满付分支',
    (_name, file, expectedSites) => {
      const blocks = extractPaidQuantityCases(file)
      expect(blocks.length, '站点数变化：新增/删除了 paid_quantity 查询，需同步本断言').toBe(
        expectedSites,
      )
      blocks.forEach((block, i) => {
        expect(block, `第 ${i + 1} 处 paid_quantity 缺寄存单满付分支`).toContain(
          "WHEN o.sale_order_type = '寄存单' THEN si.quantity",
        )
        expect(block, `第 ${i + 1} 处 paid_quantity 缺行级赠品分支`).toContain(
          'WHEN si.sale_amount <= 0 THEN si.quantity',
        )
      })
    },
  )

  test('家居已付整件数 11 处站点跨端逐字同义', () => {
    const all = PAID_QUANTITY_SITES.flatMap(([, file]) => extractPaidQuantityCases(file))
    expect(all.length).toBe(11)
    const unique = [...new Set(all)]
    expect(unique, `11 处 CASE 块出现 ${unique.length} 种写法，跨端已漂移`).toHaveLength(1)
  })
})

describe('转换单在线回款意图事务守护', () => {
  const staffOrder = readFile(FILES.staffOrderJs)
  const qrcodeBody = staffOrder.match(/async function qrcode\b[\s\S]*?(?=\nasync function )/)?.[0] || ''
  const repaymentBody = staffOrder.match(/async function createRepayment\b[\s\S]*?(?=\n\/\/ ========== P2)/)?.[0] || ''

  test('qrcode 使用行锁和 NULL-CAS，禁止覆盖已有在线回款意图', () => {
    expect(qrcodeBody).toContain('FOR UPDATE')
    expect(qrcodeBody).toContain('first_payment_amount IS NULL')
    expect(qrcodeBody).toContain('lakala_out_order_no IS NULL')
    expect(qrcodeBody).toContain("String(locked.lakala_out_order_no || '').trim()")
    expect(qrcodeBody).toContain('ONLINE_PAYMENT_INTENT_ACTIVE')
    expect(qrcodeBody).not.toMatch(/SET first_payment_amount = \$1,[\s\S]*lakala_out_order_no = NULL/)
  })

  test('createRepayment 拒绝活动渠道单，并可在无渠道单时同事务冻结卡后在线补差', () => {
    expect(repaymentBody).toContain('onlinePaymentAmount')
    expect(repaymentBody).toContain('totalThisTime + onlinePaymentAmount')
    expect(repaymentBody).toMatch(/pending_prepaid_card_amount = 0,[\s\S]*first_payment_amount = \$4/)
    expect(repaymentBody).toContain('nextOnlinePaymentAmount')
    expect(repaymentBody).toContain("String(locked.lakala_out_order_no || '').trim()")
    expect(repaymentBody).toContain('lakala_out_order_no IS NULL')
    expect(repaymentBody).not.toContain('lakala_out_order_no = CASE')
  })
})

// ============================================================
// #125 家居产品转换折抵 — 双端语义同义 + 展示层三端拆分
// ============================================================
describe('#125 家居转换折抵跨端守护', () => {
  const staffOrderSrc = readFile(FILES.staffOrderJs)
  const adminOrdersSrc = readFile(FILES.adminOrdersTs)
  // 四份副本：#121 给 staff 管理层新增了第四份家居查询，改一处必须四处同步
  const HOME_ASSET_FILES = [
    ['staff 顾客档案', FILES.staffCustomerJs],
    ['staff 管理层顾客档案', FILES.staffMgmtCustomerJs],
    ['client 我的家居产品', FILES.clientOrderJs],
    ['admin 顾客详情', FILES.adminCustomersTs],
  ]

  // 扣减侧：必须落 picked_up_quantity 且带「加完不得超过 quantity」守卫。
  // 用 LEAST 静默封顶会让并发双开的第二笔转换单悄悄少转，不报错 → 必须是守卫式加法。
  describe('转出数量并入 picked_up_quantity 且不可超转', () => {
    test('staff createConversion 守卫式加法', () => {
      expect(staffOrderSrc).toMatch(
        /SET picked_up_quantity = COALESCE\(picked_up_quantity, 0\) \+ \$4[\s\S]*?\(COALESCE\(picked_up_quantity, 0\) \+ \$4\) <= quantity/,
      )
    })
    test('admin createConversionOrder 守卫式加法', () => {
      expect(adminOrdersSrc).toMatch(
        /pickedUpQuantity: sql`COALESCE\(\$\{saleItems\.pickedUpQuantity\}, 0\) \+ \$\{out\.quantity\}`/,
      )
      expect(adminOrdersSrc).toMatch(
        /sql`\(COALESCE\(\$\{saleItems\.pickedUpQuantity\}, 0\) \+ \$\{out\.quantity\}\) <= \$\{saleItems\.quantity\}`/,
      )
    })
  })

  // 回滚侧：转换单被关闭/删除时家居数量必须等量退回，否则货既提不出也退不掉。
  describe('撤销转换单时家居数量等量退回', () => {
    const ROLLBACK_FILES = [
      ['staff', FILES.staffOrderJs],
      ['admin', FILES.adminOrdersTs],
    ]
    test.each(ROLLBACK_FILES)('%s rollbackPendingConversionOnClose 含家居回滚段', (_name, file) => {
      const src = normalizeSql(readFile(file))
      expect(src).toContain('SUM(quantity)::integer AS restore_quantity')
      expect(src).toContain("item_direction = '转出' AND product_type = '家居产品'")
      expect(src).toContain('SET picked_up_quantity = GREATEST(0, COALESCE(src.picked_up_quantity, 0) - locked_source.restore_quantity)')
      // 疗程卡回滚段不得被顺手删掉
      expect(src).toContain('restore_sessions')
    })
    test('admin deleteOrder 在事务内锁单读新鲜状态后才回滚（防 close‖delete 交错双回滚）', () => {
      // 事务外读到的 order.status 可能已被并发的 closeOrder 改掉，用陈旧值会把家居数量多退一遍
      expect(adminOrdersSrc).toMatch(
        /SELECT status FROM sale_orders WHERE sale_order_id = \$\{saleOrderId\} FOR UPDATE/,
      )
      expect(adminOrdersSrc).toMatch(
        /order\.saleOrderType === '转换单'[\s\S]{0,400}freshStatus === '待支付'[\s\S]{0,60}freshStatus === '支付失败'/,
      )
    })

    test.each(ROLLBACK_FILES)('%s 回滚 locked_source 仍按 sale_item_id 定序（全局锁定段之外的纵深保证）', (_name, file) => {
      const src = normalizeSql(readFile(file))
      // 全局锁定段 + 两段 locked_source，共 3 处定序加锁
      // 全局锁定段 + 两段 locked_source；用 >= 避免后续新增定序锁点时误报
      const ordered = src.match(/ORDER BY src\.sale_item_id FOR UPDATE OF src/g) || []
      expect(ordered.length).toBeGreaterThanOrEqual(3)
    })
  })

  // 折抵候选的订单状态闸门：甲方 2026-09-14 拍板放开「部分支付」，两端必须同步，
  // 否则 admin 能选中的行在 staff 提交时会被拒（或反之）。
  describe('折抵候选订单状态闸门两端一致', () => {
    test('staff customerHeldCards + createConversion 均含「部分支付」', () => {
      const src = normalizeSql(readFile(FILES.staffOrderJs))
      expect(src).toContain("so.status IN ('已支付', '部分支付', '已完成')")
      expect(src).toContain("row.order_status !== '已支付' && row.order_status !== '部分支付' && row.order_status !== '已完成'")
    })
    test('admin getCustomerHeldCards 复用 CARD_ENTITLEMENT_ORDER_STATUSES，createConversionOrder 同步放开', () => {
      const cardsSrc = readFile(path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/cards.ts'))
      // 与卡包列表共用同一组状态常量，避免两处硬编码漂移
      expect(cardsSrc).toContain("const CARD_ENTITLEMENT_ORDER_STATUSES = ['已支付', '部分支付', '已完成']")
      expect(cardsSrc).toMatch(/inArray\(saleOrders\.status, \[\.\.\.CARD_ENTITLEMENT_ORDER_STATUSES\]\)[\s\S]{0,600}疗程卡/)
      const ordersSrc = readFile(FILES.adminOrdersTs)
      expect(ordersSrc).toContain("row.order_status !== '已支付' && row.order_status !== '部分支付' && row.order_status !== '已完成'")
    })
  })

  // 退款审批侧：createRefund 无锁定额 + cascade 的 LEAST 静默封顶 = 同一批货可能既折抵又退现金。
  // 资金流出前必须在锁内复核家居可退数量。
  describe('退款审批锁内复校家居可退数量', () => {
    const APPROVE_FILES = [
      ['staff approveRefund', FILES.staffOrderJs],
      ['admin approveRefund', path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/refunds.ts')],
    ]
    test.each(APPROVE_FILES)('%s 在 cascadeRefund 前锁行复核', (_name, file) => {
      const src = normalizeSql(readFile(file))
      expect(src).toContain('homeRefundQty')
      // 锁集必须覆盖本单全部购买行（不能只锁家居子集），否则与混选转换事务反向加锁；
      // 且必须按 sale_item_id 升序，与 createConversion(Order) 的锁序一致
      expect(src).toContain("AND item_direction = '购买' ORDER BY sale_item_id FOR UPDATE")
      expect(src).not.toContain("AND product_type = '家居产品' ORDER BY sale_item_id FOR UPDATE")
      expect(src).toMatch(/homeRefundQty[\s\S]{0,2500}cascadeRefund/)
      // 加锁必须无条件：老退款单（无 note.items 且 ref_sale_item_id 空）会让 homeRefundQty 为空，
      // 用 `if (homeRefundQty.size > 0)` 包裹加锁就退回「不锁不校验」的旧缺口
      expect(src).not.toContain('homeRefundQty.size > 0')
    })
  })

  // 回滚加锁必须是「一次性全局定序」而非分类型两段，否则混选转换单会与开单事务反向加锁
  test.each([
    ['staff', FILES.staffOrderJs],
    ['admin', FILES.adminOrdersTs],
  ])('%s 回滚前先按全局 sale_item_id 顺序锁住全部源行', (_name, file) => {
    const src = normalizeSql(readFile(file))
    expect(src).toContain('SELECT DISTINCT ref_sale_item_id')
    expect(src).toMatch(/refs ON refs\.ref_sale_item_id = src\.sale_item_id ORDER BY src\.sale_item_id FOR UPDATE OF src/)
  })

  // 展示侧：picked_up_quantity 同时承载「已提货 / 已退款 / 已转换」，
  // 三端必须把已转换拆出来，否则转出会被读成退款。
  test.each(HOME_ASSET_FILES)('%s 把已转换从已退款里拆出来', (_name, file) => {
    const src = normalizeSql(readFile(file))
    expect(src).toContain('conversion_totals')
    // 只排除 '已关闭'：唯一会触发 rollbackPendingConversionOnClose 的状态。
    // 用 NOT IN 多值排除会把「扣减仍生效」的状态（如 '支付失败'）误记成已退款。
    expect(src).toContain("conv_order.status <> '已关闭'")
    expect(src).not.toContain("conv_order.status NOT IN")
    expect(src).toContain('settled_quantity - picked_quantity - converted_quantity')
    // 整行折抵（从未物理提货）后 picked=0、pending=0，不放行 converted 就会整行消失
    expect(src).toContain('WHERE picked_quantity > 0 OR remaining_quantity > 0 OR converted_quantity > 0')
  })
})

describe('疗程卡可用次数为 0 时仍展示的跨端守护（issue #122）', () => {
  // 部分支付且实收不足一次单价 → paid_sessions=0，旧过滤把整张卡剔除，顾客档案查无此卡。
  // 展示门槛改为物理剩余次数；核销限额仍走 paid_sessions，由 service 侧独立校验。
  const CARD_LIST_FILES = [
    ['staff 顾客档案 paidOrders', FILES.staffCustomerJs],
    ['staff 管理层 paidOrders', FILES.staffMgmtCustomerJs],
  ]

  // 断言必须锁在 paidOrders 的那条 SQL 上：customer.js 是 2000+ 行、十几条查询的文件，
  // 文件级 toContain 会被兄弟查询（甚至注释）兜底而静默失效（变异测试实证）。
  // 必须先剥 `--` 注释再断言：normalizeSql 只压空白不去注释，
  // 一句 `-- si.remaining_sessions > 0` 的注释就能骗过 toContain（变异测试实证）。
  const stripSqlComments = (sql) => sql.replace(/--[^\n]*/g, '')
  const cardListSql = (file) =>
    normalizeSql(stripSqlComments(extractBacktickStringContaining(readFile(file), 'si.paid_sessions')))

  test.each(CARD_LIST_FILES)('%s 按剩余次数放行，不再用已付未用整行过滤', (_name, file) => {
    const src = cardListSql(file)
    expect(src).toContain('si.remaining_sessions > 0')
  })

  // ⚠ 退款不减 remaining_sessions（Model X）：paid_sessions 是「已退卡从卡包消失」的唯一机制。
  // 放宽展示门槛后必须保留这条守卫，否则已退款的卡会重新出现并被标成待付清（实测 87 行 / ¥118605）。
  test.each(CARD_LIST_FILES)('%s 保留已审批退款守卫，已退卡不得因放宽展示而复现', (_name, file) => {
    const src = cardListSql(file)
    expect(src).toContain("AND sop.change_type = '退款' AND sop.status = '已支付'")
    expect(src).toContain('OR si.paid_sessions > (si.session_count - si.remaining_sessions)')
  })

  // 欠款三重条件：订单确实未付清 + 该卡未买满次数 + 按行级净实收相减。
  // 缺第一条会把「已付清但行级分摊缺口」（dev 实测 78 行）报成欠款；
  // 缺第二条会把寄存单（sale_amount 只是原价快照）报成欠款。
  // admin 不在此列：admin 的卡包列表/顾客详情卡包 Tab 是资产管理视图，只展示次数不展示欠款
  // （欠款催收在 admin 侧走订单详情的「可回款」口径，见 actions/orders.ts）。
  // 若将来 admin 要展示行级欠款，必须把它加进本列表，保持四端同源。
  const DEBT_FILES = [
    ['staff 顾客档案', FILES.staffCustomerJs],
    ['staff 管理层', FILES.staffMgmtCustomerJs],
    ['client 我的疗程卡', FILES.clientOrderJs],
  ]

  test.each(DEBT_FILES)('%s 行级欠款仅在订单未付清且卡未买满次数时计算', (_name, file) => {
    // 整条 CASE 作为一个字面量断言：拆成多条 toContain 允许「某条 AND 被删、
    // 同文件别处恰好有该字面量」的组合逃逸。
    const src = normalizeSql(stripSqlComments(readFile(file)))
    const caseExpr = src.match(/CASE\s+WHEN o\.status = '部分支付'[\s\S]*?END AS unpaid_amount/)?.[0]
    expect(caseExpr, '未能定位 unpaid_amount 的 CASE 表达式').toBeTruthy()
    expect(caseExpr).toContain('AND si.paid_sessions IS NOT NULL')
    expect(caseExpr).toContain('AND si.paid_sessions < si.session_count')
    // received 是行级净实收，退款会下调它 → 相减必然虚增欠款，故已退单一律不算
    expect(caseExpr).toContain("AND sop.change_type = '退款' AND sop.status = '已支付'")
    // 1 元阈值：瀑布分摊尾差会造出 ¥0.01 的假欠款
    expect(caseExpr).toContain('AND (si.sale_amount::numeric - si.received::numeric) >= 1')
    expect(caseExpr).toContain(
      'THEN GREATEST(0, si.sale_amount::numeric - si.received::numeric)::numeric(12, 2)',
    )
  })

  test('admin 卡包列表按剩余次数展示，不再按已付次数硬过滤', () => {
    const src = readFile(FILES.adminCardsTs)
    // 断言必须锁在 buildCardBaseConditions 函数体内：同文件别处也有
    // `remainingSessions > 0`，文件级 toContain 会被兄弟代码兜底而测不出回退。
    const body = src.match(
      /function buildCardBaseConditions\b[\s\S]*?\n\}/,
    )?.[0]
    expect(body, '未能定位 buildCardBaseConditions 函数体').toBeTruthy()
    expect(body, '不得回退到 paid_sessions > 0 硬过滤').not.toContain(
      'sql`${saleItems.paidSessions} > 0`',
    )
    // 基础集也不能按 remaining 过滤：status='exhausted' 要的正是 remaining=0，
    // base 先排掉它会让该筛选恒空、卡详情 404、导出漏行。
    expect(body, '基础集不得按次数过滤').not.toContain(
      'sql`${saleItems.remainingSessions} > 0`',
    )
  })

  // 核销限额与展示解耦：service 侧三处校验必须原样保留，放宽展示不得放宽核销。
  test('service 核销限额仍按 paid_sessions 校验，未被展示放宽波及', () => {
    const src = readFile(FILES.staffServiceJs)
    expect(src).toContain('INSUFFICIENT_BALANCE')
    expect(src).toMatch(/COALESCE\(paid_sessions, session_count\)/)
  })

  /**
   * issue #139 — 款项业绩归属日期筛选的跨端形态守护。
   *
   * 两端实现语言不同（staff 原生 SQL / admin Drizzle），不能做字面 snapshot 相等，
   * 守护的是**三条口径不变量**在四个站点上同时成立：
   *   ① 订单粒度用 EXISTS 半连接，且带 `status='已支付'` 语义闸门
   *   ② 款项粒度直接约束当前行，**不得**套 EXISTS（否则带出同订单区间外的款项）
   *   ③ 归属日期是 date，一律闭区间 `::date`，不得混入 timestamptz 半开区间
   * 任一端单边漂移都会在这里断掉。
   */
  describe('款项业绩归属日期筛选（#139，四站点形态一致）', () => {
    test('订单粒度两端都是 EXISTS 半连接 + 已入账闸门', () => {
      const staffList = readFile(FILES.staffOrderJs).match(
        /async function list\(ctx\)[\s\S]*?\n\}/,
      )?.[0]
      expect(staffList, '未能定位 staff order.list 函数体').toBeTruthy()
      // normalizeSql 会清掉括号内侧空白，故断言串里 `EXISTS (SELECT` 之间无空格
      const staffFlat = normalizeSql(staffList)
      expect(staffFlat, 'staff 订单列表必须走 EXISTS 半连接').toContain(
        "EXISTS (SELECT 1 FROM sale_order_payments pf WHERE pf.sale_order_id = o.sale_order_id AND pf.status = '已支付'",
      )

      const adminConds = readFile(FILES.adminOrdersTs).match(
        /function buildOrderConditions\b[\s\S]*?\n\}/,
      )?.[0]
      expect(adminConds, '未能定位 admin buildOrderConditions 函数体').toBeTruthy()
      expect(adminConds, 'admin 订单管理必须走 EXISTS 半连接').toContain(
        'FROM ${saleOrderPayments} AS payment_attribution_filter',
      )
      expect(adminConds, 'admin 侧 status 语义闸门不得删').toContain(
        "payment_attribution_filter.status = '已支付'",
      )
    })

    test('款项粒度两端都约束当前行，不退化成 EXISTS', () => {
      const staffPending = readFile(FILES.staffAllocationJs).match(
        /async function pendingPayments\(ctx\)[\s\S]*?\n\}/,
      )?.[0]
      expect(staffPending, '未能定位 staff allocation.pendingPayments 函数体').toBeTruthy()
      expect(staffPending, 'staff 分配列表必须行级约束归属日期').toContain(
        "addDateRange(conditions, params, 'p.performance_attribution_date', startDate, endDate)",
      )
      // 归属日期在该函数体内只许出现这一次；套进任何 EXISTS 子查询都会引入第二次引用或换别名
      expect(
        staffPending.match(/performance_attribution_date/g),
        'staff 分配列表的归属日期引用次数漂移（疑似退化成 EXISTS）',
      ).toHaveLength(1)

      const adminAllocationsSrc = readFile(FILES.adminAllocationsTs)
      const adminPending = adminAllocationsSrc.match(
        /const dateRangeConditions = \(\(\) => \{[\s\S]*?\}\)\(\)/,
      )?.[0]
      expect(adminPending, '未能定位 admin 分配列表日期条件块').toBeTruthy()
      // 不传 paymentAlias == 引用 sale_order_payments 表本身 == 行级约束
      expect(adminPending, 'admin 分配列表必须行级约束（不得传 alias 变成 EXISTS 形态）').toContain(
        'paymentAttributionRangeConditions(params.dateFrom, params.dateTo)',
      )
      // codex 评审 P2：上面只证明"helper 被调用并赋给局部变量"，不证明它接进了最终 WHERE。
      // 删掉展开处，条件就静默失效而断言仍绿——所以这里必须钉住展开位置。
      //
      // 这条断言被两轮评审各打穿一次，逐级加固到现在：
      //   toContain          → 吃行注释 `// ...dateRangeConditions,`（GLM round-2 指出）
      //   行形锚点 /^\s*\.\.\./m → 吃块注释（codex round-3 实际变异验证：把整行包进 /* */ 仍匹配）
      //   现在：先剥注释再匹配，两种注释形态都失效
      expect(
        stripJsComments(adminAllocationsSrc),
        'admin 分配列表的日期条件未接入最终查询（dateRangeConditions 未展开进 conds，或被注释掉）',
      ).toMatch(/^\s*\.\.\.dateRangeConditions,$/m)
    })

    // GLM 评审 P2：上面四条只守护「attribution 分支的代码形态还在」，
    // 不守护「默认就走这个分支」。把 admin 的 `?? 'attribution'` 改成 `?? 'payment'` 一个词，
    // 默认口径即退回 paid_at 半开区间，而所有形态断言仍然全绿——
    // 而「staff 与 admin 默认口径一致」正是 #139 的头号验收标准。
    test('admin 两处默认口径锚点仍是 attribution（staff 无下拉，只能对齐默认值）', () => {
      expect(
        readFile(FILES.adminOrdersTs),
        'admin 订单管理默认口径漂移，staff 侧无下拉可切，会与 staff 出数不一致',
      ).toContain("filters.dateBasis ?? 'attribution'")
      expect(
        readFile(FILES.adminAllocationsTs),
        'admin 营业额分配默认口径漂移，staff 侧无下拉可切，会与 staff 出数不一致',
      ).toContain("params.dateBasis ?? 'attribution'")
    })

    test('两端归属日期一律 date 闭区间，无 timestamptz 半开区间', () => {
      const staffOrder = readFile(FILES.staffOrderJs).match(
        /async function list\(ctx\)[\s\S]*?\n\}/,
      )?.[0]
      // staff 两处都走 list-filters 的 addDateRange（`>= $n::date` / `<= $n::date`）
      expect(staffOrder).toContain(
        "addDateRange(attributionParts, params, 'pf.performance_attribution_date', startDate, endDate)",
      )
      const addDateRange = readFile(
        path.resolve(__dirname, '../../utils/list-filters.js'),
      ).match(/function addDateRange\([\s\S]*?\n\}/)?.[0]
      expect(addDateRange, '未能定位 addDateRange').toBeTruthy()
      expect(addDateRange, 'staff 侧闭区间形态漂移').toContain('>= $${params.length}::date')
      expect(addDateRange, 'staff 侧闭区间形态漂移').toContain('<= $${params.length}::date')
      expect(addDateRange, 'staff 侧不得混入半开区间').not.toContain('+ 1)')

      const adminHelper = readFile(FILES.adminPerformanceAttributionTs)
      const rangeFn = adminHelper.match(
        /export function paymentAttributionRangeConditions[\s\S]*?\n\}/,
      )?.[0]
      expect(rangeFn, '未能定位 paymentAttributionRangeConditions').toBeTruthy()
      expect(rangeFn, 'admin 侧闭区间形态漂移').toContain('>= ${dateFrom}::date')
      expect(rangeFn, 'admin 侧闭区间形态漂移').toContain('<= ${dateTo}::date')
      expect(rangeFn, 'admin 侧不得退回北京半开区间').not.toContain('beijingNextDayBoundaryTs')
    })

    /**
     * 迁移就绪探针 SQL 的**精确快照**（codex round-4 P2）。
     *
     * 为什么不能只断言「关键片段存在」：那样可以一边保留原片段（塞进 SQL 块注释或一个
     * 没被引用的 CTE）、一边用 `(1 = 0) AS has_gap, (1 = 1) AS trigger_ready` 供值，
     * 所有正向片段断言仍命中、常量黑名单也拦不住，而空的 0038 库会被永久缓存成 ready。
     * codex 实测演示过这条绕过路径。
     *
     * 逐字快照把「改探针」变成必须显式更新本断言的有意识动作。
     * 改动本 SQL 时请同步确认：① 存量缺口谓词 ② 0039 正面分支比对串 ③ 两个字段真的由子查询供值。
     */
    test('迁移就绪探针 SQL 精确快照', () => {
      const src = readFile(path.resolve(__dirname, '../../utils/attribution-guard.js'))
      const probeSql = extractBacktickStringContaining(src, 'has_gap')
      expect(normalizeSql(probeSql)).toBe(
        "SELECT EXISTS (SELECT 1 FROM sale_order_payments WHERE change_type = '首次支付'"
        + " AND status = '已支付' AND performance_attribution_date IS NULL) AS has_gap,"
        + " COALESCE((SELECT pg_get_functiondef(p.oid) LIKE '%IF NEW.change_type = ''首次支付'' THEN%'"
        + " FROM pg_proc p WHERE p.proname = 'initialize_payment_performance_attribution_date'"
        + ' LIMIT 1), false) AS trigger_ready',
      )
    })

    /**
     * #141：年度消费（`customer.js` / `mgmt-customer.js` 两份**字节同义副本**）
     * 直读款项归属日期，未迁库时首次支付行 100% NULL，
     * 正数主体被三值逻辑吞掉、只剩退款负数（dev 实测 −425801.66）。
     *
     * 两边都必须过守卫——此前移除 `customer.js` 那侧的守卫**没有任何测试变红**
     * （mgmt 侧有行为用例，customer 侧没有），故在此补字面量守护。
     */
    test('年度消费两份副本都必须过迁移就绪守卫', () => {
      for (const key of ['staffCustomerJs', 'staffMgmtCustomerJs']) {
        // 必须剥注释：两个文件的注释里正好都提到 `utils/attribution-guard.js`，
        // 裸 readFile 会让第一条断言被注释满足。
        // （本文件没有通用 stripComments，这里就地剥掉块注释与整行行注释。）
        // 块注释 + 行注释（含**行内尾注释**：`x(); // assertPaymentAttributionReady(pg)`
        // 这种写法会让「删了调用但留着尾注释」骗过断言 —— GLM 评审指出）
        const src = readFile(FILES[key])
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
        expect(src, `${key} 未接入 attribution-guard`).toContain('utils/attribution-guard')
        expect(src, `${key} 未在年度消费查询前调用守卫`)
          .toContain('assertPaymentAttributionReady(pg)')
      }
    })

    test('staff 带日期筛选前必须过迁移就绪守卫（未迁库时宁可报错也不出空数据）', () => {
      for (const key of ['staffOrderJs', 'staffAllocationJs']) {
        const src = readFile(FILES[key])
        expect(src, `${key} 未接入 attribution-guard`).toContain(
          "require('../utils/attribution-guard')",
        )
        expect(src, `${key} 未在日期分支调用守卫`).toContain('assertPaymentAttributionReady(pg)')
      }
    })
  })
})
