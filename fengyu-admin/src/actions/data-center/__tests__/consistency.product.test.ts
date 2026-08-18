/**
 * 品项板块两端口径一致性守护（仿 dashboard.consistency.test.ts）
 *
 * 守护对象：
 *   - fengyu-admin/src/actions/data-center/product.ts                          (Drizzle / TS)
 *   - fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js               (pg / JS)
 *
 * 两端 ORM 不同 + admin 额外支持二级品项(category_name)下钻 + byMarket/byStore 明细 →
 * 完整 SQL snapshot 不可行。守护策略 = "关键不变量字面量匹配"：
 *   1. 持卡 = paid_sessions > 0，不按 product_type 过滤
 *   2. 持卡 sale_order_type IN ('销售单','转换单','寄存单')
 *   3. cycle CTE 链：daily_agg / qualifying_days / repurchase_qualifying_days /
 *      first_entry / period_agg / xinzeng / fugou / tiyan
 *   4. 进入/复购达标日分别使用 day_received / purchase_received，并共用 threshold
 *   5. cycle 进入基线纳入寄存单；复购达标与区间业绩只统计销售单/转换单
 *   6. 业绩 = SUM(sale_item_performance_events.amount)（禁 paid_amount）
 *   7. 一级分组键 product_kind（admin 额外 category_name 二级，为 admin 独有扩展）
 *
 * 任一端一级口径变更必须双端同步，否则数据中心品项板块与员工端 mgmtProduct 数字对不上。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'

const ADMIN_PRODUCT = path.resolve(__dirname, '../product.ts')
const STAFF_MGMT_PRODUCT = path.resolve(
  __dirname,
  '../../../../../fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js',
)

function normalize(src: string): string {
  return src.replace(/\s+/g, ' ').trim()
}

/** 剥离 JS/TS 注释（避免 docstring 里的反例引用干扰反向守护） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

describe('品项板块两端口径一致性守护', () => {
  let adminSrc: string
  let staffSrc: string
  let adminCode: string // 剥注释后
  let staffCode: string

  beforeAll(() => {
    adminSrc = fs.readFileSync(ADMIN_PRODUCT, 'utf-8')
    staffSrc = fs.readFileSync(STAFF_MGMT_PRODUCT, 'utf-8')
    adminCode = normalize(stripComments(adminSrc))
    staffCode = normalize(stripComments(staffSrc))
  })

  describe('持卡 = paid_sessions > 0，不按 product_type 过滤（DISTINCT client）', () => {
    it('两端含 paid_sessions > 0', () => {
      expect(adminCode).toMatch(/paid_sessions\s*>\s*0/)
      expect(staffCode).toMatch(/paid_sessions\s*>\s*0/)
    })
    it('两端持卡查询不再按 product_type = 疗程卡过滤', () => {
      expect(adminCode).not.toMatch(/product_type\s*=\s*'疗程卡'/)
      expect(staffCode).not.toMatch(/product_type\s*=\s*'疗程卡'/)
    })
    it('两端持卡查询不再按 remaining_sessions > 0 过滤', () => {
      expect(adminCode).not.toMatch(/remaining_sessions\s*>\s*0/)
      expect(staffCode).not.toMatch(/remaining_sessions\s*>\s*0/)
    })
    it('两端禁用已废弃的 单品 字面量（product_type enum 已 3→2 值）', () => {
      expect(adminCode).not.toMatch(/'单品'/)
      expect(staffCode).not.toMatch(/'单品'/)
    })
    it('两端持卡用 COUNT(DISTINCT so.client_user_id)', () => {
      expect(adminCode).toMatch(/COUNT\(DISTINCT\s+so\.client_user_id\)/)
      expect(staffCode).toMatch(/COUNT\(DISTINCT\s+so\.client_user_id\)/)
    })
  })

  describe('持卡 sale_order_type IN (销售单, 转换单, 寄存单)', () => {
    it('admin', () => {
      expect(adminSrc).toMatch(
        /sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*,\s*'寄存单'\s*\)/,
      )
    })
    it('staff', () => {
      expect(staffSrc).toMatch(
        /sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*,\s*'寄存单'\s*\)/,
      )
    })
  })

  describe('cycle CTE 链一致（进入基线与复购达标分流）', () => {
    const ctes = [
      'daily_agg',
      'qualifying_days',
      'repurchase_qualifying_days',
      'first_entry',
      'period_agg',
      'xinzeng',
      'fugou',
      'tiyan',
    ]
    it('admin 含全部 8 个 CTE', () => {
      for (const c of ctes) expect(adminCode).toContain(c)
    })
    it('staff 含全部 8 个 CTE', () => {
      for (const c of ctes) expect(staffCode).toContain(c)
    })
  })

  describe('达标日 = day_received >= threshold（getMemberThreshold）', () => {
    it('admin daily_agg 用支付事件金额 + day_received >= threshold', () => {
      expect(adminCode).toMatch(/SUM\(sipe\.amount::numeric\)\s+AS\s+day_received/i)
      expect(adminCode).toMatch(/day_received\s*>=\s*\$\{threshold\}/)
    })
    it('staff daily_agg 用支付事件金额 + day_received >= $3(threshold)', () => {
      expect(staffCode).toMatch(/SUM\(sipe\.amount::numeric\)\s+AS\s+day_received/i)
      expect(staffCode).toMatch(/day_received\s*>=\s*\$3/)
    })
    it('两端经 getMemberThreshold 注入阈值', () => {
      expect(adminCode).toMatch(/getMemberThreshold/)
      expect(staffCode).toMatch(/getMemberThreshold/)
    })
  })

  describe('first_entry = 全历史最早达标日（跨店合并 MIN）', () => {
    it('admin', () => {
      expect(adminCode).toMatch(/MIN\(purchase_date\)\s+AS\s+entry_date/i)
    })
    it('staff', () => {
      expect(staffCode).toMatch(/MIN\(purchase_date\)\s+AS\s+entry_date/i)
    })
    it('两端 daily_agg 全历史下界（performance_date <= 区间末）', () => {
      expect(adminCode).toMatch(/FROM\s+sale_item_performance_events\s+sipe/)
      expect(adminCode).toMatch(/sipe\.performance_date\s*<=\s*\$\{range\.end\}/)
      expect(staffCode).toMatch(/FROM\s+sale_item_performance_events\s+sipe/)
      expect(staffCode).toMatch(/sipe\.performance_date\s*<=\s*\$2/)
    })
  })

  describe('市场明细人数在市场内去重', () => {
    it('市场持卡直接按 market_id + 顾客聚合，不能由门店持卡相加', () => {
      expect(adminCode).toMatch(
        /queryCardHoldersByGroup[\s\S]*?sk\.market_id[\s\S]*?COUNT\(DISTINCT\s+so\.client_user_id\)[\s\S]*?GROUP BY\s+\$\{groupId\}/i,
      )
    })

    it('市场 first_entry 以 market_id 为分组键，跨市场仍分别归属', () => {
      expect(adminCode).toMatch(
        /entryGroupId\s*=\s*group\s*===\s*'market'\s*\?\s*sql\.raw\('sk\.market_id::text'\)/i,
      )
      expect(adminCode).toMatch(/first_entry\s+AS\s*\([\s\S]*?GROUP BY\s+client_user_id,\s*entry_group_id,\s*grp/i)
      expect(adminCode).toMatch(/new_group\s+AS\s*\([\s\S]*?COUNT\(DISTINCT\s+pa\.client_user_id\)/i)
      expect(adminCode).toMatch(/repurchase_group\s+AS\s*\([\s\S]*?COUNT\(DISTINCT\s+pa\.client_user_id\)/i)
    })
  })

  describe('cycle 进入基线纳入寄存单，复购事件仅限销售单/转换单', () => {
    it('admin', () => {
      expect(adminCode).toMatch(
        /daily_agg[\s\S]*?sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*,\s*'寄存单'\s*\)/,
      )
      expect(adminCode).toMatch(
        /FILTER\s*\(\s*WHERE\s+so\.sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)\s*\)[\s\S]*?AS\s+purchase_received/,
      )
      expect(adminCode).toMatch(
        /so\.status\s+NOT\s+IN\s*\(\s*'已关闭'\s*,\s*'已作废'\s*,\s*'未审核'\s*,\s*'待审批'\s*,\s*'支付失败'\s*\)/,
      )
    })
    it('staff', () => {
      expect(staffCode).toMatch(
        /daily_agg[\s\S]*?sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*,\s*'寄存单'\s*\)/,
      )
      expect(staffCode).toMatch(
        /FILTER\s*\(\s*WHERE\s+so\.sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)\s*\)[\s\S]*?AS\s+purchase_received/,
      )
      expect(staffCode).toMatch(
        /so\.status\s+NOT\s+IN\s*\(\s*'已关闭'\s*,\s*'已作废'\s*,\s*'未审核'\s*,\s*'待审批'\s*,\s*'支付失败'\s*\)/,
      )
    })
    it('两端 fugou 只读取 repurchase_qualifying_days，且区间业绩排除寄存金额', () => {
      for (const code of [adminCode, staffCode]) {
        expect(code).toMatch(/repurchase_qualifying_days\s+AS\s*\([\s\S]*?WHERE\s+purchase_received\s*>=/)
        expect(code).toMatch(
          /period_agg\s+AS\s*\([\s\S]*?purchase_received\s+AS\s+day_received[\s\S]*?purchase_received\s*>\s*0/,
        )
        expect(code).toMatch(/fugou\s+AS\s*\([\s\S]*?FROM\s+repurchase_qualifying_days\s+q/)
      }
    })
  })

  describe('复购 = 本期进入 cohort 在 entry_date 后区间内再次达标', () => {
    it('admin', () => {
      expect(adminCode).toMatch(/JOIN\s+xinzeng\s+x\s+ON\s+x\.client_user_id\s*=\s*q\.client_user_id\s+AND\s+x\.grp\s*=\s*q\.grp/)
      expect(adminCode).toMatch(/q\.purchase_date\s*>\s*x\.entry_date/)
    })
    it('staff', () => {
      expect(staffCode).toMatch(/JOIN\s+xinzeng\s+x\s+ON\s+x\.client_user_id\s*=\s*q\.client_user_id\s+AND\s+x\.product_kind\s*=\s*q\.product_kind/)
      expect(staffCode).toMatch(/q\.purchase_date\s*>\s*x\.entry_date/)
    })
  })

  describe('业绩 = SUM(支付事件 amount)（禁 paid_amount）', () => {
    it('两端禁用 paid_amount（已 DROP，防回归）', () => {
      expect(adminCode).not.toMatch(/paid_amount/)
      expect(staffCode).not.toMatch(/paid_amount/)
    })
  })

  describe('一级分组键 = product_kind（admin 额外支持 category_name 二级下钻）', () => {
    it('staff 按 product_kind 分组（GROUP BY ... pc.product_kind）', () => {
      expect(staffCode).toMatch(/pc\.product_kind/)
    })
    it('admin 含 product_kind（一级）与 category_name（二级扩展）', () => {
      expect(adminCode).toMatch(/pc\.product_kind/)
      expect(adminCode).toMatch(/pc\.category_name/)
    })
  })

  describe('占比分母 = 会员数（became_member_at，截面无 $date 守卫）', () => {
    it('admin 会员数用 became_member_at IS NOT NULL', () => {
      expect(adminCode).toMatch(/became_member_at\s+IS\s+NOT\s+NULL/)
    })
    it('staff 会员数用 became_member_at IS NOT NULL', () => {
      expect(staffCode).toMatch(/became_member_at\s+IS\s+NOT\s+NULL/)
    })
  })

  describe('JOIN 链 = sale_items → sale_orders → product_skus → product_categories', () => {
    it('admin 含 product_skus + product_categories JOIN', () => {
      expect(adminCode).toMatch(/JOIN\s+product_skus\s+sk\s+ON\s+sk\.sku_id\s*=\s*si\.sku_id/)
      expect(adminCode).toMatch(/JOIN\s+product_categories\s+pc\s+ON\s+pc\.category_id\s*=\s*sk\.category_id/)
    })
    it('staff 含 product_skus + product_categories JOIN', () => {
      expect(staffCode).toMatch(/JOIN\s+product_skus\s+sk\s+ON\s+sk\.sku_id\s*=\s*si\.sku_id/)
      expect(staffCode).toMatch(/JOIN\s+product_categories\s+pc\s+ON\s+pc\.category_id\s*=\s*sk\.category_id/)
    })
  })

  describe('维护者提醒 — 漂移时双端对照', () => {
    it('admin 注释提及移植源 mgmt-product', () => {
      expect(adminSrc).toMatch(/mgmt-product/i)
    })
  })
})
