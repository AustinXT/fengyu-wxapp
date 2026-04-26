/**
 * recalcCustomerType SQL 结构守卫测试
 *
 * 背景：migration 0028-0031 删除 sale_order_type='体验单' 后，旧 CASE SQL
 * 的 ② '小美客' 分支与 ③ '体验客' 分支字节级相同 → '体验客' 死分支。
 * 详见 notes/tickets/bug-recalc-customer-type-dead-branch.md
 *
 * Round 2 修复（audit-15 P0-15-02 预备）：
 * 小美客 / 体验客两分支从 product_categories JOIN 链 + is_card_kind 迁移到
 * sale_items.is_experience capability 列，去掉对 product_categories 的依赖。
 * staffApi order.js recalcCustomerType 与 payNotify/index.js CASE 段的
 * 小美客/体验客分支保持字符级一致（会员客分支合法差异：payNotify 保留回款单累计）。
 *
 * 本测试做**源文件文本结构守卫**：
 *   1. is_experience 守卫——两处 CASE SQL 必须同时存在 `si.is_experience = false`
 *      （小美客）和 `si.is_experience = true`（体验客），任一缺失即视为回退
 *   2. 无旧 JOIN 链——不再出现 product_skus / product_categories JOIN
 *   3. 小美客/体验客分支镜像——两文件的 ② ③ 分支规范化后逐字一致
 *   4. ELSE 兜底必须是 '流量客'
 */

const fs = require('node:fs')
const path = require('node:path')

const STAFF_ORDER_JS = path.resolve(
  __dirname,
  '../../routes/order.js'
)
const PAYNOTIFY_JS = path.resolve(
  __dirname,
  '../../../../../fengyu-client/cloudfunctions/payNotify/index.js'
)
const ADMIN_ORDERS_TS = path.resolve(
  __dirname,
  '../../../../../fengyu-admin/src/actions/orders.ts'
)

/**
 * 从源文件提取 `SELECT CASE ... END AS computed_type` 段
 * @param {string} filePath
 * @returns {string}
 */
function extractCaseSql(filePath) {
  const src = fs.readFileSync(filePath, 'utf8')
  const match = src.match(/SELECT CASE[\s\S]*?END AS computed_type/m)
  if (!match) {
    throw new Error(`未在 ${filePath} 找到 "SELECT CASE ... END AS computed_type" 段`)
  }
  return match[0]
}

/**
 * 规范化 SQL 文本：折叠连续空白为单空格 + 占位符归一化（$1/$2 与 ${var} 都→?）
 * 占位符归一化使三端镜像比对时 native pg ($1) 与 Drizzle sql template (${var}) 等价。
 */
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
 * 提取小美客和体验客两个 WHEN EXISTS 分支（不含会员客分支）
 * 用于跨文件镜像对比（会员客分支在两文件中合法差异）
 */
function extractNonMemberBranches(sql) {
  // 从 THEN '会员客' 之后开始，匹配小美客和体验客两个分支到 ELSE 之前
  const match = sql.match(/THEN '会员客'\s*(WHEN EXISTS[\s\S]*?THEN '小美客'\s*WHEN EXISTS[\s\S]*?THEN '体验客')/)
  return match ? match[1] : sql
}

describe('recalcCustomerType SQL 源文件守卫', () => {
  let staffSql
  let paynotifySql

  beforeAll(() => {
    staffSql = extractCaseSql(STAFF_ORDER_JS)
    paynotifySql = extractCaseSql(PAYNOTIFY_JS)
  })

  describe('staffApi routes/order.js', () => {
    test('小美客分支必须使用 si.is_experience = false', () => {
      expect(staffSql).toContain('si.is_experience = false')
    })

    test('体验客分支必须使用 si.is_experience = true', () => {
      expect(staffSql).toContain('si.is_experience = true')
    })

    test('ELSE 兜底必须是流量客', () => {
      expect(staffSql).toMatch(/ELSE '流量客'/)
    })

    test('不再依赖 product_categories JOIN 链（已迁移到 is_experience）', () => {
      expect(staffSql).not.toContain('JOIN product_skus')
      expect(staffSql).not.toContain('JOIN product_categories')
      expect(staffSql).not.toContain('is_card_kind')
    })

    test('JOIN sale_items 直接挂 is_experience 条件', () => {
      expect(staffSql).toContain('JOIN sale_items si ON si.sale_order_id = o.sale_order_id')
    })
  })

  describe('fengyu-client payNotify/index.js', () => {
    test('小美客分支必须使用 si.is_experience = false', () => {
      expect(paynotifySql).toContain('si.is_experience = false')
    })

    test('体验客分支必须使用 si.is_experience = true', () => {
      expect(paynotifySql).toContain('si.is_experience = true')
    })

    test('会员客分支必须包含回款单累计', () => {
      expect(paynotifySql).toContain('ref_sale_order_id')
      expect(paynotifySql).toContain("r.sale_order_type = '回款单'")
    })

    test('ELSE 兜底必须是流量客', () => {
      expect(paynotifySql).toMatch(/ELSE '流量客'/)
    })

    test('不再依赖 product_categories JOIN 链（已迁移到 is_experience）', () => {
      expect(paynotifySql).not.toContain('JOIN product_skus')
      expect(paynotifySql).not.toContain('JOIN product_categories')
      expect(paynotifySql).not.toContain('is_card_kind')
    })
  })

  describe('小美客/体验客分支镜像一致性', () => {
    test('两文件的小美客+体验客分支规范化后逐字相同', () => {
      const staffBranches = normalizeSql(extractNonMemberBranches(staffSql))
      const paynotifyBranches = normalizeSql(extractNonMemberBranches(paynotifySql))
      expect(paynotifyBranches).toBe(staffBranches)
    })

    test('不再出现 ② ③ 分支字节级相同的死分支模式', () => {
      // 旧 bug 模式：两个相邻 WHEN EXISTS 块完全一样，只查 sale_orders 不 JOIN
      const olderDeadPattern = /WHEN EXISTS \(\s*SELECT 1 FROM sale_orders\s*WHERE[^)]*sale_order_type = '销售单'\s*\)\s*THEN '小美客'/
      expect(staffSql).not.toMatch(olderDeadPattern)
      expect(paynotifySql).not.toMatch(olderDeadPattern)
    })
  })
})
