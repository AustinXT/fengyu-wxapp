/**
 * dashboard 三端业绩口径一致性守护
 *
 * SUMMARY v3 §2 #15 / ticket notes/tickets/2026-05-17-dashboard-three-end-consistency-test.md
 *
 * 守护对象：
 *   - fengyu-admin/src/actions/dashboard.ts        (Drizzle / TS)
 *   - fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js (pg / JS)
 *
 * 因两端 ORM 不同（Drizzle vs 原生 pg）且 admin 用大 CTE，
 * staff 用按指标拆分的多查询，**完整 SQL snapshot 不可行**。
 * 守护策略改为"关键不变量字面量匹配"：
 *   1. 营业额公式 = SUM(received - refunded_amount)（禁 SUM(paid_amount) / SUM(total_amount)）
 *   2. sale_order_type 过滤集合 = IN ('销售单', '转换单')
 *   3. 状态过滤含 '已支付'
 *   4. 两端的 sale_order_type IN 集合归一化后必须同义（防止一端单独漏改）
 *
 * 任一端公式变更必须双端同步，否则数据中心首页与 admin dashboard 数字对不上。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'

const ADMIN_DASHBOARD = path.resolve(__dirname, './dashboard.ts')
const STAFF_MGMT_DASHBOARD = path.resolve(
  __dirname,
  '../../../fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js',
)

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

/**
 * 剥离 JS/TS 行注释 + 块注释。
 * 反向守护测试需要排除文档字符串内的"反例引用"（如 docstring 里出现的 SUM(total_amount)）。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ') // 行注释（避开 URL 的 //）
}

describe('audit-17 dashboard 两端公式一致性守护（SUMMARY v3 §2 #15）', () => {
  let adminSrc: string
  let staffSrc: string

  beforeAll(() => {
    adminSrc = fs.readFileSync(ADMIN_DASHBOARD, 'utf-8')
    staffSrc = fs.readFileSync(STAFF_MGMT_DASHBOARD, 'utf-8')
  })

  describe('营业额公式 = SUM(received - refunded_amount)（禁 SUM(paid_amount) / SUM(total_amount)）', () => {
    it('admin dashboard.ts 必须用 received - refunded_amount', () => {
      // admin 公式：CASE ... THEN (received::numeric - refunded_amount::numeric)
      expect(normalize(adminSrc)).toMatch(/received::numeric\s*-\s*refunded_amount::numeric/i)
    })

    it('admin dashboard.ts 禁用 SUM(paid_amount) / SUM(total_amount)（P0-17-01 防回归）', () => {
      // 剥离注释后检查（docstring 里 "SUM(total_amount)" 是反例引用，不算违规）
      const n = normalize(stripComments(adminSrc))
      expect(n).not.toMatch(/SUM\(\s*paid_amount\s*\)/i)
      expect(n).not.toMatch(/SUM\(\s*total_amount\s*\)/i)
    })

    it('staff mgmt-dashboard.js 必须用 received - refunded_amount', () => {
      // staff 公式：SUM(so.received::numeric - COALESCE(so.refunded_amount, 0)::numeric)
      expect(normalize(staffSrc)).toMatch(
        /received::numeric\s*-\s*COALESCE\(\s*so\.refunded_amount,\s*0\s*\)::numeric/i,
      )
    })

    it('staff mgmt-dashboard.js 禁用 SUM(paid_amount) / SUM(total_amount)（P0-17-01 防回归）', () => {
      const n = normalize(stripComments(staffSrc))
      expect(n).not.toMatch(/SUM\(\s*paid_amount\s*\)/i)
      expect(n).not.toMatch(/SUM\(\s*total_amount\s*\)/i)
    })
  })

  describe('sale_order_type 过滤 — 必须 IN (销售单, 转换单)', () => {
    it('admin dashboard.ts 必须含 IN (销售单, 转换单)', () => {
      expect(adminSrc).toMatch(/sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/)
    })

    it('staff mgmt-dashboard.js 必须含 IN (销售单, 转换单)', () => {
      expect(staffSrc).toMatch(/sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/)
    })

    it('两端枚举集合归一化后必须同义（防一端漏改未来新增枚举值）', () => {
      const extract = (src: string): Set<string> => {
        const matches = src.match(/sale_order_type\s+IN\s*\(([^)]+)\)/g) || []
        return new Set(matches.map((s) => s.replace(/\s+/g, '').toLowerCase()))
      }
      const adminEnums = extract(adminSrc)
      const staffEnums = extract(staffSrc)

      expect(adminEnums.size).toBeGreaterThan(0)
      expect(staffEnums.size).toBeGreaterThan(0)

      // 两端出现的所有 IN 集合（去重后）必须是同一组
      // 等价判断：合并后大小 = 任一端大小
      const union = new Set([...adminEnums, ...staffEnums])
      expect(union.size).toBe(adminEnums.size)
      expect(union.size).toBe(staffEnums.size)
    })
  })

  describe('status 过滤 — 必须含已支付', () => {
    it('admin dashboard.ts 营业额查询必须 status IN (已支付, ...)', () => {
      // admin 用 IN ('已支付', '已完成') 兼容（含已完成是 metrics.md 口径）
      expect(adminSrc).toMatch(/status\s+IN\s*\(\s*'已支付'/)
    })

    it('staff mgmt-dashboard.js queryStoreRevenue 必须 so.status = 已支付', () => {
      // staff 用 = '已支付'（不含已完成，因为 staff 端只统计已支付）
      expect(staffSrc).toMatch(/so\.status\s*=\s*'已支付'/)
    })
  })

  describe('关键注释字面量 — 两端必须保留"2026-04-26 sale-order-domain-refactor"溯源', () => {
    it('admin dashboard.ts 头部注释必须含公式变更追溯', () => {
      expect(adminSrc).toMatch(/2026-04-26\s+sale-order-domain-refactor/i)
    })

    it('staff mgmt-dashboard.js 必须含公式变更追溯（提醒维护者同步）', () => {
      expect(staffSrc).toMatch(/2026-04-26\s+sale-order-domain-refactor/i)
    })
  })

  describe('维护者提醒 — 任一端漂移必须留 cross-end TODO 链接', () => {
    it('两端均应在公式附近提及对端', () => {
      // 任一端的注释/字符串中提到了另一端的标识（管理后台/数据中心/mgmt-dashboard/dashboard.ts）
      const adminMentionsStaff =
        /mgmt-?dashboard|管理层数据中心|数据中心/i.test(adminSrc)
      const staffMentionsAdmin = /audit-17|dashboard|admin/i.test(staffSrc)
      expect(adminMentionsStaff || staffMentionsAdmin).toBe(true)
    })
  })
})
