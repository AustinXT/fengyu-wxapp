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
 * staffApi order.js recalcCustomerType 与 payNotify/index.js CASE 段保持字符级一致。
 * 2026-04-26 sale-order-domain-refactor 后，回款下沉到 sale_order_payments.change_type='回款'，
 * sale_order_type 枚举已不含“回款单”，运行时 SQL 禁止再引用该枚举字面量。
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
const CLIENT_API_ORDER_JS = path.resolve(
  __dirname,
  '../../../../../fengyu-client/cloudfunctions/clientApi/routes/order.js'
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
 * 用于跨文件镜像对比。
 */
function extractNonMemberBranches(sql) {
  // 从 THEN '会员客' 之后开始，匹配小美客和体验客两个分支到 ELSE 之前
  const match = sql.match(/THEN '会员客'\s*(WHEN EXISTS[\s\S]*?THEN '小美客'\s*WHEN EXISTS[\s\S]*?THEN '体验客')/)
  return match ? match[1] : sql
}

/**
 * 提取会员升级归因 UPDATE 段（首次跃迁为会员客时给触发单打 is_membership_upgrade 标记）
 * 用于跨端镜像对比：staff / payNotify / admin orders.ts / admin recompute-customer-tags / clientApi 五端逐字一致。
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

/**
 * 提取 became_member_at UPDATE 段（首笔达标单时间口径）。
 * 正则锚定 UPDATE client_wechat_users SET became_member_at，终止于其选单子查询的 LIMIT 1)。
 * 旧口径 `SET became_member_at = NOW()` 无 LIMIT 1) → 抛错，强制 5 端全部迁移完毕才通过。
 * 非贪婪匹配从 became_member_at 起找到最近的 LIMIT 1)（即其自身子查询闭合），不会越过到 is_membership_upgrade 段。
 * @param {string} filePath
 * @returns {string}
 */
function extractBecameMemberAtUpdate(filePath) {
  const src = fs.readFileSync(filePath, 'utf8')
  const match = src.match(/UPDATE client_wechat_users SET became_member_at[\s\S]*?LIMIT 1\s*\)/)
  if (!match) {
    throw new Error(`未在 ${filePath} 找到 became_member_at UPDATE（含 LIMIT 1 子查询）；可能仍为旧 NOW() 口径`)
  }
  return match[0]
}

