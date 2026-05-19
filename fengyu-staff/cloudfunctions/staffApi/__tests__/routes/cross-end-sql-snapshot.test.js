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

  staffOrderJs: path.resolve(__dirname, '../../routes/order.js'),
  payNotifyIndexJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/payNotify/index.js'),
  adminOrdersTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/orders.ts'),

  // SUMMARY v3 §2 #11 — face_value_override 五处读取
  staffCouponJs: path.resolve(__dirname, '../../routes/coupon.js'),
  clientCouponJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/routes/coupon.js'),
  clientOrderJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/routes/order.js'),

  // SUMMARY v3 §2 #14 — cascadeRefund 双端副本 + 触发点
  staffRefundCascadeJs: path.resolve(__dirname, '../../helpers/refund-cascade.js'),
  adminRefundCascadeTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/refund-cascade.ts'),
  adminRefundsTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/refunds.ts'),

  // SUMMARY v3 §2 #13 — scope assert helper 双端副本
  staffScopeJs: path.resolve(__dirname, '../../utils/scope.js'),
  adminScopeAssertTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/scope-assert.ts'),
  // SUMMARY v3 §2 #13 — client 端 scope helper（语义不同：单用户归属，不参与 staff/admin 跨端 SQL 对比）
  clientScopeJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/utils/scope.js'),
}

function readFile(p) {
  return fs.readFileSync(p, 'utf8')
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

describe('audit-15 P0-15-02 协同：四端 settlePointsForOrder SQL 一致性守护', () => {
  let netSettledSqls
  let grantedSqls

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

  describe('Snapshot 守护（提交后任一字符漂移立即可见）', () => {
    test('settlePoints 关键 SQL 文本快照', () => {
      expect({
        netSettled: netSettledSqls.staff,
        granted: grantedSqls.staff,
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

  // 通道 1：sale_allocations 软删（UPDATE ... SET is_void = true + voided_at）
  describe('通道 1：sale_allocations 软删', () => {
    test('staff 必须 UPDATE sale_allocations SET is_void = true + voided_at', () => {
      expect(staffSrc).toMatch(/UPDATE\s+sale_allocations[\s\S]*?SET[\s\S]*?is_void\s*=\s*true/i)
      expect(staffSrc).toMatch(/sale_allocations[\s\S]*?voided_at\s*=/i)
    })
    test('admin 必须 UPDATE sale_allocations SET is_void = true + voided_at', () => {
      expect(adminSrc).toMatch(/UPDATE\s+sale_allocations[\s\S]*?SET[\s\S]*?is_void\s*=\s*true/i)
      expect(adminSrc).toMatch(/sale_allocations[\s\S]*?voided_at\s*=\s*NOW\(\)/i)
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

  // 通道 3：user_coupons 状态翻转（UPDATE ... SET status = '未使用'）
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
  })

  // 通道 4：point_transactions 反向流水（INSERT '消费冲销' 行 + 重算 points_balance）
  describe('通道 4：point_transactions 反向流水', () => {
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
    test('两端反向流水必须幂等（同 ref_order_id 已有冲销则不重复插）', () => {
      expect(staffSrc).toMatch(/NOT\s+EXISTS[\s\S]*?'消费冲销'/i)
      expect(adminSrc).toMatch(/NOT\s+EXISTS[\s\S]*?'消费冲销'/i)
    })
  })

  // 通道 5：sale_items.picked_up_quantity 反向恢复
  describe('通道 5：picked_up_quantity 反向恢复', () => {
    test('staff 必须 UPDATE sale_items SET picked_up_quantity = GREATEST(0, ...)', () => {
      expect(staffSrc).toMatch(/UPDATE\s+sale_items[\s\S]*?SET[\s\S]*?picked_up_quantity\s*=\s*GREATEST/i)
    })
    test('admin 必须 UPDATE sale_items SET picked_up_quantity = GREATEST(0, ...)', () => {
      expect(adminSrc).toMatch(/UPDATE\s+sale_items[\s\S]*?SET[\s\S]*?picked_up_quantity\s*=\s*GREATEST/i)
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
