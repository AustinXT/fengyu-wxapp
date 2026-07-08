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
const ADMIN_RECOMPUTE_TS = path.resolve(
  __dirname,
  '../../../../../fengyu-admin/src/lib/recompute-customer-tags.ts'
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

/**
 * 提取会员升级归因 UPDATE 段（首次跃迁为会员客时给触发单打 is_membership_upgrade 标记）
 * 用于跨端镜像对比：staff / admin orders.ts / admin recompute-customer-tags 三端逐字一致；
 * payNotify 因会员客判定含回款单累计而条件为超集（合法差异，单独验证）。
 * @param {string} filePath
 * @returns {string}
 */
function extractMembershipUpgradeAttribution(filePath) {
  const src = fs.readFileSync(filePath, 'utf8')
  const match = src.match(/UPDATE sale_orders SET is_membership_upgrade[\s\S]*?LIMIT 1\s*\)/)
  if (!match) {
    throw new Error(`未在 ${filePath} 找到会员升级归因 UPDATE 段（is_membership_upgrade）`)
  }
  return match[0]
}

describe('recalcCustomerType SQL 源文件守卫', () => {
  let staffSql
  let paynotifySql
  let adminSql
  let adminSrc
  let adminRecomputeSql

  beforeAll(() => {
    staffSql = extractCaseSql(STAFF_ORDER_JS)
    paynotifySql = extractCaseSql(PAYNOTIFY_JS)
    adminSql = extractCaseSql(ADMIN_ORDERS_TS)
    adminSrc = fs.readFileSync(ADMIN_ORDERS_TS, 'utf8')
    adminRecomputeSql = extractCaseSql(ADMIN_RECOMPUTE_TS)
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

  describe('fengyu-admin actions/orders.ts (recordPayment 触发点)', () => {
    test('小美客分支必须使用 si.is_experience = false', () => {
      expect(adminSql).toContain('si.is_experience = false')
    })

    test('体验客分支必须使用 si.is_experience = true', () => {
      expect(adminSql).toContain('si.is_experience = true')
    })

    test('ELSE 兜底必须是流量客', () => {
      expect(adminSql).toMatch(/ELSE '流量客'/)
    })

    test('不再依赖 product_categories JOIN 链（已迁移到 is_experience）', () => {
      expect(adminSql).not.toContain('JOIN product_skus')
      expect(adminSql).not.toContain('JOIN product_categories')
      expect(adminSql).not.toContain('is_card_kind')
    })

    test('JOIN sale_items 直接挂 is_experience 条件', () => {
      expect(adminSql).toContain('JOIN sale_items si ON si.sale_order_id = o.sale_order_id')
    })

    test('recordPayment 事务结清时必须调用 recalcCustomerType（防 audit-15 P0-15-01 admin 触发点跃迁缺失复发）', () => {
      // 守卫文本特征：targetStatus === '已支付' 分支内出现 recalcCustomerType(tx, ...)
      const pattern = /targetStatus\s*===\s*'已支付'[\s\S]{0,200}recalcCustomerType\s*\(\s*tx\s*,/
      expect(adminSrc).toMatch(pattern)
    })
  })

  describe('三端小美客/体验客分支镜像一致性', () => {
    test('staff vs payNotify 规范化后逐字相同', () => {
      const staffBranches = normalizeSql(extractNonMemberBranches(staffSql))
      const paynotifyBranches = normalizeSql(extractNonMemberBranches(paynotifySql))
      expect(paynotifyBranches).toBe(staffBranches)
    })

    test('staff vs admin 规范化后逐字相同（占位符归一化后 $1 与 ${clientUserId} 等价）', () => {
      const staffBranches = normalizeSql(extractNonMemberBranches(staffSql))
      const adminBranches = normalizeSql(extractNonMemberBranches(adminSql))
      expect(adminBranches).toBe(staffBranches)
    })

    test('admin recompute-customer-tags.ts vs staff（legacy 订单审核通过触发的第 4 端副本）', () => {
      const staffBranches = normalizeSql(extractNonMemberBranches(staffSql))
      const recomputeBranches = normalizeSql(extractNonMemberBranches(adminRecomputeSql))
      expect(recomputeBranches).toBe(staffBranches)
    })

    test('不再出现 ② ③ 分支字节级相同的死分支模式', () => {
      // 旧 bug 模式：两个相邻 WHEN EXISTS 块完全一样，只查 sale_orders 不 JOIN
      const olderDeadPattern = /WHEN EXISTS \(\s*SELECT 1 FROM sale_orders\s*WHERE[^)]*sale_order_type = '销售单'\s*\)\s*THEN '小美客'/
      expect(staffSql).not.toMatch(olderDeadPattern)
      expect(paynotifySql).not.toMatch(olderDeadPattern)
      expect(adminSql).not.toMatch(olderDeadPattern)
      expect(adminRecomputeSql).not.toMatch(olderDeadPattern)
    })
  })

  describe('会员升级归因 UPDATE（is_membership_upgrade）镜像一致性', () => {
    let staffAttr
    let paynotifyAttr
    let adminAttr
    let adminRecomputeAttr

    beforeAll(() => {
      staffAttr = extractMembershipUpgradeAttribution(STAFF_ORDER_JS)
      paynotifyAttr = extractMembershipUpgradeAttribution(PAYNOTIFY_JS)
      adminAttr = extractMembershipUpgradeAttribution(ADMIN_ORDERS_TS)
      adminRecomputeAttr = extractMembershipUpgradeAttribution(ADMIN_RECOMPUTE_TS)
    })

    test('四端归因段目标列一致：UPDATE sale_orders SET is_membership_upgrade = true', () => {
      const re = /^UPDATE sale_orders SET is_membership_upgrade = true/
      expect(staffAttr).toMatch(re)
      expect(paynotifyAttr).toMatch(re)
      expect(adminAttr).toMatch(re)
      expect(adminRecomputeAttr).toMatch(re)
    })

    test('staff / admin orders.ts / admin recompute 三端规范化后逐字相同（占位符归一化后 $1 与 ${clientUserId} 等价）', () => {
      const staffN = normalizeSql(staffAttr)
      expect(normalizeSql(adminAttr)).toBe(staffN)
      expect(normalizeSql(adminRecomputeAttr)).toBe(staffN)
    })

    test('payNotify 归因段含回款单累计变体（与本端会员客 CASE 分支同源，合法差异）', () => {
      expect(paynotifyAttr).toContain('ref_sale_order_id')
      expect(paynotifyAttr).toContain("r.sale_order_type = '回款单'")
    })

    test('payNotify 归因条件是 staff 的超集：必须含纯 total_amount >= 阈值 分支', () => {
      expect(normalizeSql(paynotifyAttr)).toContain('o.total_amount >= ?')
    })

    test('staff / admin orders.ts / admin recompute 三端无回款单累计分支（仅看单笔 total）', () => {
      // 三端的会员客 CASE 本身就不含回款累计（staff 注释明确「保留 total_amount 直接判定」），
      // 故归因段也无回款累计。两侧条件不同源，跨端标签值会存在差异：
      //   - 场景 A：顾客 A 一笔销售单 total=15000（< 阈值 20000），后续回款 8000 累计达标
      //     → payNotify 打标，staff/admin 不打标（合法差异，非 bug）
      //   - 场景 B：单笔 total ≥ 阈值 → 四端都打标
      expect(staffAttr).not.toContain('ref_sale_order_id')
      expect(staffAttr).not.toContain("'回款单'")
      expect(adminAttr).not.toContain('ref_sale_order_id')
      expect(adminAttr).not.toContain("'回款单'")
      expect(adminRecomputeAttr).not.toContain('ref_sale_order_id')
      expect(adminRecomputeAttr).not.toContain("'回款单'")
    })

    test('payNotify 归因段确实使用 OR 拼接：单笔达标 OR 单笔+回款累计达标', () => {
      // 字面量断言：归因条件形如 `(o.total_amount >= $2 OR (o.total_amount + COALESCE(...)) >= $2)`
      // 防回款单累计分支被改成「AND 拼接」或被「去掉外层括号」导致语义变化。
      // 允许跨行空白（SQL 模板字符串里 $2 周围有换行/缩进）；$ 字面量匹配。
      const orBranch = /o\.total_amount\s*>=\s*\$2\s*OR\s*\(\s*o\.total_amount\s*\+\s*COALESCE/s
      expect(paynotifyAttr).toMatch(orBranch)
    })

    test('四端归因段都按 paid_at ASC NULLS LAST 取首笔达标单', () => {
      const re = /ORDER BY o\.paid_at ASC NULLS LAST/
      expect(staffAttr).toMatch(re)
      expect(paynotifyAttr).toMatch(re)
      expect(adminAttr).toMatch(re)
      expect(adminRecomputeAttr).toMatch(re)
    })
  })
})
