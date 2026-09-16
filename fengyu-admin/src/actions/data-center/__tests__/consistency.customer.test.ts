/**
 * 客量板块两端口径一致性守护
 *
 * 守护对象：
 *   - fengyu-admin/src/actions/data-center/customer.ts                         (Drizzle / TS)
 *   - fengyu-staff/cloudfunctions/staffApi/routes/mgmt-traffic.js              (pg / JS)
 *
 * 两端 ORM 不同 + admin 多了 byMarket/byStore 明细 → 完整 SQL snapshot 不可行。
 * 守护策略 = "关键不变量字面量匹配"（仿 dashboard.consistency.test.ts）：
 *   1. became_member_at（会员/新会员历史化口径）
 *   2. customer_status 枚举值 '沉睡'/'冰冻'/'休眠'（D-6 重命名后，禁 '预警沉睡'）
 *   3. 消费分桶阈值 1990 / 10000 / 30000 / 60000 / 100000（左闭右开）
 *   4. sales_category IN ('自销自耗','他销自耗')（项目数口径）
 *   5. 成交率分母 = 体验客 + 小美客
 *   6. spend = SUM(sale_order_performance_events.amount) @ performance_date（#138 起，与业绩 KPI 同源；
 *      不再按父订单 status 过滤、排除储值卡抵扣；非 metrics.md 的 paid_amount）
 *   7. anchor 反推关键字面量（visits_90d_prev / 6 months / 12 months / 90 days）
 *
 * 任一端口径变更必须双端同步，否则数据中心客量板块与员工端 mgmtTraffic 数字对不上。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'

const ADMIN_CUSTOMER = path.resolve(__dirname, '../customer.ts')
const STAFF_MGMT_TRAFFIC = path.resolve(
  __dirname,
  '../../../../../fengyu-staff/cloudfunctions/staffApi/routes/mgmt-traffic.js',
)

function normalize(src: string): string {
  return src.replace(/\s+/g, ' ').trim()
}

/**
 * 剥离 **JS/TS** 注释（避免 docstring 里的反例引用干扰反向守护）。
 *
 * ⚠ 刻意**不剥 SQL `--` 行注释**。两轮评审把「用正则剥 SQL 注释」这条路彻底打穿：
 *   - 只剥 `-- ` → `--AND ...`（不加空格）绕过
 *   - 放宽到 `(\s)--` → `WHERE TRUE--AND ...`（token 紧贴）仍绕过（codex + GLM 独立复现）
 *   - PG 支持**嵌套**块注释，非贪婪的块注释正则也能被绕
 *   - `--` 出现在 SQL 字符串字面量里（`note = ' --marker' AND paid_amount > 0`）会**误删**
 *     后续有效条件 → 反向断言 `not.toMatch` 反而通过 → 假绿（codex 给出反例，
 *     推翻了我此前「误剥只会误红」的论断）
 *
 * 结论：正则做不了 SQL 词法分析，补一次就冒出下一种等价写法 —— 与 #140 得到的
 * 「黑名单证明不了『没有任何日期条件』」是同一个教训。
 * 因此口径守护的**主力**改为下方 `EXPECTED_SPE_BLOCKS` 块级逐字快照，
 * 它**完全不经过本函数**：块文本与快照差一个字符就红，无需先识别注释。
 *
 * ⚠ 本函数**仅**服务于两类次要断言：逐块定位辅助、以及 `not.toMatch` 反向守卫。
 * 它用正则处理完整源码，codex 指出仍有理论误剥路径（`const marker = '//'; const paid_amount = x`
 * —— `//` 规则从字符串内部删到行尾，反向断言随之假绿；块注释同理）。
 * 当前两个被测文件**不含**触发该误剥的字符串，且这类回退真发生时会改动 FROM 子句 /
 * 块文本，被主守护直接拦下。若日后要彻底闭环，应改用 Babel parser 的真实 comment range
 * （项目已有先例：`.claude/skills/pack-delivery/scripts/strip-comments.mjs`）。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/**
 * **口径守护主力**：7 个 spe 查询块（admin 5 / staff 2）的
 * **投影 + JOIN 链 + WHERE + GROUP BY** 全文逐字快照。
 *
 * 为什么是逐字快照，而不是「找关键字面量」的各种变体 —— 四轮评审把后者逐级打穿：
 *   - r1：只剥 JS 注释 → SQL `-- AND ...` 注释掉过滤，正则仍匹配到注释里的字面量
 *   - r2：补剥 SQL `--` → `--AND`（无空格）绕过；再放宽 → `TRUE--AND`（token 紧贴）绕过；
 *         PG 还支持嵌套块注释；且误剥会让 `not.toMatch` 反向断言**假绿**
 *   - r3：改连续子串 → 因为串不含前导 `AND`，把**第一项**整行注释掉时串仍完整命中；
 *         `BETWEEN` 之后的实参完全没锁，`BETWEEN ${start} AND ${start}`、
 *         `WHERE TRUE OR (...)` 都能让过滤失效而文本不变
 *   - r4：块只从 `FROM` 起、截在 `GROUP BY` 前 → `SUM(spe.amount)` 外面套 `ABS()`/`GREATEST(...,0)`、
 *         改 `GROUP BY` 分组键（人→店）、追加 `HAVING FALSE` 三类改动全部不改块文本
 *
 * 每补一次就冒出下一种等价写法 —— 与 #140 得到的「黑名单证明不了『没有任何日期条件』」
 * 是同一个教训，最终也收敛到同一个形态：**整段逐字快照**。
 * 任何字符级改动（注释、改实参、改聚合函数、改分组键、加 `OR TRUE` / `HAVING`、
 * 调换顺序、插条件）都必须显式更新这里的常量，因此**不需要**先判断某段文本是不是注释。
 *
 * ⚠ 快照的合同是「锁漂移」，不是「证明 SQL 正确」。基线正确性由 round-1 两个谱系独立确认；
 * 日后源码与快照同时更新时，**必须重新做语义审查 + 出数对比**，否则等于把 bug 固化成期望值。
 *
 * ⚠ 射程之外（靠出数对比兜底，两个 reviewer 一致确认）：插值表达式的**生产者**
 * （`scopeFilterSql` / `range.start` / `startDateExpr` 的计算逻辑）、视图定义、结果后处理。
 *
 * ⚠ 改这些常量 = 改口径：必须同步另一端 + 重跑出数对比 + 在 PR 里说明差异。
 */