describe('recalcCustomerType SQL 源文件守卫', () => {
  let staffSql
  let paynotifySql
  let adminSql
  let adminSrc
  let adminRecomputeSql
  let clientApiSql

  beforeAll(() => {
    staffSql = extractCaseSql(STAFF_ORDER_JS)
    paynotifySql = extractCaseSql(PAYNOTIFY_JS)
    adminSql = extractCaseSql(ADMIN_ORDERS_TS)
    adminSrc = fs.readFileSync(ADMIN_ORDERS_TS, 'utf8')
    adminRecomputeSql = extractCaseSql(ADMIN_RECOMPUTE_TS)
    clientApiSql = extractCaseSql(CLIENT_API_ORDER_JS)
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

    test('会员客分支不含已删除的回款单枚举字面量', () => {
      expect(paynotifySql).not.toContain('ref_sale_order_id')
      expect(paynotifySql).not.toContain("'回款单'")
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

  describe('fengyu-client clientApi/routes/order.js', () => {
    test('小美客分支必须使用 si.is_experience = false', () => {
      expect(clientApiSql).toContain('si.is_experience = false')
    })

    test('体验客分支必须使用 si.is_experience = true', () => {
      expect(clientApiSql).toContain('si.is_experience = true')
    })

    test('ELSE 兜底必须是流量客', () => {
      expect(clientApiSql).toMatch(/ELSE '流量客'/)
    })

    test('不含回款单累计死代码分支（clientApi 用单笔口径，与 staff/admin 同）', () => {
      expect(clientApiSql).not.toContain('ref_sale_order_id')
      expect(clientApiSql).not.toContain("'回款单'")
    })

    test('不再依赖 product_categories JOIN 链（已迁移到 is_experience）', () => {
      expect(clientApiSql).not.toContain('JOIN product_skus')
      expect(clientApiSql).not.toContain('JOIN product_categories')
      expect(clientApiSql).not.toContain('is_card_kind')
    })

    test('JOIN sale_items 直接挂 is_experience 条件', () => {
      expect(clientApiSql).toContain('JOIN sale_items si ON si.sale_order_id = o.sale_order_id')
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

    test('clientApi vs staff 规范化后逐字相同（clientApi 支付完成链路第 5 端副本，单笔口径）', () => {
      const staffBranches = normalizeSql(extractNonMemberBranches(staffSql))
      const clientApiBranches = normalizeSql(extractNonMemberBranches(clientApiSql))
      expect(clientApiBranches).toBe(staffBranches)
    })

    test('不再出现 ② ③ 分支字节级相同的死分支模式', () => {
      // 旧 bug 模式：两个相邻 WHEN EXISTS 块完全一样，只查 sale_orders 不 JOIN
      const olderDeadPattern = /WHEN EXISTS \(\s*SELECT 1 FROM sale_orders\s*WHERE[^)]*sale_order_type = '销售单'\s*\)\s*THEN '小美客'/
      expect(staffSql).not.toMatch(olderDeadPattern)
      expect(paynotifySql).not.toMatch(olderDeadPattern)
      expect(adminSql).not.toMatch(olderDeadPattern)
      expect(adminRecomputeSql).not.toMatch(olderDeadPattern)
      expect(clientApiSql).not.toMatch(olderDeadPattern)
    })
  })

  describe('会员升级归因 UPDATE（is_membership_upgrade）镜像一致性', () => {
    let staffAttr
    let paynotifyAttr
    let adminAttr
    let adminRecomputeAttr
    let clientApiAttr

    beforeAll(() => {
      staffAttr = extractMembershipUpgradeAttribution(STAFF_ORDER_JS)
      paynotifyAttr = extractMembershipUpgradeAttribution(PAYNOTIFY_JS)
      adminAttr = extractMembershipUpgradeAttribution(ADMIN_ORDERS_TS)
      adminRecomputeAttr = extractMembershipUpgradeAttribution(ADMIN_RECOMPUTE_TS)
      clientApiAttr = extractMembershipUpgradeAttribution(CLIENT_API_ORDER_JS)
    })

    test('五端归因段目标列一致：UPDATE sale_orders SET is_membership_upgrade = true', () => {
      const re = /^UPDATE sale_orders SET is_membership_upgrade = true/
      expect(staffAttr).toMatch(re)
      expect(paynotifyAttr).toMatch(re)
      expect(adminAttr).toMatch(re)
      expect(adminRecomputeAttr).toMatch(re)
      expect(clientApiAttr).toMatch(re)
    })

    test('五端规范化后逐字相同（占位符归一化后 $1 与 ${clientUserId} 等价）', () => {
      const staffN = normalizeSql(staffAttr)
      expect(normalizeSql(paynotifyAttr)).toBe(staffN)
      expect(normalizeSql(adminAttr)).toBe(staffN)
      expect(normalizeSql(adminRecomputeAttr)).toBe(staffN)
      expect(normalizeSql(clientApiAttr)).toBe(staffN)
    })

    test('payNotify 归因条件仍含有效的单笔 total_amount >= 阈值分支', () => {
      expect(normalizeSql(paynotifyAttr)).toContain('o.total_amount >= ?')
    })

    test('五端无回款单累计分支（仅看单笔 total）', () => {
      // 2026-04-26 sale-order-domain-refactor 后，回款记录下沉到
      // sale_order_payments.change_type='回款'，sale_orders 不再产生旧“回款单”类型行。
      for (const s of [staffAttr, paynotifyAttr, adminAttr, adminRecomputeAttr, clientApiAttr]) {
        expect(s).not.toContain('ref_sale_order_id')
        expect(s).not.toContain("'回款单'")
      }
    })

    test('五端归因段都按 paid_at ASC NULLS LAST 取首笔达标单', () => {
      const re = /ORDER BY o\.paid_at ASC NULLS LAST/
      expect(staffAttr).toMatch(re)
      expect(paynotifyAttr).toMatch(re)
      expect(adminAttr).toMatch(re)
      expect(adminRecomputeAttr).toMatch(re)
      expect(clientApiAttr).toMatch(re)
    })
  })

  describe('became_member_at 口径 UPDATE（首笔达标单时间）镜像一致性', () => {
    let staffBma
    let paynotifyBma
    let adminBma
    let adminRecomputeBma
    let clientApiBma

    beforeAll(() => {
      staffBma = extractBecameMemberAtUpdate(STAFF_ORDER_JS)
      paynotifyBma = extractBecameMemberAtUpdate(PAYNOTIFY_JS)
      adminBma = extractBecameMemberAtUpdate(ADMIN_ORDERS_TS)
      adminRecomputeBma = extractBecameMemberAtUpdate(ADMIN_RECOMPUTE_TS)
      clientApiBma = extractBecameMemberAtUpdate(CLIENT_API_ORDER_JS)
    })

    test('五端目标列一致：UPDATE client_wechat_users SET became_member_at = (SELECT COALESCE(o.paid_at, o.created_at) …', () => {
      const re = /^UPDATE client_wechat_users SET became_member_at = \(\s*SELECT COALESCE\(o\.paid_at, o\.created_at\)/
      expect(staffBma).toMatch(re)
      expect(paynotifyBma).toMatch(re)
      expect(adminBma).toMatch(re)
      expect(adminRecomputeBma).toMatch(re)
      expect(clientApiBma).toMatch(re)
    })

    test('五端规范化后逐字相同（占位符归一化后 $1 与 ${clientUserId} 等价）', () => {
      const staffN = normalizeSql(staffBma)
      expect(normalizeSql(paynotifyBma)).toBe(staffN)
      expect(normalizeSql(adminBma)).toBe(staffN)
      expect(normalizeSql(adminRecomputeBma)).toBe(staffN)
      expect(normalizeSql(clientApiBma)).toBe(staffN)
    })

    test('五端 became_member_at 段不含 NOW()（旧跃迁时刻口径已下线）', () => {
      expect(staffBma).not.toMatch(/NOW\(\)/)
      expect(paynotifyBma).not.toMatch(/NOW\(\)/)
      expect(adminBma).not.toMatch(/NOW\(\)/)
      expect(adminRecomputeBma).not.toMatch(/NOW\(\)/)
      expect(clientApiBma).not.toMatch(/NOW\(\)/)
    })

    test('五端无回款单累计分支（单笔 total 口径，与五端 is_membership_upgrade 归因段同源）', () => {
      for (const s of [staffBma, paynotifyBma, adminBma, adminRecomputeBma, clientApiBma]) {
        expect(s).not.toContain('ref_sale_order_id')
        expect(s).not.toContain("'回款单'")
      }
    })

    test('payNotify became_member_at 段使用单笔 total_amount 达标口径', () => {
      expect(normalizeSql(paynotifyBma)).toContain('o.total_amount >= ?')
    })

    test('五端都按 paid_at ASC NULLS LAST, created_at ASC 取首笔达标单（与各端 is_membership_upgrade 同序 ⇒ 选同一单）', () => {
      const re = /ORDER BY o\.paid_at ASC NULLS LAST, o\.created_at ASC/
      expect(staffBma).toMatch(re)
      expect(paynotifyBma).toMatch(re)
      expect(adminBma).toMatch(re)
      expect(adminRecomputeBma).toMatch(re)
      expect(clientApiBma).toMatch(re)
    })

    test('回归守护：五端源码不再出现旧的 SET became_member_at = NOW() 形态', () => {
      const re = /SET became_member_at\s*=\s*NOW\(\)/
      expect(fs.readFileSync(STAFF_ORDER_JS, 'utf8')).not.toMatch(re)
      expect(fs.readFileSync(PAYNOTIFY_JS, 'utf8')).not.toMatch(re)
      expect(fs.readFileSync(ADMIN_ORDERS_TS, 'utf8')).not.toMatch(re)
      expect(fs.readFileSync(ADMIN_RECOMPUTE_TS, 'utf8')).not.toMatch(re)
      expect(fs.readFileSync(CLIENT_API_ORDER_JS, 'utf8')).not.toMatch(re)
    })
  })
})
