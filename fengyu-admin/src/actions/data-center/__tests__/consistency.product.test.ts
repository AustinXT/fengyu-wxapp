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
     * 单遍扫描剥掉 SQL 里的「噪音」，供结构断言使用。剥三类：
     *   1. **单引号字符串字面量**（含 `''` 转义）—— 堵「在块内塞一个
     *      `'FROM xinzeng x LEFT JOIN period_agg pa'` 字符串」的注入（round-1 GLM）
     *   2. **块注释 `/* *\/`，且按深度计数** —— PostgreSQL 的块注释**可嵌套**
     *   3. **行注释 `--`** —— 堵「删真实代码 + 用 `--` 把字面量补回去」
     *
     * ⚠️ **为什么不能用三条 `replace` 正则**（round-4 codex 实测打穿）：
     * `/\/\*[\s\S]*?\*\//` 只吃到**第一个** `*\/`，而 PG 允许嵌套。于是
     * `(/* outer /* inner *\/ still outer *\/SELECT 0)` 剥完剩下
     * `( still outer *\/SELECT 0)`，`\(\s*SELECT` 看不见这个子查询 ——
     * 把它乘进 `cnt` 就能让新增人数恒为 0，而块内全部断言仍绿。
     *
     * 单遍交替扫描同时保证了三者的嵌套顺序正确：先遇到 `'` 就整段吃字符串
     * （连同其中的 `--` / `/*`），先遇到注释就整段吃注释（连同其中的引号）。
     * 未闭合的 `/*` 会把剩余全部吞掉 → 切片失败 → 断言误红（fail-closed）。
     */
    const stripSqlNoise = (tpl: string): string => {
      let out = ''
      let i = 0
      let depth = 0
      while (i < tpl.length) {
        if (depth > 0) {
          if (tpl.startsWith('/*', i)) { depth++; i += 2; continue }
          if (tpl.startsWith('*/', i)) { depth--; i += 2; if (depth === 0) out += ' '; continue }
          i++
          continue
        }
        if (tpl.startsWith('/*', i)) { depth = 1; i += 2; continue }
        if (tpl.startsWith('--', i)) {
          while (i < tpl.length && tpl[i] !== '\n') i++
          out += ' '
          continue
        }
        if (tpl[i] === "'") {
          i++
          while (i < tpl.length) {
            if (tpl[i] === "'" && tpl[i + 1] === "'") { i += 2; continue }
            if (tpl[i] === "'") { i++; break }
            i++
          }
          out += ' '
          continue
        }
        out += tpl[i]
        i++
      }
      return out
    }

    /** 切出 queryCycleByStore 的 SQL 模板，避免 KPI 侧同名 CTE 链顶替。 */
    const detailSql = (src: string): string => {
      const fn = /async function queryCycleByStore\([\s\S]*?\n}/.exec(src)?.[0] ?? ''
      const tpl = /db\.execute\(sql`([\s\S]*?)`\)/.exec(fn)?.[1] ?? ''
      return normalize(stripSqlNoise(tpl))
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
      // 连续锚：`FROM qualifying_days` 与 `ORDER BY` 之间不许插任何东西 ——
      // 追加一条 `JOIN foo ON ...` 或 `WHERE grp IS NOT NULL` 就能把达标日来源筛掉一部分人，
      // 而上面的投影/DISTINCT ON/ORDER BY 断言全都照样绿（round-3 GLM 探针 P-c 实测）。
      expect(block, 'entry_store 的 FROM 与 ORDER BY 之间被插入了 JOIN / WHERE 等过滤').toMatch(
        /FROM\s+qualifying_days\s+ORDER\s+BY\s+client_user_id,\s*grp,\s*purchase_date,\s*store_id\s*$/,
      )
      expect(
        (block.match(/\bJOIN\b/gi) ?? []).length,
        'entry_store 出现 JOIN —— 它必须是 qualifying_days 的纯去重投影',
      ).toBe(0)
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
      // ——「过滤掉 grp 为 NULL 的人」正是本 PR 文档化的失败模式。
      // ⚠️ 连续锚：只钉 WHERE 的尾巴挡不住在 FROM 与 WHERE **之间**插一条
      // `JOIN foo ON ... AND grp IS NOT NULL`（round-3 GLM 探针 P-a 实测可绕）。
      expect(block, 'xinzeng 的 FROM 与 WHERE 之间被插入了 JOIN，或 WHERE 追加了区间之外的谓词').toMatch(
        /FROM\s+entry_store\s+WHERE\s+entry_date\s+BETWEEN\s+\$\{range\.start\}\s+AND\s+\$\{range\.end\}\s*$/,
      )
      expect(
        (block.match(/\bJOIN\b/gi) ?? []).length,
        'xinzeng 出现 JOIN —— 它必须是 entry_store 的纯区间切片，任何连接都可能筛掉人',
      ).toBe(0)
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

      // ON 子句整条钉死：JOIN 计数 = 1 只管「有几条连接」，管不住在这一条的 ON 里
      // 追加谓词（如 `AND pa.store_id IS DISTINCT FROM 'store-x'` 把某店业绩挪走，
      // 或 `AND pa.day_received > 0` 把兜底人群的消费行打掉）—— round-3 GLM 探针 P-b 实测可绕。
      expect(block, 'new_store 的主表不是 xinzeng，或 ON 子句被追加了连接键以外的谓词').toMatch(
        /FROM\s+xinzeng\s+x\s+LEFT\s+JOIN\s+period_agg\s+pa\s+ON\s+pa\.client_user_id\s*=\s*x\.client_user_id\s+AND\s+pa\.grp\s*=\s*x\.grp\s+GROUP\s+BY\b/,
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
      expect(block, 'new_store 回退成按 pa 计数').not.toMatch(/COUNT\(DISTINCT\s+pa\.client_user_id\)/)

      /**
       * ★ 整块钉成**字面快照**（round-4 codex 打穿了上一版的"关键子表达式出现过即可"）。
       *
       * 只断言「`COUNT(DISTINCT x.client_user_id)` 出现过」时，下面这两条全绿：
       *
       *   COUNT(DISTINCT x.client_user_id)
       *   - COUNT(DISTINCT CASE WHEN pa.client_user_id IS NULL THEN x.client_user_id END) AS cnt
       *     ↑ 恰好减掉没有 period 行的兜底顾客 —— #286 的主缺陷原地复活
       *
       *   GROUP BY COALESCE(pa.store_id, x.entry_store_id), (pa.client_user_id IS NULL)
       *     ↑ 同一门店裂成两行，product.ts 的 `m.set(store_id, ...)` 后一行覆盖前一行，
       *       **不确定性漏数**（漏哪家取决于行序）
       *
       * 所以这里锁整条投影 + 整条 FROM/JOIN/ON + GROUP BY 锚到块尾，中间不留缝。
       *
       * ⚠️ **这是有意为之的字面快照，不是结构断言**：交换等值条件左右、加括号、
       * 改别名、补显式 ASC 都会误红。这是三轮评审反复打穿"部分结构断言"后的取舍 ——
       * 宁可拦住合理重构（fail-closed，看到红就来读这段注释、确认语义没变再同步更新），
       * 也不能再放过一个让 65.5% 漏损复活的等价变形。
       */
      expect(
        block.trim(),
        'new_store 块与字面快照不符 —— 先确认语义没变（尤其是计数主体与 GROUP BY 维度），再同步更新本断言',
      ).toBe(
        'SELECT COALESCE(pa.store_id, x.entry_store_id) AS store_id, ' +
          'COUNT(DISTINCT x.client_user_id) AS cnt, ' +
          'COALESCE(SUM(pa.day_received), 0) AS revenue ' +
          'FROM xinzeng x ' +
          'LEFT JOIN period_agg pa ' +
          'ON pa.client_user_id = x.client_user_id AND pa.grp = x.grp ' +
          'GROUP BY COALESCE(pa.store_id, x.entry_store_id)',
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
     * ★ 最终 SELECT 也必须守护（round-4 codex）。
     *
     * 前面所有断言都切到 `store_ids` 就结束了 —— CTE 全部算对，结果仍可在**消费端**被丢掉：
     *
     *   LEFT JOIN new_store n ON n.store_id = s.store_id AND n.revenue > 0
     *
     * 这一条就把「只有寄存单进入、零销售单消费」的门店（revenue = 0）重新滤掉，
     * 正好抵消 `store_ids` 第二个 UNION 分支要保护的场景，而上面的断言无一触发。
     *
     * 同理，把 `COALESCE(n.cnt, 0) AS new_count` 改成 `COALESCE(n.cnt, 0) * 0` 之类也无人拦。
     * 与 `new_store` 同样处理：**字面快照**，见上面那段关于 fail-closed 取舍的说明。
     */
    it('最终 SELECT 未被追加过滤（CTE 算对了也能在消费端丢行）', () => {
      const finalSelect = /\)\s*(SELECT\s[\s\S]*)$/.exec(adminDetail)?.[1] ?? ''
      expect(finalSelect, '最终 SELECT 未切出 —— 切片口径需同步更新').toBeTruthy()
      expect(
        finalSelect.trim(),
        '最终 SELECT 与字面快照不符 —— 尤其检查三条 LEFT JOIN 的 ON 有没有被追加谓词（会再次丢行）',
      ).toBe(
        'SELECT s.store_id AS store_id, ' +
          'COALESCE(t.cnt, 0) AS trial_count, ' +
          'COALESCE(n.cnt, 0) AS new_count, ' +
          'COALESCE(n.revenue, 0) AS new_revenue, ' +
          'COALESCE(r.cnt, 0) AS repurchase_count, ' +
          'COALESCE(r.revenue, 0) AS repurchase_revenue ' +
          'FROM store_ids s ' +
          'LEFT JOIN trial_store t ON t.store_id = s.store_id ' +
          'LEFT JOIN new_store n ON n.store_id = s.store_id ' +
          'LEFT JOIN repurchase_store r ON r.store_id = s.store_id',
      )
    })

    /**
     * 体验/复购不需要兜底：`tiyan` 本就从 `period_agg` 派生，
     * `fugou` 要求 `purchase_received >= threshold > 0`，两者必然在 `period_agg` 里有行。
     * 锁住这一点，免得日后有人"顺手"把它们也改成 LEFT JOIN 兜底，反而引入无处归店的行。
     */
    it('体验/复购仍以 period_agg 为主表（它们必然有 period 行，无需兜底）', () => {
      const trial = cteBlock(adminDetail, 'trial_store', 'new_store')
      const repurchase = cteBlock(adminDetail, 'repurchase_store', 'store_ids')
      expect(trial, 'trial_store 块未切出').toBeTruthy()
      expect(repurchase, 'repurchase_store 块未切出').toBeTruthy()
      expect(trial).toMatch(/FROM\s+period_agg\s+pa\s+JOIN\s+tiyan\s+t/)
      expect(repurchase).toMatch(/FROM\s+period_agg\s+pa\s+JOIN\s+fugou\s+fg/)
      // 与 new_store 同理：正向断言只认前缀，追加第二条 JOIN 当过滤闸仍然全绿
      expect((trial.match(/\bJOIN\b/gi) ?? []).length, 'trial_store 的 JOIN 不止一条').toBe(1)
      expect(
        (repurchase.match(/\bJOIN\b/gi) ?? []).length,
        'repurchase_store 的 JOIN 不止一条',
      ).toBe(1)
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
      // 先剥 SQL 行注释，避免 `GROUP BY store_id -- performance_date` 这类注入；大小写不敏感。
      const staffSqlOnly = stripComments(staffSrc).replace(/--[^\n]*/g, ' ')
      /**
       * ⚠️ **不能用「`group\s+by\s+` 后跟 `[^\n` + 反引号 `]*`」这种匹配**
       * （round-3 codex 实测打穿）：它在换行处停，于是**续行追加的分组键看不见** ——
       *
       *   GROUP BY x.product_kind
       *          , x.store_id        ← 提取结果仍是 'GROUP BY x.product_kind'
       *
       * 清单不变、`withStoreId` 仍只有 1 条，哨兵**静默假绿**，而 staff 已经长出归店聚合。
       *
       * ⚠️ **也不能简单拿 `)` / `),` 当终止符**（round-2 GLM 指出的 v2 缺陷）：
       * `GROUP BY COALESCE(a, b)` 会在函数的闭括号处被截断。
       *
       * 所以先把空白压平（跨行 GROUP BY 变成一条），再**按括号深度扫描**找真正的右边界：
       * 深度 0 时遇到多余的 `)`（CTE 收尾）、反引号、分号，或 `HAVING` / `UNION` /
       * `ORDER BY` / `LIMIT` / `WINDOW` 关键字才停；函数调用里的括号不会误判。
       */
      const flat = staffSqlOnly.replace(/\s+/g, ' ')
      const readGroupBy = (from: number): string => {
        let i = from
        let depth = 0
        while (i < flat.length) {
          const ch = flat[i]
          if (ch === '(') depth++
          else if (ch === ')') {
            if (depth === 0) break
            depth--
          } else if (ch === '`' || ch === ';') break
          else if (depth === 0 && i > from && /^(?:having|union|order\s+by|limit|window)\b/i.test(flat.slice(i))) break
          i++
        }
        return flat.slice(from, i).replace(/\s+/g, ' ').trim()
      }
      const groupBys: string[] = []
      const gbRe = /group\s+by\s+/gi
      let gbMatch: RegExpExecArray | null
      while ((gbMatch = gbRe.exec(flat)) !== null) groupBys.push(readGroupBy(gbMatch.index))
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
