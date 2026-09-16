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
 * 因此口径守护的**主力**改为下方 `EXPECTED_SPE_WHERE` 连续子串快照：
 * 任何注释字符插进五件套中间都会破坏连续性，无需先识别它是不是注释。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/**
 * **口径守护主力**：会员消费查询的 WHERE 五件套，归一化后必须是这段**连续**文本。
 *
 * 为什么连续子串比「5 条独立正则 + 剥注释」强：
 *   - 注释掉其中一行 → 注释起始符插进串中间 → 不匹配 → 红。**不依赖识别注释**，
 *     `-- AND` / `--AND` / `TRUE--AND` / 块注释包裹 / 嵌套块注释一视同仁全部拦下
 *   - 中间插入额外条件、调换顺序、改写任一 token → 同样破坏连续性
 *   - 配合精确计数（admin 5 / staff 2），单处漏改会让计数掉到 4 或 1 → 红
 *
 * ⚠ 不含前导 `AND`：KPI 查询由 `${sc}` 起头故写 `AND spe.sale_order_type ...`，
 * 而门店/市场明细查询无 scope 条件、直接 `WHERE spe.sale_order_type ...`。
 * 两种引导词都包含这段串，五件套之间的 4 个 `AND` 连接仍被逐字锁死。
 *
 * ⚠ 截到 `BETWEEN` 为止：其后的区间插值两端不同（admin `${range.start}` /
 * staff `${startDateExpr(period)}`），且明细查询用 `${start}`。
 *
 * 改这段常量 = 改口径，必须同步两端 + 更新出数对比。
 */
const EXPECTED_SPE_WHERE =
  "spe.sale_order_type IN ('销售单', '转换单') " +
  "AND spe.status = '已支付' " +
  "AND spe.change_type IN ('首次支付', '回款', '退款') " +
  "AND spe.legacy_source IS DISTINCT FROM 'workfine' " +
  'AND spe.performance_date BETWEEN'

/** 数 needle 在 haystack 中的不重叠出现次数 */
function countOccurrences(haystack: string, needle: string): number {
  let n = 0
  let i = 0
  while ((i = haystack.indexOf(needle, i)) >= 0) {
    n++
    i += needle.length
  }
  return n
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
    it('admin 含全部 5 个阈值字面量', () => {
      for (const t of thresholds) {
        expect(adminSrc).toContain(t)
      }
    })
    it('staff 含全部 5 个阈值字面量', () => {
      for (const t of thresholds) {
        expect(staffSrc).toContain(t)
      }
    })
    it('admin 分桶区间为左闭右开（spend >= 1990 AND spend < 10000 模式）', () => {
      expect(adminCode).toMatch(/spend\s*>=\s*1990\s+AND\s+spend\s*<\s*10000/)
      expect(adminCode).toMatch(/spend\s*>=\s*10000\s+AND\s+spend\s*<\s*30000/)
      expect(adminCode).toMatch(/spend\s*>=\s*30000\s+AND\s+spend\s*<\s*60000/)
      expect(adminCode).toMatch(/spend\s*>=\s*60000\s+AND\s+spend\s*<\s*100000/)
      expect(adminCode).toMatch(/spend\s*>=\s*100000/)
      expect(adminCode).toMatch(/spend\s*<\s*1990/)
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
     * `stripComments`）。真正拦下的是下方 `EXPECTED_SPE_WHERE` 连续串 + 精确计数；
     * 本条的价值是在那条红掉之后，直接指出「第几个查询缺了哪一项」。
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
     * **口径守护主力**（见 `EXPECTED_SPE_WHERE` 的说明）。
     *
     * 断言 WHERE 五件套在**原文**（只归一化空白，不剥任何注释）里恰好出现
     * admin 5 次 / staff 2 次。这条一旦红，说明有人动了过滤条件本身 ——
     * 上方的逐块断言只是用来告诉你「是第几个查询缺了哪一项」。
     */
    it('WHERE 五件套逐字连续 + 精确计数（主守护，不依赖注释剥离）', () => {
      for (const [side, src, expected] of [
        ['admin', adminSrc, 5],
        ['staff', staffSrc, 2],
      ] as Array<[string, string, number]>) {
        const got = countOccurrences(normalize(src), EXPECTED_SPE_WHERE)
        expect(
          got,
          `${side} 的 WHERE 五件套连续串出现 ${got} 次，期望 ${expected} 次。\n` +
            '可能原因：某处过滤被删/被注释掉、顺序被调换、中间插了别的条件，' +
            '或新增/删除了会员消费查询（后者需同步更新期望值 + 出数对比）。',
        ).toBe(expected)
      }
    })

    /**
     * 上一条的**反向验证**：确认它真能拦下各种「注释掉一行过滤」的写法。
     *
     * 两轮评审逐个打穿了「用正则剥 SQL 注释」的每种补法（见 `stripComments` 的说明），
     * 这里固化其中每一种绕过形态 —— 连续子串对它们一视同仁，因为**不需要**先判断
     * 那是不是注释，只要有字符插进五件套中间就破坏连续性。
     */
    it('各种 SQL 注释形态都会破坏五件套连续性（反向验证主守护）', () => {
      const intact = EXPECTED_SPE_WHERE
      expect(countOccurrences(normalize(intact), EXPECTED_SPE_WHERE), '基线自身应匹配').toBe(1)

      const BYPASS_ATTEMPTS: Array<[string, string]> = [
        // codex round-1 指出的原始路径
        ['行首 `-- ` 带空格', "spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付'\n-- AND spe.change_type IN ('首次支付', '回款', '退款')\nAND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN"],
        // 我自查发现的后门
        ['行首 `--` 无空格', "spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付'\n--AND spe.change_type IN ('首次支付', '回款', '退款')\nAND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN"],
        // codex round-2 指出的：token 紧贴 `--`，两版正则都拦不住
        ['token 紧贴 `--`', "spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付'--AND spe.change_type IN ('首次支付', '回款', '退款')\nAND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN"],
        // PG 块注释
        ['块注释包裹', "spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' /* AND spe.change_type IN ('首次支付', '回款', '退款') */ AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN"],
        // PG 特性：嵌套块注释，非贪婪正则会在内层 */ 停下
        ['嵌套块注释', "spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' /* outer /* nested */ AND spe.change_type IN ('首次支付', '回款', '退款') */ AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN"],
        // 不是注释，但同样是口径漂移
        ['中间插入额外条件', "spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND 1 = 1 AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN"],
        ['调换顺序', "spe.sale_order_type IN ('销售单', '转换单') AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.status = '已支付' AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN"],
      ]

      for (const [label, mutated] of BYPASS_ATTEMPTS) {
        expect(
          countOccurrences(normalize(mutated), EXPECTED_SPE_WHERE),
          `「${label}」未被主守护拦下 —— 连续子串仍匹配，假绿路径复活`,
        ).toBe(0)
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
