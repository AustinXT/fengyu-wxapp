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

  /**
   * #286：明细「新增人数」的归店必须以 `xinzeng` 为主表 LEFT JOIN `period_agg`。
   *
   * 缺陷原理：`period_agg` 要求 `purchase_received > 0`（只统计销售单/转换单，**不含寄存单**），
   * 而进入达标（`first_entry` → `xinzeng`）走 `day_received`（**含寄存单**）。
   * 以 `period_agg` 作主表再内连接回来，会把「进入达标日金额全部来自寄存单」的顾客整体丢弃 ——
   * 生产实测今年 KPI 2470 人而明细合计只有 852 人（**漏 65.5%**），
   * 派生的新增客单价与复购率因此双双虚高 **2.90 倍**。
   *
   * ⚠️ 这些断言只对**明细侧**（`queryCycleByStore`）的 SQL 模板生效：KPI 侧 `queryCycle`
   * 有一份同名 CTE 链，对整份源码 `toMatch` 时它的字面量会把明细侧的漏改顶掉
   * （与 `consistency.customer.test.ts` 记载的「单处漏改全绿」同型）。
   *
   * ⚠️ 本文件的 `adminCode` 只剥 JS 注释、**不剥 SQL 注释**，所以正向断言理论上可被
   * 「删真实代码 + 用 `--` 把字面量补回去」绕过。**反向断言（`not.toMatch`）是这里的主力**：
   * 注释注入只会让它误红（fail-closed），永远不会让它假绿。
   */
  describe('明细新增人数以 xinzeng 为主表归店（#286）', () => {
    /** 切出 queryCycleByStore 的 SQL 模板，避免 KPI 侧同名 CTE 链顶替 */
    const detailSql = (src: string): string => {
      const fn = /async function queryCycleByStore\([\s\S]*?\n}/.exec(src)?.[0] ?? ''
      return normalize(/db\.execute\(sql`([\s\S]*?)`\)/.exec(fn)?.[1] ?? '')
    }
    let adminDetail: string
    beforeAll(() => {
      adminDetail = detailSql(adminSrc)
    })

    it('切片锚点有效（能切出明细侧 SQL 且含三个关键 CTE）', () => {
      expect(adminDetail, 'queryCycleByStore 的 SQL 模板未切出').toBeTruthy()
      for (const cte of ['xinzeng', 'new_store', 'store_ids', 'period_agg']) {
        expect(adminDetail, `明细侧缺 ${cte} CTE`).toMatch(new RegExp(`${cte}\\s+AS\\s*\\(`))
      }
    })

    it('new_store 以 xinzeng 为主表 LEFT JOIN period_agg', () => {
      expect(adminDetail).toMatch(
        /new_store\s+AS\s*\([\s\S]*?FROM\s+xinzeng\s+x\s+LEFT\s+JOIN\s+period_agg\s+pa/,
      )
      // ★ 主力断言：回退成「period_agg 作主表内连接 xinzeng」会丢掉
      //   「进入达标日金额全部来自寄存单」的顾客（实测漏 65.5%）
      expect(
        adminDetail,
        '明细新增回退成了内连接归店 —— 进入达标日只有寄存单的顾客会被整体丢弃（#286）',
      ).not.toMatch(/FROM\s+period_agg\s+pa\s+JOIN\s+xinzeng/)
    })

    it('xinzeng 带 entry_store_id（期内无销售单消费时的归店兜底）', () => {
      expect(adminDetail, 'xinzeng 缺 entry_store_id 列').toMatch(
        /xinzeng\s+AS\s*\([\s\S]*?AS\s+entry_store_id/,
      )
      // 兜底门店必须取自进入达标日当天，且同日多店时确定性地取 MIN
      expect(adminDetail, 'entry_store_id 未按「进入达标日当天」解析').toMatch(
        /MIN\(qd\.store_id\)[\s\S]*?FROM\s+qualifying_days\s+qd[\s\S]*?qd\.purchase_date\s*=\s*fe\.entry_date/,
      )
    })

    it('new_store 归店列 = COALESCE(消费门店, entry 门店)', () => {
      expect(adminDetail).toMatch(
        /COALESCE\(pa\.store_id,\s*x\.entry_store_id\)\s+AS\s+store_id/,
      )
      expect(adminDetail, 'GROUP BY 未与投影的归店表达式一致').toMatch(
        /GROUP\s+BY\s+COALESCE\(pa\.store_id,\s*x\.entry_store_id\)/,
      )
    })

    it('store_ids 骨架并上 entry 门店（否则只有寄存单进入的门店会漏行）', () => {
      expect(adminDetail).toMatch(
        /store_ids\s+AS\s*\([\s\S]*?FROM\s+period_agg\s+UNION\s+SELECT\s+DISTINCT\s+entry_store_id\s+FROM\s+xinzeng/,
      )
    })

    /**
     * 体验/复购不需要兜底：`tiyan` 本就从 `period_agg` 派生，
     * `fugou` 要求 `purchase_received >= threshold > 0`，两者必然在 `period_agg` 里有行。
     * 锁住这一点，免得日后有人"顺手"把它们也改成 LEFT JOIN 兜底，反而引入无处归店的行。
     */
    it('体验/复购仍以 period_agg 为主表（它们必然有 period 行，无需兜底）', () => {
      expect(adminDetail).toMatch(/trial_store\s+AS\s*\([\s\S]*?FROM\s+period_agg\s+pa\s+JOIN\s+tiyan\s+t/)
      expect(adminDetail).toMatch(/repurchase_store\s+AS\s*\([\s\S]*?FROM\s+period_agg\s+pa\s+JOIN\s+fugou\s+fg/)
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
