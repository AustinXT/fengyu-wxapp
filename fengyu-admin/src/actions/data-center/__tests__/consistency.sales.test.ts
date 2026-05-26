/**
 * 销售板块两端口径一致性守护（仿 dashboard.consistency.test.ts）
 *
 * 守护对象：
 *   - fengyu-admin/src/actions/data-center/sales.ts（Drizzle raw SQL / TS）
 *   - fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js（pg / JS）
 *
 * 因两端 ORM 不同（Drizzle sql`` vs 原生 pg）且查询拆分粒度不同，完整 SQL snapshot 不可行。
 * 守护策略 = "关键不变量字面量匹配"（stripComments 后，排除注释里的反例引用）：
 *   1. 营业额 = SUM(received - COALESCE(refunded_amount,0))
 *   2. sale_order_type IN ('销售单', '转换单')
 *   3. 生美 = is_shengmei = TRUE 的行级 SUM(received)
 *   4. 实耗 = unit_real_price * session_used ∩ status='已完成'
 *   5. 分客型：customer_type / became_member_at 分型字面量
 *   6. 员工数 skills && ARRAY['美容师','养生师'] + hired_at/resigned_at 历史化
 *   7. 门店数 opening_date / closed_at 历史化
 *
 * 任一端口径变更必须双端同步，否则数据中心 admin 与员工端 mgmtDashboard 数字对不上。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'

const ADMIN_SALES = path.resolve(__dirname, '../sales.ts')
const STAFF_MGMT_DASHBOARD = path.resolve(
  __dirname,
  '../../../../../fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js',
)

function normalize(src: string): string {
  return src.replace(/\s+/g, ' ').trim()
}

/** 剥离 JS/TS 行注释 + 块注释（避开 URL 的 //；排除 docstring 反例引用） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

describe('数据中心销售板块两端口径一致性守护', () => {
  let adminSrc: string
  let staffSrc: string
  let adminBody: string
  let staffBody: string

  beforeAll(() => {
    adminSrc = fs.readFileSync(ADMIN_SALES, 'utf-8')
    staffSrc = fs.readFileSync(STAFF_MGMT_DASHBOARD, 'utf-8')
    adminBody = normalize(stripComments(adminSrc))
    staffBody = normalize(stripComments(staffSrc))
  })

  describe('营业额公式 = SUM(received - COALESCE(refunded_amount, 0))', () => {
    it('admin sales.ts 必须用 received - COALESCE(refunded_amount, 0)', () => {
      expect(adminBody).toMatch(
        /received::numeric\s*-\s*COALESCE\(\s*so\.refunded_amount,\s*0\s*\)::numeric/i,
      )
    })

    it('staff mgmt-dashboard.js 必须用 received - COALESCE(refunded_amount, 0)', () => {
      expect(staffBody).toMatch(
        /received::numeric\s*-\s*COALESCE\(\s*so\.refunded_amount,\s*0\s*\)::numeric/i,
      )
    })

    it('admin sales.ts 禁用 SUM(paid_amount) / SUM(total_amount)（防回归）', () => {
      expect(adminBody).not.toMatch(/SUM\(\s*paid_amount\s*\)/i)
      expect(adminBody).not.toMatch(/SUM\(\s*so\.paid_amount\s*\)/i)
      expect(adminBody).not.toMatch(/SUM\(\s*total_amount\s*\)/i)
    })
  })

  describe('sale_order_type 过滤 — 必须 IN (销售单, 转换单)', () => {
    it('admin sales.ts 必须含 IN (销售单, 转换单)', () => {
      expect(adminSrc).toMatch(/sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/)
    })

    it('staff mgmt-dashboard.js 必须含 IN (销售单, 转换单)', () => {
      expect(staffSrc).toMatch(/sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/)
    })

    it('两端 sale_order_type IN 集合归一化后同义（防一端漏改未来新增枚举值）', () => {
      const extract = (src: string): Set<string> => {
        const matches = src.match(/sale_order_type\s+IN\s*\(([^)]+)\)/g) || []
        return new Set(matches.map((s) => s.replace(/\s+/g, '').toLowerCase()))
      }
      const a = extract(adminSrc)
      const s = extract(staffSrc)
      expect(a.size).toBeGreaterThan(0)
      expect(s.size).toBeGreaterThan(0)
      const union = new Set([...a, ...s])
      expect(union.size).toBe(a.size)
      expect(union.size).toBe(s.size)
    })
  })

  describe('status 过滤 — 业绩查询必须 status = 已支付', () => {
    it('admin sales.ts 含 so.status = 已支付', () => {
      expect(adminSrc).toMatch(/so\.status\s*=\s*'已支付'/)
    })
    it('staff mgmt-dashboard.js 含 so.status = 已支付', () => {
      expect(staffSrc).toMatch(/so\.status\s*=\s*'已支付'/)
    })
  })

  describe('生美 = 行级 is_shengmei = TRUE', () => {
    it('admin sales.ts 含 si.is_shengmei = TRUE 与 sit.is_shengmei = TRUE', () => {
      expect(adminSrc).toMatch(/si\.is_shengmei\s*=\s*TRUE/)
      expect(adminSrc).toMatch(/sit\.is_shengmei\s*=\s*TRUE/)
    })
    it('staff mgmt-dashboard.js 含 si.is_shengmei = TRUE 与 sit.is_shengmei = TRUE', () => {
      expect(staffSrc).toMatch(/si\.is_shengmei\s*=\s*TRUE/)
      expect(staffSrc).toMatch(/sit\.is_shengmei\s*=\s*TRUE/)
    })
  })

  describe('实耗 = unit_real_price * session_used ∩ status=已完成', () => {
    it('admin sales.ts 含 unit_real_price * session_used', () => {
      expect(adminBody).toMatch(/unit_real_price::numeric\s*\*\s*sit\.session_used/i)
      expect(adminSrc).toMatch(/so\.status\s*=\s*'已完成'/)
    })
    it('staff mgmt-dashboard.js 含 unit_real_price * session_used', () => {
      expect(staffBody).toMatch(/unit_real_price::numeric\s*\*\s*sit\.session_used/i)
      expect(staffSrc).toMatch(/so\.status\s*=\s*'已完成'/)
    })
  })

  describe('分客型业绩 — customer_type / became_member_at 分型', () => {
    it('admin sales.ts 新增会员 = 会员客 AND became_member_at::date >= 区间起', () => {
      expect(adminSrc).toMatch(/c\.customer_type\s*=\s*'会员客'/)
      expect(adminBody).toMatch(/c\.became_member_at::date\s*>=/i)
    })
    it('staff mgmt-dashboard.js 新增会员分型用 customer_type=会员客 + became_member_at', () => {
      expect(staffSrc).toMatch(/c\.customer_type\s*=\s*'会员客'/)
      expect(staffSrc).toMatch(/became_member_at/)
    })
    it('admin sales.ts 流量客业绩 = 仅 customer_type=流量客（2026-05-26 用户拍板）', () => {
      expect(adminSrc).toMatch(/customer_type\s*=\s*'流量客'/)
      // 不再含体验客/小美客
      expect(adminSrc).not.toMatch(/'流量客'\s*,\s*'体验客'\s*,\s*'小美客'/)
    })
  })

  describe('员工数 — skills && ARRAY[美容师,养生师] + hired_at/resigned_at 历史化', () => {
    it('admin sales.ts 含 skills && ARRAY[美容师,养生师]', () => {
      expect(adminSrc).toMatch(/skills\s*&&\s*ARRAY\[\s*'美容师'\s*,\s*'养生师'\s*\]/)
    })
    it('staff mgmt-dashboard.js 含 skills && ARRAY[美容师,养生师]', () => {
      expect(staffSrc).toMatch(/skills\s*&&\s*ARRAY\[\s*'美容师'\s*,\s*'养生师'\s*\]/)
    })
    it('admin sales.ts 员工数用 hired_at <= 区间末 + resigned_at 守卫', () => {
      expect(adminBody).toMatch(/hired_at::date\s*<=/i)
      expect(adminBody).toMatch(/resigned_at\s+IS\s+NULL\s+OR\s+s\.resigned_at::date\s*>/i)
    })
    it('staff mgmt-dashboard.js 员工数同口径（hired_at / resigned_at 历史化）', () => {
      expect(staffBody).toMatch(/hired_at::date\s*<=/i)
      expect(staffBody).toMatch(/resigned_at\s+IS\s+NULL\s+OR\s+s\.resigned_at::date\s*>/i)
    })
  })

  describe('门店数 — opening_date / closed_at 历史化', () => {
    it('admin sales.ts 门店数用 opening_date <= 区间末 + closed_at 守卫', () => {
      expect(adminBody).toMatch(/opening_date::date\s*<=/i)
      expect(adminBody).toMatch(/closed_at\s+IS\s+NULL\s+OR\s+s\.closed_at::date\s*>/i)
    })
    it('staff mgmt-dashboard.js 门店数同口径（opening_date / closed_at 历史化）', () => {
      expect(staffBody).toMatch(/opening_date::date\s*<=/i)
      expect(staffBody).toMatch(/closed_at\s+IS\s+NULL\s+OR\s+s\.closed_at::date\s*>/i)
    })
    it('两端 store 维度门店数短路返回 1', () => {
      // admin: if (scope.type === 'store') return 1
      expect(adminSrc).toMatch(/scope\.type\s*===\s*'store'\s*\)\s*return\s+1/)
      // staff: if (scopeType === 'store') return 1
      expect(staffSrc).toMatch(/scopeType\s*===\s*'store'\)\s*return\s+1/)
    })
  })

  describe('维护者提醒 — 两端互相提及防漂移', () => {
    it('admin sales.ts 注释提及 mgmt-dashboard / 员工端移植源', () => {
      expect(adminSrc).toMatch(/mgmt-?dashboard|员工端|staffApi/i)
    })
  })
})
