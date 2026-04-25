/**
 * recalcCustomerType SQL 结构守卫测试
 *
 * 背景：migration 0028-0031 删除 sale_order_type='体验单' 后，旧 CASE SQL
 * 的 ② '小美客' 分支与 ③ '体验客' 分支字节级相同 → '体验客' 死分支。
 * 详见 notes/tickets/bug-recalc-customer-type-dead-branch.md
 * 修复方案：notes/tickets/02-1-recalc-customer-type-fix.md §5
 *
 * 由于 recalcCustomerType 的 SQL 逻辑依赖真实 PG（JOIN sale_items → product_skus
 * → product_categories → product_kind），单元测试用 pg mock 无法验证 SQL 语义
 * 正确性。ticket §7.1 列出的 11 个数据场景（无销售单 → 流量客、仅体验卡 → 体验
 * 客、非体验卡 3000 → 会员客 等）本质是集成测试，应由 §7.2 开发库真实查询和
 * §7.3 手工回归覆盖。
 *
 * 本测试做**源文件文本结构守卫**（PR-C 收敛后）：
 *   1. 反死分支回归——两处 CASE SQL 必须同时存在 `pc_parent.is_card_kind = false`
 *      （小美客排除卡类）和 `pc_parent.is_card_kind = true AND pc_parent.category_name <> '充值卡'`
 *      （体验客 = 非储值的卡类），任一缺失即视为回归到死分支状态
 *   2. 镜像一致性——staffApi order.js 和 fengyu-client payNotify/index.js 的
 *      CASE 段规范化空白后必须逐字一致，防止未来单边修改漂移
 *   3. 结构完整性——会员客 ① 分支必须含 ref_sale_order_id 回款累计、ELSE 必须
 *      是 '流量客'
 *   4. 父级 JOIN 守卫——两个分支必须 JOIN 一级行 `pc_parent`（保证 is_card_kind 列可用）
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
 * 规范化 SQL 文本：折叠连续空白为单空格，便于跨文件缩进对比
 */
function normalizeSql(sql) {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .trim()
}

describe('recalcCustomerType SQL 源文件守卫', () => {
  let staffSql
  let paynotifySql

  beforeAll(() => {
    staffSql = extractCaseSql(STAFF_ORDER_JS)
    paynotifySql = extractCaseSql(PAYNOTIFY_JS)
  })

  describe('staffApi routes/order.js', () => {
    test('小美客分支必须排除卡类（反死分支，PR-C 收敛后用 is_card_kind=false）', () => {
      expect(staffSql).toContain('pc_parent.is_card_kind = false')
    })

    test('体验客分支必须断言非储值卡的卡类（PR-C 收敛后）', () => {
      expect(staffSql).toContain("pc_parent.is_card_kind = true AND pc_parent.category_name <> '充值卡'")
    })

    test('会员客分支必须包含回款单累计', () => {
      expect(staffSql).toContain('ref_sale_order_id')
      expect(staffSql).toContain("r.sale_order_type = '回款单'")
    })

    test('ELSE 兜底必须是流量客', () => {
      expect(staffSql).toMatch(/ELSE '流量客'/)
    })

    test('必须走 sale_items → product_skus → product_categories JOIN 链 + 一级行 JOIN', () => {
      expect(staffSql).toContain('JOIN sale_items si ON si.sale_order_id = o.sale_order_id')
      expect(staffSql).toContain('JOIN product_skus sk ON sk.sku_id = si.sku_id')
      expect(staffSql).toContain('JOIN product_categories pc ON pc.category_id = sk.category_id')
      expect(staffSql).toContain('JOIN product_categories pc_parent ON pc_parent.category_name = pc.product_kind AND pc_parent.product_kind IS NULL')
    })
  })

  describe('fengyu-client payNotify/index.js（镜像）', () => {
    test('小美客分支必须排除卡类（反死分支，PR-C 收敛后用 is_card_kind=false）', () => {
      expect(paynotifySql).toContain('pc_parent.is_card_kind = false')
    })

    test('体验客分支必须断言非储值卡的卡类（PR-C 收敛后）', () => {
      expect(paynotifySql).toContain("pc_parent.is_card_kind = true AND pc_parent.category_name <> '充值卡'")
    })

    test('会员客分支必须包含回款单累计', () => {
      expect(paynotifySql).toContain('ref_sale_order_id')
      expect(paynotifySql).toContain("r.sale_order_type = '回款单'")
    })

    test('ELSE 兜底必须是流量客', () => {
      expect(paynotifySql).toMatch(/ELSE '流量客'/)
    })
  })

  describe('两处 CASE SQL 镜像一致性', () => {
    test('规范化后逐字相同（防止未来单边修改漂移）', () => {
      expect(normalizeSql(paynotifySql)).toBe(normalizeSql(staffSql))
    })

    test('不再出现 ② ③ 分支字节级相同的死分支模式', () => {
      // 旧 bug 模式：两个相邻 WHEN EXISTS 块完全一样，只查 sale_orders 不 JOIN
      // 新 SQL 两个分支必然有 <> 和 = 的差异
      const olderDeadPattern = /WHEN EXISTS \(\s*SELECT 1 FROM sale_orders\s*WHERE[^)]*sale_order_type = '销售单'\s*\)\s*THEN '小美客'/
      expect(staffSql).not.toMatch(olderDeadPattern)
      expect(paynotifySql).not.toMatch(olderDeadPattern)
    })
  })
})
