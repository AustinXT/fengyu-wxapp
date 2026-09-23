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
  /**
   * #286：明细「新增人数」的归店必须以 `xinzeng` 为主表 LEFT JOIN `period_agg`。
   *
   * 缺陷原理：`period_agg` 要求 `purchase_received > 0`（只统计销售单/转换单，**不含寄存单**），
   * 而进入达标（`first_entry` → `entry_store` → `xinzeng`）走 `day_received`（**含寄存单**）。
   * 以 `period_agg` 作主表再内连接回来，会把「进入达标日金额全部来自寄存单」的顾客整体丢弃 ——
   * 生产实测明细合计只有 KPI 的三分之一（**漏 65.5%**），派生的新增客单价与复购率双双虚高 **2.90 倍**。
   *
   * ⚠️ 这些断言只对**明细侧**（`queryCycleByStore`）的 SQL 模板生效：KPI 侧 `queryCycle`
   * 有一份同名 CTE 链，对整份源码 `toMatch` 时它的字面量会把明细侧的漏改顶掉。
   *
   * ⚠️ **所有断言都必须收进 `cteBlock()` 切出的 CTE 体内**。round-1 的三个 reviewer 各自
   * 实测出：只要正向断言的 `[\s\S]*?` 没有右边界，那个字面量出现在该 CTE 之后的任意位置
   * （别的 CTE 里、注释里、字符串里）都算数，于是多种改法能让 65.5% 的漏损 100% 复活而断言全绿。
   */
  describe('明细新增人数以 xinzeng 为主表归店（#286）', () => {
    /**
     * 切出 queryCycleByStore 的 SQL 模板，避免 KPI 侧同名 CTE 链顶替。
     *
     * 剥掉 SQL 行注释**与单引号字符串字面量**：前者堵「删真实代码 + 用 `--` 把字面量补回去」，
     * 后者堵「在块内塞一个 `'FROM xinzeng x LEFT JOIN period_agg pa'` 字符串」的注入
     * （round-1 GLM 指出）。模板内的字符串只有中文枚举值，剥掉不影响任何断言。
     *
     * ⚠️ 正则剥 `--` 在一般情况下不可靠（`--` 出现在字符串里会误删后续条件），
     * 但这里**先剥字符串再剥注释**，且剥完只用于结构断言；即便误删，后果也是正向断言
     * 误红（fail-closed），不会假绿。
     */
    const detailSql = (src: string): string => {
      const fn = /async function queryCycleByStore\([\s\S]*?\n}/.exec(src)?.[0] ?? ''
      const tpl = /db\.execute\(sql`([\s\S]*?)`\)/.exec(fn)?.[1] ?? ''
      return normalize(tpl.replace(/'(?:[^']|'')*'/g, ' ').replace(/--[^\n]*/g, ' '))
    }
    /**
     * 切出单个 CTE 块（以下一个 CTE 名为右边界），避免跨块的惰性匹配假红/假绿。
     * 两侧都容忍 `AS MATERIALIZED (` 这种带物化提示的写法。
     */
    const cteBlock = (sqlText: string, name: string, nextName: string): string =>
      new RegExp(
        `${name}\\s+AS\\s+(?:MATERIALIZED\\s+)?\\(([\\s\\S]*?)\\),\\s*${nextName}\\s+AS\\s`,
      ).exec(sqlText)?.[1] ?? ''
    /** 末尾 CTE（store_ids）没有「下一个 CTE」，以最终 SELECT 为右边界 */
    const lastCteBlock = (sqlText: string, name: string): string =>
      new RegExp(`${name}\\s+AS\\s+(?:MATERIALIZED\\s+)?\\(([\\s\\S]*?)\\)\\s*SELECT\\s`).exec(sqlText)?.[1] ?? ''

    /**
     * 块内**禁止嵌套 CTE / LATERAL**（round-2 GLM）。
     *
     * `cteBlock` 以「`),` + 下一个 CTE 名 + ` AS `」为右边界。若块内自己嵌一个
     * `WITH decoy AS (...), repurchase_store AS (SELECT 1) SELECT ...` —— 撞名会让右边界
     * **提前闭合**，真正的坏代码落在切片之外，所有正向/反向断言都只检查到诱饵前缀。
     * 这四个聚合 CTE 本就不该嵌 CTE，一刀切禁掉（当前块内零 WITH，不误红）。
     */
    const assertNoNestedCte = (block: string, name: string): void => {
      expect(block, `${name} 块内出现嵌套 WITH —— 可用撞名 CTE 让切片右边界提前闭合`).not.toMatch(/\bWITH\b/i)
      expect(block, `${name} 块内出现 LATERAL —— 可借它注入零行子查询破坏结果`).not.toMatch(/\bLATERAL\b/i)
    }

    let adminDetail: string
    beforeAll(() => {
      adminDetail = detailSql(adminSrc)
    })

    it('切片锚点有效（能切出明细侧 SQL 且含关键 CTE）', () => {
      expect(adminDetail, 'queryCycleByStore 的 SQL 模板未切出').toBeTruthy()
      for (const cte of ['entry_store', 'xinzeng', 'new_store', 'store_ids', 'period_agg']) {
        expect(adminDetail, `明细侧缺 ${cte} CTE`).toMatch(new RegExp(`${cte}\\s+AS\\s`))
      }
      const fn = /async function queryCycleByStore\([\s\S]*?\n}/.exec(adminSrc)?.[0] ?? ''
      expect(
        (fn.match(/db\.execute\(/g) ?? []).length,
        '明细侧出现多个 db.execute —— detailSql 的切片口径需同步更新',
      ).toBe(1)
    })

    /**
     * `entry_date` 与 `entry_store_id` 必须出自**同一行**（`DISTINCT ON`），而不是
     * 「先算 entry_date、再用等值条件回查门店」。两个理由都由 round-1 实测背书：
     *   1. **NULL 安全**：回查要用 `qd.grp = fe.grp`，而 `product_kind` 在 schema 里可空，
     *      grp 为 NULL 时等值不匹配 → `entry_store_id` 为 NULL → 那批人静默丢三次。
     *   2. **性能**：回查是相关子查询，O(|xinzeng| × |qualifying_days|)，
     *      生产实测把这条明细查询拖慢 **+177%**；DISTINCT ON 版与基线持平，结果双向 EXCEPT 为 0 行。
     */
    it('entry_store：entry_date 与 entry_store_id 出自同一行（DISTINCT ON，非等值回查）', () => {
      const block = cteBlock(adminDetail, 'entry_store', 'xinzeng')
      expect(block, 'entry_store CTE 未切出').toBeTruthy()
      assertNoNestedCte(block, 'entry_store')
      expect(block, '未用 DISTINCT ON (client_user_id, grp)').toMatch(
        /SELECT\s+DISTINCT\s+ON\s*\(\s*client_user_id,\s*grp\s*\)/,
      )
      expect(block, 'entry_date 与 entry_store_id 未出自同一行').toMatch(
        /purchase_date\s+AS\s+entry_date[\s\S]*?store_id\s+AS\s+entry_store_id/,
      )
      expect(block, 'ORDER BY 未按 purchase_date 取最早、未用 store_id 兜底排序').toMatch(
        /ORDER\s+BY\s+client_user_id,\s*grp,\s*purchase_date,\s*store_id/,
      )
      expect(adminDetail, 'entry_store 丢了 MATERIALIZED —— 执行计划会退化').toMatch(
        /entry_store\s+AS\s+MATERIALIZED\s*\(/,
      )
    })

    /**
     * `xinzeng` 必须**直接从 `entry_store` 派生**（round-1 codex + GLM 同时指出）。
     *
     * 此前这条断言写成 `/xinzeng\s+AS\s*\([\s\S]*?entry_store_id/` —— 没有右边界，
     * 而 `entry_store_id` 在其后的 `new_store`、`store_ids` 里必然出现，所以**恒绿**。
     * 绕过路径：把 `xinzeng` 改回 `FROM first_entry` + 用 `ORDER BY ... LIMIT 1` 形态的
     * 相关子查询取门店（换个拼法即可避开只堵 `MIN(qd.store_id)` 的反向断言），
     * NULL 洞与 O(n²) 双双复活而测试全绿。
     */
    it('xinzeng 直接从 entry_store 派生（四列投影，不回退到 first_entry + 回查）', () => {
      const block = cteBlock(adminDetail, 'xinzeng', 'fugou')
      expect(block, 'xinzeng CTE 未切出').toBeTruthy()
      assertNoNestedCte(block, 'xinzeng')
      expect(block, 'xinzeng 不是从 entry_store 派生').toMatch(/FROM\s+entry_store\b/)
      expect(block, 'xinzeng 的四列投影不完整').toMatch(
        /SELECT\s+client_user_id,\s*grp,\s*entry_date,\s*entry_store_id/,
      )
      expect(block, 'xinzeng 退回 first_entry —— 门店又要靠等值回查（NULL 不安全 + O(n²)）').not.toMatch(
        /FROM\s+first_entry/,
      )
      expect(block, 'xinzeng 体内出现子查询 —— 回查写法复活').not.toMatch(/\(\s*SELECT\s/i)
      // xinzeng 合法地有 WHERE entry_date BETWEEN ...，但不得追加别的谓词
      // ——「过滤掉 grp 为 NULL 的人」正是本 PR 文档化的失败模式
      expect(block, 'xinzeng 的 WHERE 追加了区间之外的谓词').toMatch(
        /WHERE\s+entry_date\s+BETWEEN\s+\$\{range\.start\}\s+AND\s+\$\{range\.end\}\s*$/,
      )
    })

    /**
     * ★ `new_store` 的全部结构约束，一律在 CTE 体内断言。
     *
     * round-1 实测出的绕过路径（当时全部全绿）：
     *   E) 计数主体改回 `pa.client_user_id` —— 兜底分组里 `pa.*` 全 NULL，`COUNT(DISTINCT NULL) = 0`
     *   F) 体内加 `WHERE pa.store_id IS NOT NULL` —— 把 LEFT JOIN 打回内连接
     *   A) 换别名写成内连接 + 注释补字面量
     *   H) 加 `HAVING SUM(pa.day_received) > 0` —— entry-only 兜底组 revenue=0 被整体滤掉
     *   J) 追加一条裸 `JOIN period_agg gate ...` —— 不含 INNER/RIGHT/FULL/CROSS 关键字
     */
    it('new_store：以 xinzeng 为主表、恰一条 LEFT JOIN、无 WHERE/HAVING、计数主体是 x', () => {
      const block = cteBlock(adminDetail, 'new_store', 'repurchase_store')
      expect(block, 'new_store 块未切出（CTE 顺序变了？）').toBeTruthy()
      assertNoNestedCte(block, 'new_store')
      // 堵「, LATERAL (SELECT 1 LIMIT 0)」这类零行破坏，以及任何回查子查询
      expect(block, 'new_store 体内出现子查询').not.toMatch(/\(\s*SELECT\s/i)

      expect(block, 'new_store 的主表不是 xinzeng').toMatch(
        /FROM\s+xinzeng\s+x\s+LEFT\s+JOIN\s+period_agg\s+pa\b/,
      )
      // 恰好一条 JOIN，且必是 LEFT —— 堵「追加一条裸 JOIN 当过滤闸」
      expect(
        (block.match(/\bJOIN\b/gi) ?? []).length,
        'new_store 里的 JOIN 不止一条 —— 多出来的那条会重新过滤掉无 period 行的顾客',
      ).toBe(1)
      expect(block, 'new_store 出现了非 LEFT 的 JOIN').not.toMatch(
        /\b(INNER|RIGHT|FULL|CROSS)\s+JOIN\b/i,
      )
      expect(block, 'new_store 用逗号连接了两个表 —— 等价于内连接').not.toMatch(
        /FROM\s+\w+\s+\w+\s*,/,
      )
      // WHERE 对右表加过滤会把 LEFT JOIN 打回内连接；HAVING 会把 revenue=0 的兜底组整体滤掉
      expect(block, 'new_store 体内出现 WHERE —— 对右表过滤会退化成内连接').not.toMatch(/\bWHERE\b/i)
      expect(
        block,
        'new_store 体内出现 HAVING —— 「只有寄存单进入」的门店 revenue=0，会被整组滤掉（#286 换个写法回归）',
      ).not.toMatch(/\bHAVING\b/i)
      // 计数主体必须是 xinzeng 的顾客：兜底分组里 pa.* 全是 NULL
      expect(block, 'new_store 的计数主体不是 x.client_user_id —— 兜底分组会数出 0').toMatch(
        /COUNT\(DISTINCT\s+x\.client_user_id\)/,
      )
      expect(block, 'new_store 回退成按 pa 计数').not.toMatch(/COUNT\(DISTINCT\s+pa\.client_user_id\)/)
      // 归店列与 GROUP BY 必须是同一个 COALESCE 表达式
      expect(block, '归店列不是 COALESCE(消费门店, entry 门店)').toMatch(
        /COALESCE\(pa\.store_id,\s*x\.entry_store_id\)\s+AS\s+store_id/,
      )
      expect(block, 'GROUP BY 未与投影的归店表达式一致').toMatch(
        /GROUP\s+BY\s+COALESCE\(pa\.store_id,\s*x\.entry_store_id\)/,
      )
    })

    it('store_ids 骨架并上 entry 门店（否则只有寄存单进入的门店会漏行）', () => {
      const block = lastCteBlock(adminDetail, 'store_ids')
      expect(block, 'store_ids 块未切出').toBeTruthy()
      assertNoNestedCte(block, 'store_ids')
      // ⚠️ 必须锚到**块尾**：只匹配前缀的话，追加 `AND FALSE` 之类谓词仍然全绿，
      // 而 entry-only 门店就不进骨架、new_store 算出的人数在最终 JOIN 再次丢失（round-2 codex）
      expect(block, 'store_ids 未并上 xinzeng 的 entry 门店，或 UNION 分支被追加了额外谓词').toMatch(
        /FROM\s+period_agg\s+UNION\s+SELECT\s+DISTINCT\s+entry_store_id\s+FROM\s+xinzeng\s+WHERE\s+entry_store_id\s+IS\s+NOT\s+NULL\s*$/,
      )
    })

    /**
     * 体验/复购不需要兜底：`tiyan` 本就从 `period_agg` 派生，
     * `fugou` 要求 `purchase_received >= threshold > 0`，两者必然在 `period_agg` 里有行。
     * 锁住这一点，免得日后有人"顺手"把它们也改成 LEFT JOIN 兜底，反而引入无处归店的行。
     */
    it('体验/复购仍以 period_agg 为主表（它们必然有 period 行，无需兜底）', () => {
      expect(cteBlock(adminDetail, 'trial_store', 'new_store')).toMatch(
        /FROM\s+period_agg\s+pa\s+JOIN\s+tiyan\s+t/,
      )
      expect(cteBlock(adminDetail, 'repurchase_store', 'store_ids')).toMatch(
        /FROM\s+period_agg\s+pa\s+JOIN\s+fugou\s+fg/,
      )
    })

    /**
     * staff 端哨兵：`mgmt-product.js` 目前**没有按门店的归店聚合** —— 三段 UNION ALL 都按
     * `product_kind` 分组。它确实有一条含 `store_id` 的 `GROUP BY`
     * （`daily_agg` 的 `(client_user_id, store_id, product_kind, performance_date)` 四键基础聚合），
     * 那是**逐日逐店的原始聚合**、不是归店输出，必须放行。
     *
     * ⚠️ 这条哨兵前两版都被评审打穿过，所以改用**全量 snapshot**：
     *   v1 `/GROUP BY\s+[\w.]*store_id/` —— 要求 store_id 紧跟 GROUP BY，
     *      `GROUP BY product_kind, store_id` 被逗号挡住而假绿；且当时注释声称
     *      「staff 全文零 GROUP BY store_id」**与事实不符**（`mgmt-product.js:259` 就有）。
     *   v2 「凡含 store_id 的 GROUP BY 必须同时含 performance_date」—— 判据方向对，但实现
     *      退化成字面单空格 + 大小写敏感 + 用 `)` 当终止符（`COALESCE(a, b)` 会截断），
     *      且 `GROUP BY 1, 2` 这种序号分组根本不含 store_id 字面量，全部漏检（fail-open）。
     *
     * 现在锁**整份清单**：staff 任何 GROUP BY 的新增/改写都会红，强制人工确认它是不是
     * 归店聚合。若确认是归店明细，必须同步 #286 的「xinzeng 主表 + entry_store_id 兜底」口径。
     */
    it('staff 的 GROUP BY 清单未变（新增归店聚合时必须同步 #286 的归店口径）', () => {
      // 先剥 SQL 行注释（保留换行，GROUP BY 在 staff 源码里都是单行），
      // 避免 `GROUP BY store_id -- performance_date` 这类注入；大小写不敏感。
      const staffSqlOnly = stripComments(staffSrc).replace(/--[^\n]*/g, ' ')
      const groupBys = (staffSqlOnly.match(/group\s+by\s+[^\n`]*/gi) ?? []).map((g) =>
        g.replace(/\s+/g, ' ').trim(),
      )
      expect(groupBys, 'staff 的 GROUP BY 清单发生变化 —— 新增按门店的归店聚合时请同步 #286').toEqual([
        'GROUP BY pc.product_kind',
        'GROUP BY so.client_user_id, so.store_id, pc.product_kind, sipe.performance_date',
        'GROUP BY client_user_id, product_kind',
        'GROUP BY t.product_kind',
        'GROUP BY x.product_kind',
        'GROUP BY f.product_kind',
      ])
      // 双保险：清单里唯一允许含 store_id 的那条，必须是带日期维度的逐日基础聚合
      const withStoreId = groupBys.filter((g) => /store_id/i.test(g))
      expect(withStoreId, '含 store_id 的 GROUP BY 不止一条').toHaveLength(1)
      expect(withStoreId[0], '唯一含 store_id 的 GROUP BY 不是逐日基础聚合 —— 这是归店聚合').toMatch(
        /performance_date/,
      )
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