const EXPECTED_SPE_BLOCKS: Record<'admin' | 'staff', string[]> = {
  admin: [
    // queryOperatedMembers（会员经营人数）
    "SELECT o.client_user_id, SUM(spe.amount::numeric) AS spend FROM sale_order_performance_events spe JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id JOIN client_wechat_users c ON c.user_id = o.client_user_id WHERE ${sc} AND spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN ${range.start} AND ${range.end} AND c.customer_type = '会员客' GROUP BY o.client_user_id )",
    // queryMemberAvgTicket（会员客单价）—— CTE 与上一条同形，外层投影不同
    "SELECT o.client_user_id, SUM(spe.amount::numeric) AS spend FROM sale_order_performance_events spe JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id JOIN client_wechat_users c ON c.user_id = o.client_user_id WHERE ${sc} AND spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN ${range.start} AND ${range.end} AND c.customer_type = '会员客' GROUP BY o.client_user_id )",
    // queryNewMemberSpend（新会员消费）—— 多 became_member_at 谓词，无 customer_type，无 GROUP BY
    "SELECT COALESCE(SUM(spe.amount::numeric), 0) AS v FROM sale_order_performance_events spe JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id JOIN client_wechat_users c ON c.user_id = o.client_user_id WHERE ${sc} AND c.became_member_at IS NOT NULL AND c.became_member_at::date BETWEEN ${range.start} AND ${range.end} AND spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN ${range.start} AND ${range.end}",
    // 门店/市场明细·会员消费分桶 —— 用 skel JOIN 代替 ${sc}
    "SELECT ${groupId} AS group_id, o.client_user_id, SUM(spe.amount::numeric) AS spend FROM sale_order_performance_events spe JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id JOIN skel sk ON sk.store_id = o.store_id JOIN client_wechat_users c ON c.user_id = o.client_user_id WHERE spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN ${start} AND ${end} AND c.customer_type = '会员客' GROUP BY ${groupId}, o.client_user_id )",
    // 门店/市场明细·新会员消费
    "SELECT ${groupId} AS group_id, COALESCE(SUM(spe.amount::numeric), 0) AS new_spend FROM sale_order_performance_events spe JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id JOIN skel sk ON sk.store_id = o.store_id JOIN client_wechat_users c ON c.user_id = o.client_user_id WHERE c.became_member_at IS NOT NULL AND c.became_member_at::date BETWEEN ${start} AND ${end} AND spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN ${start} AND ${end} GROUP BY ${groupId} )",
  ],
  staff: [
    // queryMemberOps（会员经营 + 6 档分桶）
    "SELECT o.client_user_id, SUM(spe.amount::numeric) AS spend FROM sale_order_performance_events spe JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id JOIN client_wechat_users c ON c.user_id = o.client_user_id WHERE ${sc.sql} AND spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)} AND c.customer_type = '会员客' GROUP BY o.client_user_id )",
    // queryNewMemberSpend —— 无 GROUP BY，截到模板结束
    "SELECT COALESCE(SUM(spe.amount::numeric), 0) AS v FROM sale_order_performance_events spe JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id JOIN client_wechat_users c ON c.user_id = o.client_user_id WHERE ${sc.sql} AND c.became_member_at IS NOT NULL AND c.became_member_at::date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)} AND spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}",
  ],
}

