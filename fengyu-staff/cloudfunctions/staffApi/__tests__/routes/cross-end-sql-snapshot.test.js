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
    const fnMatch = adminSrc.match(/export async function confirmOfflinePayment[\s\S]*?(?=\nexport |\n\/\*\* )/)
    expect(fnMatch).not.toBeNull()
    const fnBody = fnMatch[0]
    expect(fnBody).toMatch(/settlePointsSafe\s*\(\s*tx\s*,\s*saleOrderId\s*,\s*['"]admin\.confirmOffline['"]/)
  })

  test('recordPayment 内必须调用 settlePointsSafe(tx, saleOrderId, "admin.recordPayment")', () => {
    const fnMatch = adminSrc.match(/export async function recordPayment[\s\S]*?(?=\nexport |\n\/\*\* )/)
    expect(fnMatch).not.toBeNull()
    const fnBody = fnMatch[0]
    expect(fnBody).toMatch(/settlePointsSafe\s*\(\s*tx\s*,\s*saleOrderId\s*,\s*['"]admin\.recordPayment['"]/)
  })

  test('confirmOfflinePayment 结清时必须调用 recalcCustomerType（与 recordPayment 对齐）', () => {
    const fnMatch = adminSrc.match(/export async function confirmOfflinePayment[\s\S]*?(?=\nexport |\n\/\*\* )/)
    const fnBody = fnMatch[0]
    expect(fnBody).toMatch(/recalcCustomerType\s*\(\s*tx\s*,/)
  })
})
