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
    /**
     * 切出 queryCycleByStore 的 SQL 模板，避免 KPI 侧同名 CTE 链顶替。
     *
     * 同时剥掉 SQL 行注释 —— 这样正向断言不能被「删真实代码 + 用 `--` 把字面量补回去」满足，
     * 反向断言也不会被源码注释里出现的 SQL 片段误伤（否则那就成了一条零守护的措辞约定）。
     *
     * ⚠️ 用正则剥 `--` 在一般情况下不可靠（`--` 出现在字符串字面量里会误删后续条件，
     * `consistency.customer.test.ts` 为此专门写了词法状态机）。本模板里的字符串字面量
     * 只有 `'销售单'`/`'转换单'`/`'寄存单'`/`'已关闭'` 这类中文枚举值，**零 `--`**，
     * 所以这里是安全的；即便日后误删，后果也是正向断言误红（fail-closed），不会假绿。
     */
    const detailSql = (src: string): string => {
      const fn = /async function queryCycleByStore\([\s\S]*?\n}/.exec(src)?.[0] ?? ''
      const tpl = /db\.execute\(sql`([\s\S]*?)`\)/.exec(fn)?.[1] ?? ''
      return normalize(tpl.replace(/--[^\n]*/g, ' '))
    }
    /**
     * 切出单个 CTE 块（以下一个 CTE 名为右边界），避免跨块的惰性匹配假红/假绿。
     * 两侧都容忍 `AS MATERIALIZED (` 这种带物化提示的写法。
     */
    const cteBlock = (sqlText: string, name: string, nextName: string): string =>
      new RegExp(
        `${name}\\s+AS\\s+(?:MATERIALIZED\\s+)?\\(([\\s\\S]*?)\\),\\s*${nextName}\\s+AS\\s`,
      ).exec(sqlText)?.[1] ?? ''

    let adminDetail: string
    beforeAll(() => {
      adminDetail = detailSql(adminSrc)
    })

    it('切片锚点有效（能切出明细侧 SQL 且含关键 CTE）', () => {
      expect(adminDetail, 'queryCycleByStore 的 SQL 模板未切出').toBeTruthy()
      for (const cte of ['xinzeng', 'new_store', 'store_ids', 'period_agg']) {
        expect(adminDetail, `明细侧缺 ${cte} CTE`).toMatch(new RegExp(`${cte}\\s+AS\\s*\\(`))
      }
      // 明细侧只应有一条 db.execute；日后拆成多查时切片会静默只盯前半段，这里先钉死
      const fn = /async function queryCycleByStore\([\s\S]*?\n}/.exec(adminSrc)?.[0] ?? ''
      expect(
        (fn.match(/db\.execute\(/g) ?? []).length,
        '明细侧出现多个 db.execute —— detailSql 的切片口径需同步更新',
      ).toBe(1)
    })

    /**
     * ★ 计数主体必须是 `x.client_user_id`（xinzeng 的顾客），不能是 `pa.client_user_id`。
     *
     * 这是 sibling-auditor 在 round-1 抓到的守护缺口：把计数主体改回 `pa.client_user_id`，
     * **65.5% 的漏损会原样复现**（兜底分组里 `pa.*` 全是 NULL，`COUNT(DISTINCT pa.client_user_id) = 0`），
     * 而其余 6 条断言**全部照绿** —— 主表仍是 `FROM xinzeng x LEFT JOIN period_agg pa`、
     * `COALESCE(...)` 与 `GROUP BY` 都在、`store_ids` 的 UNION 也在。
     *
     * ⚠️ 反向断言必须限制在 `new_store` 块内：`trial_store` / `repurchase_store`
     * **合法地**使用 `COUNT(DISTINCT pa.client_user_id)`，跨块惰性匹配会假红。
     */
    it('new_store 的计数主体是 x.client_user_id（不是 pa —— 兜底分组里 pa.* 全 NULL）', () => {
      const block = cteBlock(adminDetail, 'new_store', 'repurchase_store')
      expect(block, 'new_store 块未切出（CTE 顺序变了？）').toBeTruthy()
      expect(block, 'new_store 的计数主体不是 x.client_user_id —— 兜底分组会数出 0（#286）').toMatch(
        /COUNT\(DISTINCT\s+x\.client_user_id\)/,
      )
      expect(block, 'new_store 回退成按 pa 计数 —— 期内无销售单消费的新增顾客会被数成 0').not.toMatch(
        /COUNT\(DISTINCT\s+pa\.client_user_id\)/,
      )
    })

    /**
     * staff 端哨兵：目前 `mgmt-product.js` **没有**任何按门店/市场的明细口径
     * （全文零 `GROUP BY ... store_id`，三段 UNION ALL 都按 product_kind 分组），
     * 所以本 issue 不涉及跨端。这条哨兵在 staff 日后长出 byStore 明细时立刻转红，
     * 提醒必须同步 #286 的归店修复，否则会原样复刻这个 65.5% 的缺陷。
     */
    it('staff 端仍无按门店明细（长出来时必须同步 #286 的归店口径）', () => {
      expect(
        staffCode,
        'staffApi 出现了按门店分组 —— 请同步 #286 的「xinzeng 主表 + entry_store_id 兜底」归店口径',
      ).not.toMatch(/GROUP\s+BY\s+[\w.]*store_id/)
    })

    /**
     * ★ 全部断言收进 `new_store` 的 CTE 体内。
     *
     * round-1 的 boundary-critic 在内存里实测出：断言写成
     * `/new_store\s+AS\s*\([\s\S]*?FROM\s+xinzeng\s+x\s+LEFT\s+JOIN.../` 时
     * **`[\s\S]*?` 没有右边界** —— 那个字面量只要出现在 `new_store AS (` 之后的任意位置
     * （后面别的 CTE 里、甚至一行注释里）就算数。于是三种改法都能让 65.5% 的漏损
     * 100% 复活而断言全绿：
     *   E) 计数主体改回 `pa.client_user_id`（兜底分组里 pa.* 全 NULL → 数出 0）
     *   F) 体内加一行 `WHERE pa.store_id IS NOT NULL`（把 LEFT JOIN 打回内连接）
     *   A) 换别名写成内连接（`period_agg p JOIN xinzeng z`）+ 注释补字面量
     * 反向断言当时也只钉死一种拼法，对 `INNER JOIN` / 逗号连接 / 别名变更全免疫。
     */
    it('new_store 以 xinzeng 为主表 LEFT JOIN period_agg（体内断言，堵别名/INNER/逗号连接）', () => {
      const block = cteBlock(adminDetail, 'new_store', 'repurchase_store')
      expect(block, 'new_store 块未切出（CTE 顺序变了？）').toBeTruthy()

      expect(block, 'new_store 的主表不是 xinzeng').toMatch(
        /FROM\s+xinzeng\s+x\s+LEFT\s+JOIN\s+period_agg\s+pa\b/,
      )
      // 任何非 LEFT 的 JOIN 都会把「进入达标日只有寄存单」的顾客丢掉
      expect(block, 'new_store 出现了非 LEFT 的 JOIN —— 会丢掉无 period 行的新增顾客').not.toMatch(
        /\b(INNER|RIGHT|FULL|CROSS)\s+JOIN\b/i,
      )
      // 逗号连接 + WHERE 关联等价于内连接
      expect(block, 'new_store 用逗号连接了两个表 —— 等价于内连接').not.toMatch(
        /FROM\s+\w+\s+\w+\s*,/,
      )
      // 体内任何 WHERE 都可能把 LEFT JOIN 打回内连接（最典型：WHERE pa.store_id IS NOT NULL）
      expect(
        block,
        'new_store 体内出现 WHERE —— 对 LEFT JOIN 的右表加过滤会退化成内连接（#286 原缺陷）',
      ).not.toMatch(/\bWHERE\b/i)
    })

    /**
     * `entry_date` 与 `entry_store_id` 必须出自**同一行**（`DISTINCT ON`），而不是
     * 「先算 entry_date、再用等值条件回查门店」。
     *
     * 两个理由，都由 round-1 评审实测背书：
     *   1. **NULL 安全**：回查写法要用 `qd.grp = fe.grp`，而 `product_kind` 在 schema 里可空，
     *      grp 为 NULL 时等值不匹配 → `entry_store_id` 为 NULL → 那批人静默丢三次
     *      （COALESCE 得 NULL 组 → store_ids 排除 NULL → 最终 LEFT JOIN 永不匹配）。
     *      同生共死的 DISTINCT ON 在结构上排除了这种组合。
     *   2. **性能**：回查是相关子查询，复杂度 O(|xinzeng| × |qualifying_days|)，
     *      生产实测把这条明细查询从 825ms 拖到 **2276ms（+177%）**，且两者都随历史数据线性增长。
     *      DISTINCT ON 版实测 **843ms**，与基线持平，结果双向 EXCEPT 为 0 行。
     */
    it('entry_date 与 entry_store_id 出自同一行（DISTINCT ON，非等值回查）', () => {
      expect(adminDetail, 'xinzeng 缺 entry_store_id 列').toMatch(
        /xinzeng\s+AS\s*\([\s\S]*?entry_store_id/,
      )
      const block = cteBlock(adminDetail, 'entry_store', 'xinzeng')
      expect(block, 'entry_store CTE 未切出').toBeTruthy()
      expect(block, 'entry_store 未用 DISTINCT ON (client_user_id, grp)').toMatch(
        /SELECT\s+DISTINCT\s+ON\s*\(\s*client_user_id,\s*grp\s*\)/,
      )
      expect(block, 'entry_date 与 entry_store_id 未出自同一行').toMatch(
        /purchase_date\s+AS\s+entry_date[\s\S]*?store_id\s+AS\s+entry_store_id/,
      )
      // 最早达标日 + 同日多店的确定性 tie-break
      expect(block, 'ORDER BY 未按 purchase_date 取最早、未用 store_id 兜底排序').toMatch(
        /ORDER\s+BY\s+client_user_id,\s*grp,\s*purchase_date,\s*store_id/,
      )
      // MATERIALIZED 被摘掉会让 planner 因行数估计失真选 nested loop，耗时回到 1.6s+
      expect(block === '' ? '' : adminDetail, 'entry_store 丢了 MATERIALIZED —— 执行计划会退化').toMatch(
        /entry_store\s+AS\s+MATERIALIZED\s*\(/,
      )
      // 回查写法（相关子查询）不得复活
      expect(adminDetail, 'entry_store_id 退回等值回查 —— NULL 不安全且 O(n²)').not.toMatch(
        /MIN\(qd\.store_id\)/,
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