/**
 * 在**原文**（只归一化空白，不剥任何注释）上切出每个 spe 查询块。
 *
 * 块范围 = **投影 + JOIN 链 + WHERE + GROUP BY**：
 *   起点：该 `FROM` 之前最近的 `SELECT`（把 `SUM(spe.amount::numeric)` 这类金额表达式纳进来）
 *   终点：`GROUP BY` 之后的第一个 `)`（CTE 收尾）；该查询没有 `GROUP BY` 时截到模板串结束（反引号）
 *
 * ⚠ 起点必须含 SELECT（codex r4）：`SUM(spe.amount)` → `ABS(SUM(spe.amount))` /
 * `GREATEST(SUM(spe.amount), 0)` 会抹平退款净额 —— 而「业务要求不显示负数」正是本 issue
 * 讨论中的议题，这是**最可能真实发生**的漂移，不能落在守护外。
 *
 * ⚠ 终点必须含 GROUP BY（codex r4 + GLM r4）：
 *   - `GROUP BY o.client_user_id` → `o.store_id`：聚合粒度从「人」变「店」，语义全变
 *   - `GROUP BY ... HAVING FALSE`：整块查询归零
 *   两者在旧版（截在 `GROUP BY` 关键字前）都是全绿。
 *
 * ⚠ 为什么必须切块而不是在整份文件里数出现次数：
 * 「删掉一处过滤 + 在别处注释里补一份完整五件套」会让全文件计数**保持不变** →
 * 主守护假绿（自查实测成立）。切块后凑数串不落在任何查询块内；
 * 若凑数串连 `FROM ... spe` 一起伪造，块数就会超出预期 → 红。
 *
 * ⚠ 已知假设：`GROUP BY` 的分组键里不含 `)`（当前 7 块都是简单列名 / `${groupId}`）。
 * 假设被破坏时块尾会落在意外位置 → 块文本变 → 快照不符 → **误红**（fail-loud），不会假绿。
 */
function splitSpeQueryBlocks(src: string): string[] {
  const text = normalize(src)
  const anchor = /FROM\s+sale_order_performance_events\s+spe/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = anchor.exec(text)) !== null) {
    const start = text.lastIndexOf('SELECT', m.index)
    const after = m.index + m[0].length
    const groupBy = text.indexOf('GROUP BY', after)
    const tmplEnd = text.indexOf('`', after)
    const hasGroupBy = groupBy >= 0 && (tmplEnd < 0 || groupBy < tmplEnd)

    let end: number
    if (hasGroupBy) {
      const close = text.indexOf(')', groupBy)
      end = close >= 0 ? close + 1 : tmplEnd >= 0 ? tmplEnd : text.length
    } else {
      end = tmplEnd >= 0 ? tmplEnd : text.length
    }
    out.push(text.slice(start < 0 ? m.index : start, end).trim())
  }
  return out
}

describe('客量板块两端口径一致性守护', () => {
  let adminSrc: string
  let staffSrc: string
  let adminCode: string // 剥注释后

  beforeAll(() => {
    adminSrc = fs.readFileSync(ADMIN_CUSTOMER, 'utf-8')
    staffSrc = fs.readFileSync(STAFF_MGMT_TRAFFIC, 'utf-8')
    adminCode = normalize(stripComments(adminSrc))
  })

  describe('会员 / 新会员 = became_member_at（历史化）', () => {
    it('admin 用 became_member_at::date', () => {
      expect(adminSrc).toMatch(/became_member_at::date/)
    })
    it('staff 用 became_member_at::date', () => {
      expect(staffSrc).toMatch(/became_member_at::date/)
    })
    it('两端均含 became_member_at IS NOT NULL 守卫', () => {
      expect(adminSrc).toMatch(/became_member_at\s+IS\s+NOT\s+NULL/)
      expect(staffSrc).toMatch(/became_member_at\s+IS\s+NOT\s+NULL/)
    })
  })

  describe('customer_status 枚举 = 沉睡 / 冰冻 / 休眠（D-6 重命名后）', () => {
    it('admin 含三档字面量', () => {
      expect(adminCode).toMatch(/'沉睡'/)
      expect(adminCode).toMatch(/'冰冻'/)
      expect(adminCode).toMatch(/'休眠'/)
    })
    it('staff 含三档字面量', () => {
      const staffCode = normalize(stripComments(staffSrc))
      expect(staffCode).toMatch(/'沉睡'/)
      expect(staffCode).toMatch(/'冰冻'/)
      expect(staffCode).toMatch(/'休眠'/)
    })
    it('两端禁用旧枚举 预警沉睡（防回归）', () => {
      expect(adminCode).not.toMatch(/预警沉睡/)
      expect(normalize(stripComments(staffSrc))).not.toMatch(/预警沉睡/)
    })
    it('两端保有会员状态字面量一致（保有会员-稳定 / 保有会员-有效）', () => {
      expect(adminSrc).toMatch(/保有会员-稳定/)
      expect(adminSrc).toMatch(/保有会员-有效/)
      expect(staffSrc).toMatch(/保有会员-稳定/)
      expect(staffSrc).toMatch(/保有会员-有效/)
    })
  })

  describe('消费分桶阈值（左闭右开，6 档）', () => {
    const thresholds = ['1990', '10000', '30000', '60000', '100000']

    /**
     * ⚠ 必须带数字边界（GLM r4 P3-2）：裸的 `toContain('10000')` 恒真，
     * 因为 `100000` 里就含 `10000` —— 把 `< 10000` 整个删掉这条断言也不会红。
     */
    for (const [side, getSrc] of [
      ['admin', () => adminSrc],
      ['staff', () => staffSrc],
    ] as Array<[string, () => string]>) {
      it(`${side} 含全部 5 个阈值字面量（带数字边界）`, () => {
        for (const t of thresholds) {
          expect(getSrc(), `${side} 缺阈值 ${t}（或只作为更长数字的子串出现）`).toMatch(
            new RegExp(`(?<!\\d)${t}(?!\\d)`),
          )
        }
      })
    }

    /**
     * 分桶区间成对锁死。两端都必须有 —— GLM r4 指出 staff 此前只有 `toContain` 弱断言，
     * 把 `< 60000` 改成 `< 50000` 时 `'60000'` 仍被下一桶的 `>= 60000` 满足 → 全绿。
     */
    const PAIRS: Array<[string, RegExp]> = [
      ['[1990, 10000)', /spend\s*>=\s*1990\s+AND\s+spend\s*<\s*10000/g],
      ['[10000, 30000)', /spend\s*>=\s*10000\s+AND\s+spend\s*<\s*30000/g],
      ['[30000, 60000)', /spend\s*>=\s*30000\s+AND\s+spend\s*<\s*60000/g],
      ['[60000, 100000)', /spend\s*>=\s*60000\s+AND\s+spend\s*<\s*100000/g],
      ['[100000, ∞)', /spend\s*>=\s*100000/g],
      ['(-∞, 1990)', /spend\s*<\s*1990/g],
    ]

    /**
     * ⚠ 必须按**出现次数**断言，不能只判「存在」：
     * staff 每个区间写两遍（`bucketN_count` 的 `COUNT(*) FILTER` + `bucketN_spend` 的
     * `SUM(spend) FILTER`），只改其中一处时「存在」断言仍绿 —— 实测确认过这条漏网。
     * admin 每个区间只写一遍。
     */
    for (const [side, getCode, times] of [
      ['admin', () => adminCode, 1],
      ['staff', () => normalize(stripComments(staffSrc)), 2],
    ] as Array<[string, () => string, number]>) {
      it(`${side} 分桶区间为左闭右开（按出现次数锁死，防单处漂移）`, () => {
        for (const [label, re] of PAIRS) {
          const hits = getCode().match(re) ?? []
          expect(
            hits.length,
            `${side} 的分桶区间 ${label} 出现 ${hits.length} 次，期望 ${times} 次` +
              `（改了其中一处上/下界？${side === 'staff' ? 'count 与 spend 两处必须同改' : ''}）`,
          ).toBe(times)
        }
      })
    }

    /**
     * 「会员经营人数」（spend >= 1990 去重人数）的门槛必须与分桶同值。
     * 它落在 GROUP BY **之后**的外层投影里，不在块级快照射程内（GLM r4 P3-2），
     * 故单独锁一条；否则把 `>= 1990` 改成 `>= 199` 时，分桶断言仍由明细查询满足 → 全绿。
     *
     * ⚠ **仅 admin 有这条**：staff 的 `queryMemberOps` 只返回 6 个桶的 count/spend
     * （`bucket1_count` … `bucket6_count`），不产出「经营人数」聚合，由调用方按桶汇总。
     * 这是两端有意的产出差异，不是漏改 —— 两端的**分桶阈值**仍由上面的成对 regex 共同锁死。
     */
    it('admin「经营人数」门槛为 spend >= 1990（staff 无此聚合，见注释）', () => {
      // ⚠ 必须逐个 alias 锁：admin 有两处（KPI 的 `AS v` + 明细的 `AS operated_total`），
      // 只判「存在」时改掉其中一处，另一处仍满足正则 → 全绿（实测确认过这条漏网）。
      for (const alias of ['v', 'operated_total']) {
        expect(
          adminCode,
          `admin 的经营人数门槛（AS ${alias}）不是 FILTER (WHERE spend >= 1990)`,
        ).toMatch(new RegExp(`FILTER\\s*\\(\\s*WHERE\\s+spend\\s*>=\\s*1990\\s*\\)\\s+AS\\s+${alias}(?![A-Za-z0-9_])`))
      }
      expect(
        normalize(stripComments(staffSrc)),
        'staff 侧出现了经营人数聚合 —— 若这是有意新增，请同步本用例与两端出数对比',
      ).not.toMatch(/FILTER\s*\(\s*WHERE\s+spend\s*>=\s*1990\s*\)/)
    })

    it('admin 不复用 spending_tier 列（区间消费 ≠ lifetime 快照）', () => {
      expect(adminCode).not.toMatch(/spending_tier/)
    })
  })

  describe('项目数 = sales_category IN (自销自耗, 他销自耗)', () => {
    it('admin', () => {
      expect(adminSrc).toMatch(/sales_category\s+IN\s*\(\s*'自销自耗'\s*,\s*'他销自耗'\s*\)/)
    })
    it('staff', () => {
      expect(staffSrc).toMatch(/sales_category\s+IN\s*\(\s*'自销自耗'\s*,\s*'他销自耗'\s*\)/)
    })
  })

  describe('成交率分母 = 体验客 + 小美客（D-conv-denom=B）', () => {
    it('admin', () => {
      expect(adminSrc).toMatch(/customer_type\s+IN\s*\(\s*'体验客'\s*,\s*'小美客'\s*\)/)
    })
    it('staff', () => {
      expect(staffSrc).toMatch(/customer_type\s+IN\s*\(\s*'体验客'\s*,\s*'小美客'\s*\)/)
    })
  })

  /**
   * #138（2026-09-16）：spend 从「订单快照 `received - refunded_amount` @ `paid_at`」
   * 改为「已入账款项流水 `SUM(spe.amount)` @ `performance_date`」，与业绩 KPI 同源。
   *
   * 连带两个语义变化（都是有意的）：
   *   - **不再按父订单 status 过滤** —— 款项流水自带 status，部分支付订单的已到账款也计入
   *   - **排除储值卡抵扣** —— `change_type IN ('首次支付','回款','退款')`，与组织层级业绩一致
   *
   * 分桶阈值（1990 / 1w / 3w / 6w / 10w）不变。
   */
  describe('会员消费 spend = 已入账款项流水 @ 业绩归属日期（#138，两端同源）', () => {
    const SPEND_INVARIANTS: Array<[string, RegExp]> = [
      ['金额取款项流水', /SUM\(spe\.amount::numeric\)/],
      ['数据源是业绩事件视图', /FROM\s+sale_order_performance_events\s+spe/],
      ['JOIN 回订单表取 client_user_id', /JOIN\s+sale_orders\s+o\s+ON\s+o\.sale_order_id\s*=\s*spe\.sale_order_id/],
      ['订单类型限定', /spe\.sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/],
      ['款项状态已支付', /spe\.status\s*=\s*'已支付'/],
      ['排除储值卡抵扣', /spe\.change_type\s+IN\s*\(\s*'首次支付'\s*,\s*'回款'\s*,\s*'退款'\s*\)/],
      ['排除 workfine 历史单', /spe\.legacy_source\s+IS\s+DISTINCT\s+FROM\s+'workfine'/],
      ['日期走业绩归属日期', /spe\.performance_date\s+BETWEEN/],
    ]

    it.each(SPEND_INVARIANTS)('admin 侧：%s', (_label, re) => {
      expect(adminCode).toMatch(re)
    })

    it.each(SPEND_INVARIANTS)('staff 侧：%s', (_label, re) => {
      expect(normalize(stripComments(staffSrc))).toMatch(re)
    })

    /**
     * ⚠ 上面的 `toMatch` 只证明「文件里存在」，挡不住**单处漏改**：
     * admin 有 5 个会员消费查询（3 个 KPI + 2 个明细），staff 有 2 个。
     * 删掉其中一处的 `change_type` 过滤，其余几处仍满足正则 —— 实测确认过这条漏网。
     *
     * 这里按 `FROM sale_order_performance_events spe` 切块，**逐块**检查 WHERE 侧过滤：
     * 断言数随查询数自适应（用 `>=`，新增/合并查询不会在**本条**产生一堆假红），
     * 失败时能指出是第几个查询缺了哪一项。
     * 块尾截到 `GROUP BY` / 下一个查询，避免借用后文字符串造成假绿。
     *
     * ⚠ **本条是失败定位辅助，不是主守护**。它用剥过 JS 注释的文本 + 5 条独立正则，
     * 因此「把某行过滤注释掉」这类改动它**拦不住**（SQL 注释刻意不剥，原因见
     * `stripComments`）。真正拦下的是下方 `EXPECTED_SPE_BLOCKS` 块级逐字快照；
     * 本条的价值是在那条红掉之后，直接指出「第几个查询缺了哪一项」——
     * 快照断言只能告诉你「这一块不一样」，定位到具体哪一项要靠这里。
     *
     * 另两点澄清（GLM 评审 P3-3）：
     * 1. 「自适应」只限本条。「金额按出现次数锁死」与主守护都是精确 `toBe(5/2)`，
     *    新增 spe 查询仍会红在那里——那是有意的（防某处改回订单快照），需连同更新期望值。
     * 2. 截断标记 `SELECT\s+COALESCE` 对当前 5+2 块**从未实际命中**（全截在 GROUP BY 或 EOF），
     *    末块因此会借用后文文本。GLM 实测确认借用段不含任何 `spe.*` 引用
     *    （别名必须先有 FROM 才成立），**无假绿路径**，只是失败信息定位偏长。
     */
    it('每个会员消费查询块内的过滤都齐全（逐块定位辅助，防单处漏改）', () => {
      const WHERE_INVARIANTS: Array<[string, RegExp]> = [
        ['订单类型', /spe\.sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/],
        ['款项状态已支付', /spe\.status\s*=\s*'已支付'/],
        ['排除储值卡抵扣', /spe\.change_type\s+IN\s*\(\s*'首次支付'\s*,\s*'回款'\s*,\s*'退款'\s*\)/],
        ['排除 workfine', /spe\.legacy_source\s+IS\s+DISTINCT\s+FROM\s+'workfine'/],
        ['归属日期区间', /spe\.performance_date\s+BETWEEN/],
      ]
      const SITES: Array<[string, string, number]> = [
        ['admin', adminCode, 5],
        ['staff', normalize(stripComments(staffSrc)), 2],
      ]
      for (const [side, code, minBlocks] of SITES) {
        const blocks = code
          .split(/FROM\s+sale_order_performance_events\s+spe/)
          .slice(1)
          // 块尾截到 GROUP BY 或下一个 SELECT，避免借用后文内容假绿
          .map((b) => b.split(/GROUP BY|SELECT\s+COALESCE/)[0])
        expect(blocks.length, `${side} 的会员消费查询数少于预期（整块被删？）`)
          .toBeGreaterThanOrEqual(minBlocks)
        blocks.forEach((block, i) => {
          for (const [label, re] of WHERE_INVARIANTS) {
            expect(block, `${side} 第 ${i + 1} 个会员消费查询缺「${label}」`).toMatch(re)
          }
        })
      }
    })

    /**
     * **口径守护主力**（设计理由见 `EXPECTED_SPE_BLOCKS` 的说明）。
     *
     * 在**原文**（只归一化空白，不剥任何注释）上切出 7 个 spe 查询块，
     * 逐块与快照全等比较。这条一旦红，说明 JOIN 链或 WHERE 里有任何字符被动过 ——
     * 上方的逐块断言用来进一步告诉你「是第几个查询缺了哪一项」。
     */
    it('7 个 spe 查询块逐字快照（主守护，不依赖注释剥离）', () => {
      for (const [side, src] of [
        ['admin', adminSrc],
        ['staff', staffSrc],
      ] as Array<['admin' | 'staff', string]>) {
        const expectedBlocks = EXPECTED_SPE_BLOCKS[side]
        const blocks = splitSpeQueryBlocks(src)

        expect(
          blocks.length,
          `${side} 的 spe 查询块数为 ${blocks.length}，期望 ${expectedBlocks.length}。` +
            '整块被删、或新增了会员消费查询（后者需同步更新 EXPECTED_SPE_BLOCKS + 出数对比）。',
        ).toBe(expectedBlocks.length)

        blocks.forEach((block, i) => {
          expect(
            block,
            `${side} 第 ${i + 1} 个 spe 查询块与快照不符。\n` +
              '任何字符级改动都会命中这条：过滤被删/被注释、BETWEEN 实参被换、' +
              '加了 OR TRUE、顺序调换、插了别的条件。\n' +
              '确认是有意的口径变更后，同步更新 EXPECTED_SPE_BLOCKS、另一端副本，并重跑出数对比。',
          ).toBe(expectedBlocks[i])
        })
      }
    })

    /**
     * 上一条的**反向验证**：把四轮评审逐级打穿的每种绕过形态固化下来。
     *
     * ⚠ 关键在于这些变异是**注入真实源码后再走 `splitSpeQueryBlocks()`**的
     * （codex r4 指出：上一版只比较孤立字符串，提取或截断逻辑退化时这条用例自身仍会全绿，
     * 等于没验证到主守护）。现在提取逻辑一旦退化，这里就会红。
     *
     * 前几版守护（剥 SQL 注释 / 找关键字面量 / 连续子串 / 只锁 FROM..GROUP BY）对这些形态
     * 各有漏网，详见 `EXPECTED_SPE_BLOCKS` 的说明。
     */
    it('各种绕过形态注入源码后都会破坏块级逐字快照（反向验证主守护）', () => {
      const CHANGE_TYPE = "AND spe.change_type IN ('首次支付', '回款', '退款')"
      const ORDER_TYPE = "AND spe.sale_order_type IN ('销售单', '转换单')"
      const AMOUNT = 'SUM(spe.amount::numeric) AS spend'
      // ⚠ 必须带 `spe.performance_date` 前缀：裸的 `${range.start} AND ${range.end}`
      // 在源码里首次出现于 became_member_at 谓词（spe 块之外），replace 会打偏 →
      // 变异落在块外、块文本不变 → 用例误判成「未被拦下」。这条是本用例自己抓出来的。
      const RANGE = 'AND spe.performance_date BETWEEN ${range.start} AND ${range.end}'

      // 用例前提：这些锚点必须在源码里真实存在，否则 replace 静默失效 → 用例假绿
      for (const [label, anchor] of [
        ['change_type 过滤', CHANGE_TYPE],
        ['订单类型过滤', ORDER_TYPE],
        ['金额表达式', AMOUNT],
        ['区间实参', RANGE],
        ['分组键', 'GROUP BY o.client_user_id'],
      ] as Array<[string, string]>) {
        expect(adminSrc.includes(anchor), `用例前提失效：源码里找不到${label}「${anchor}」`).toBe(true)
      }

      const rep = (from: string, to: string) => adminSrc.replace(from, to)

      const BYPASS_ATTEMPTS: Array<[string, string]> = [
        // r1：最常见的维护动作，只剥 JS 注释时漏网
        ['行首 `-- ` 带空格', rep(CHANGE_TYPE, `-- ${CHANGE_TYPE}`)],
        // 自查：`--` 后不带空格同样是合法 PG 注释
        ['行首 `--` 无空格', rep(CHANGE_TYPE, `--${CHANGE_TYPE}`)],
        // r2 codex：token 紧贴 `--`，两版剥注释正则都拦不住
        ['token 紧贴 `--`', rep(`'已支付'`, `'已支付'--`)],
        // PG 块注释 / 嵌套块注释（非贪婪正则会在内层 */ 停下）
        ['块注释包裹', rep(CHANGE_TYPE, `/* ${CHANGE_TYPE} */`)],
        ['嵌套块注释', rep(CHANGE_TYPE, `/* outer /* nested */ ${CHANGE_TYPE} */`)],
        // r3 codex：注释掉**第一项** —— 连续子串版因串不含前导 AND 而完全漏网
        ['注释掉第一项过滤', rep(ORDER_TYPE, `-- ${ORDER_TYPE}`)],
        // r3 codex：BETWEEN 实参漂移 / OR 短路 —— 连续子串版止于 BETWEEN，同样漏网
        ['BETWEEN 起止同值', rep(RANGE, 'AND spe.performance_date BETWEEN ${range.start} AND ${range.start}')],
        ['BETWEEN 起止颠倒', rep(RANGE, 'AND spe.performance_date BETWEEN ${range.end} AND ${range.start}')],
        // ⚠ 同样要精确锚定到 spe 查询：裸的 `WHERE ${sc}` 在别的 KPI 查询里先出现
        [
          'OR TRUE 短路 WHERE',
          adminSrc.replace(
            /WHERE \$\{sc\}(\s+)AND spe\.sale_order_type/,
            'WHERE TRUE OR ${sc}$1AND spe.sale_order_type',
          ),
        ],
        // r4 codex：金额表达式被 clamp —— 块只从 FROM 起时完全漏网。
        // 这是**最可能真实发生**的一类（业务要求「不显示负数」）
        ['ABS 抹平退款净额', rep(AMOUNT, 'ABS(SUM(spe.amount::numeric)) AS spend')],
        ['GREATEST clamp', rep(AMOUNT, 'GREATEST(SUM(spe.amount::numeric), 0) AS spend')],
        // r4 GLM：聚合粒度从「人」变「店」；r4 codex：HAVING 归零 —— 截在 GROUP BY 前时都漏网
        ['改 GROUP BY 分组键', rep('GROUP BY o.client_user_id', 'GROUP BY o.store_id')],
        ['追加 HAVING FALSE', rep('GROUP BY o.client_user_id', 'GROUP BY o.client_user_id HAVING FALSE')],
        // 不是注释，但同样是口径漂移
        ['中间插入额外条件', rep(CHANGE_TYPE, `${CHANGE_TYPE} AND 1 = 1`)],
      ]

      const expected = EXPECTED_SPE_BLOCKS.admin
      for (const [label, mutatedSrc] of BYPASS_ATTEMPTS) {
        expect(mutatedSrc, `「${label}」构造无效：replace 未生效，用例本身失效`).not.toBe(adminSrc)

        const blocks = splitSpeQueryBlocks(mutatedSrc)
        const allMatch =
          blocks.length === expected.length && blocks.every((b, i) => b === expected[i])
        expect(
          allMatch,
          `「${label}」变异后 7 块仍逐字命中快照。两种可能：\n` +
            '① 主守护漏了这条路径（假绿复活）；\n' +
            '② 本用例的替换锚点没落在 spe 查询块内（构造错误，需把锚点写得更精确）。\n' +
            '先确认 ②：锚点在源码里的首次出现是否就在某个 spe 查询里。',
        ).toBe(false)
      }
    })

    /**
     * GLM r4 P3-3：改成 per-side 常量后，「两端五件套逐字一致」不再由构造保证
     * （旧版单一常量同时匹配两个文件，天然保证一致）。现在「单端改 SQL + 只更新本端常量」
     * 可以两端各自全绿 —— 这条把跨端一致性显式断言回来。
     */
    it('两端快照共享逐字相同的 WHERE 五件套（跨端一致性）', () => {
      const FIVE = [
        "spe.sale_order_type IN ('销售单', '转换单')",
        "spe.status = '已支付'",
        "spe.change_type IN ('首次支付', '回款', '退款')",
        "spe.legacy_source IS DISTINCT FROM 'workfine'",
        'spe.performance_date BETWEEN',
      ].join(' AND ')

      for (const side of ['admin', 'staff'] as const) {
        EXPECTED_SPE_BLOCKS[side].forEach((block, i) => {
          expect(
            block.includes(FIVE),
            `${side} 第 ${i + 1} 块的 WHERE 五件套与另一端不再逐字一致。\n` +
              '两端是镜像实现，五件套必须字字相同，否则同 scope 同区间会出数不一致。',
          ).toBe(true)
        })
      }
    })

    it('金额一律取款项流水（按出现次数锁死，防某处改回订单快照）', () => {
      for (const [side, code, expected] of [
        ['admin', adminCode, 5],
        ['staff', normalize(stripComments(staffSrc)), 2],
      ] as Array<[string, string, number]>) {
        const hits = code.match(/SUM\(spe\.amount::numeric\)/g) ?? []
        expect(hits.length, `${side} 的 SUM(spe.amount) 出现 ${hits.length} 次，期望 ${expected} 次`)
          .toBe(expected)
      }
    })

    it('两端都不得回退到订单快照口径', () => {
      for (const code of [adminCode, normalize(stripComments(staffSrc))]) {
        expect(code, 'spend 回退到 received - refunded_amount').not.toMatch(
          /received::numeric\s*-\s*COALESCE\(\s*o\.refunded_amount,\s*0\s*\)::numeric/i,
        )
        expect(code, '日期回退到 paid_at').not.toMatch(/o\.paid_at::date\s+BETWEEN/)
      }
    })

    it('两端禁用 paid_amount（已 DROP，防回归）', () => {
      expect(adminCode).not.toMatch(/paid_amount/)
      expect(normalize(stripComments(staffSrc))).not.toMatch(/paid_amount/)
    })
  })

  describe('市场明细人数在市场内去重', () => {
    it('会员消费先按分组 + 顾客聚合，再计算分桶', () => {
      expect(adminCode).toMatch(/group_skel\s+AS\s*\(/)
      expect(adminCode).toMatch(/member_spend\s+AS\s*\([\s\S]*?JOIN\s+skel\s+sk\s+ON\s+sk\.store_id\s*=\s*o\.store_id[\s\S]*?GROUP BY \$\{groupId\},\s*o\.client_user_id/i)
      expect(adminCode).toMatch(/spend_agg\s+AS\s*\([\s\S]*?GROUP BY\s+group_id/i)
    })

    it('流量客人数按分组 DISTINCT 顾客，不由门店人数求和', () => {
      expect(adminCode).toMatch(/traffic_cust\s+AS\s*\([\s\S]*?COUNT\(DISTINCT\s+so\.client_user_id\)\s+AS\s+traffic_customers[\s\S]*?GROUP BY \$\{groupId\}/i)
      expect(adminCode).not.toMatch(/SUM\(traffic_cust\.traffic_customers\)/i)
    })
  })

  describe('sale_order_type 过滤 = IN (销售单, 转换单)', () => {
    it('admin', () => {
      expect(adminSrc).toMatch(/sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/)
    })
    it('staff', () => {
      expect(staffSrc).toMatch(/sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/)
    })
  })

  describe('本月激活 anchor 反推关键字面量', () => {
    it('admin 含 visits_90d_prev + 6/12 months + 90 days', () => {
      expect(adminSrc).toMatch(/visits_90d_prev/)
      expect(adminSrc).toMatch(/INTERVAL\s+'6 months'/)
      expect(adminSrc).toMatch(/INTERVAL\s+'12 months'/)
      expect(adminSrc).toMatch(/INTERVAL\s+'90 days'/)
    })
    it('staff 含 visits_90d_prev + 6/12 months + 90 days', () => {
      expect(staffSrc).toMatch(/visits_90d_prev/)
      expect(staffSrc).toMatch(/INTERVAL\s+'6 months'/)
      expect(staffSrc).toMatch(/INTERVAL\s+'12 months'/)
      expect(staffSrc).toMatch(/INTERVAL\s+'90 days'/)
    })
    it('admin anchor 非保有判定 visits_90d_prev = 0', () => {
      expect(adminCode).toMatch(/visits_90d_prev\s*=\s*0/)
    })
  })

  describe('保有会员 = 90 天到店窗口 + became_member_at 守卫', () => {
    it('admin 含 90 days 窗口', () => {
      expect(adminCode).toMatch(/INTERVAL\s+'90 days'/)
    })
    it('staff 客流/保有走 service_orders + status 已完成', () => {
      expect(staffSrc).toMatch(/status\s*=\s*'已完成'/)
      expect(adminSrc).toMatch(/status\s*=\s*'已完成'/)
    })
  })

  describe('维护者提醒 — 漂移时双端对照', () => {
    it('admin 注释提及移植源 mgmt-traffic', () => {
      expect(adminSrc).toMatch(/mgmt-traffic/i)
    })
  })
})
