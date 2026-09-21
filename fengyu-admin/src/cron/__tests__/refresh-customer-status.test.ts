/**
 * STEP 1 — customer_status 三段式 SQL 形态测试（迁自 cronTask/__tests__/customer-status.test.js）
 *
 * 因为 STEP 1 是纯 SQL 三段式，没有 JS 分支可以单测，本文件聚焦于：
 *   1. 三段 SQL 形态：均带 customer_type='会员客' 守卫（除段1外，段1反向过滤非会员客）
 *   2. 段 1 SQL：非会员客 SET customer_status = NULL
 *   3. 段 2 SQL：UPDATE 限定 u.customer_type = '会员客'，含分类 CASE 与 90 天窗口
 *   4. 段 3 SQL：会员客无服务记录置 '休眠'
 *   5. 后置不变量：跑完后 COUNT(*) WHERE customer_type != '会员客' AND customer_status IS NOT NULL = 0
 *   6. #254 覆盖域穷举：对三段 WHERE 谓词建模后穷举全部输入组合，断言并集 = 全表。
 *      形态断言（1~5）只验 SQL 长什么样，验不出"漏没漏行"—— #254 就是这么溜过去的。
 */

import { describe, it, expect } from 'vitest'
// `@db/*` → `../db/schema/*`（tsconfig paths），所以是 @db/user 不是 @db/schema/user
import { clientWechatUsers } from '@db/user'
import {
  RESET_NON_MEMBER_STATUS_SQL,
  UPDATE_CUSTOMER_STATUS_SQL,
  RESET_NO_VISITS_SQL,
} from '../steps/refresh-customer-status'

describe('cron-worker STEP 1 — customer_status 三段式 SQL', () => {
  describe('段 1：非会员客一律置 NULL', () => {
    it('SQL 中 customer_status 被置 NULL', () => {
      expect(RESET_NON_MEMBER_STATUS_SQL).toMatch(/SET\s+customer_status\s*=\s*NULL/i)
    })

    it("WHERE 条件包含 customer_type != '会员客'", () => {
      expect(RESET_NON_MEMBER_STATUS_SQL).toMatch(/customer_type\s*!=\s*'会员客'/)
    })

    it('WHERE 同时要求 customer_status IS NOT NULL（避免无谓更新）', () => {
      expect(RESET_NON_MEMBER_STATUS_SQL).toMatch(/customer_status\s+IS\s+NOT\s+NULL/i)
    })

    it("段 1 SQL 不能写正向 customer_type = '会员客'", () => {
      expect(RESET_NON_MEMBER_STATUS_SQL).not.toMatch(/customer_type\s*=\s*'会员客'/)
    })
  })

  describe('段 2：会员客有到店记录的按规则分类', () => {
    it("UPDATE 子句必须带 u.customer_type = '会员客' 守卫", () => {
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(/u\.customer_type\s*=\s*'会员客'/)
    })

    it('CASE 分支 1：visits_90d>=1 + total_visits>=6 → 保有会员-稳定', () => {
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(
        /vs\.visits_90d\s*>=\s*1\s+AND\s+vs\.total_visits\s*>=\s*6\s+THEN\s+'保有会员-稳定'/,
      )
    })

    it('CASE 分支 2：visits_90d>=1 + total_visits<=5 → 保有会员-有效', () => {
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(
        /vs\.visits_90d\s*>=\s*1\s+AND\s+vs\.total_visits\s*<=\s*5\s+THEN\s+'保有会员-有效'/,
      )
    })

    it('CASE 分支 3：last_service_date >= 6 个月前 → 沉睡', () => {
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(
        /last_service_date\s*>=\s*CURRENT_DATE\s*-\s*INTERVAL\s*'6 months'\s+THEN\s+'沉睡'/,
      )
    })

    it('CASE 分支 4：last_service_date >= 12 个月前 → 冰冻', () => {
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(
        /last_service_date\s*>=\s*CURRENT_DATE\s*-\s*INTERVAL\s*'12 months'\s+THEN\s+'冰冻'/,
      )
    })

    it('CASE ELSE → 休眠', () => {
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(/ELSE\s+'休眠'/)
    })

    it("visit_stats CTE 仅统计 status='已完成' 服务单", () => {
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(/so\.status\s*=\s*'已完成'/)
    })

    it('visits_90d 使用 90 天窗口（不是 3 个月）', () => {
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(/INTERVAL\s*'90 days'/)
      expect(UPDATE_CUSTOMER_STATUS_SQL).not.toMatch(/INTERVAL\s*'3 months'/)
    })
  })

  describe('段 3：会员客无服务记录置休眠', () => {
    it("WHERE 必须带 u.customer_type = '会员客' 守卫", () => {
      expect(RESET_NO_VISITS_SQL).toMatch(/u\.customer_type\s*=\s*'会员客'/)
    })

    it("SET customer_status = '休眠'", () => {
      expect(RESET_NO_VISITS_SQL).toMatch(/SET\s+customer_status\s*=\s*'休眠'/)
    })

    it('NOT EXISTS 子查询过滤已完成服务单', () => {
      expect(RESET_NO_VISITS_SQL).toMatch(/NOT\s+EXISTS/i)
      expect(RESET_NO_VISITS_SQL).toMatch(/so\.status\s*=\s*'已完成'/)
    })

    it('段 3 守卫用 IS DISTINCT FROM 休眠，而非 IS NULL（#254 覆盖缺口）', () => {
      expect(RESET_NO_VISITS_SQL).toMatch(
        /u\.customer_status\s+IS\s+DISTINCT\s+FROM\s+'休眠'::customer_status/i,
      )
      // IS NULL 会把「段 2 没分到 且 已有旧值」误判成不需要处理，三段拼不全
      expect(RESET_NO_VISITS_SQL).not.toMatch(/u\.customer_status\s+IS\s+NULL/i)
    })

    /**
     * 枚举重命名防线：本仓做过一次 `ALTER TYPE customer_status RENAME VALUE '预警沉睡' → '沉睡'`。
     * 段 3 里 '休眠' 出现两处（SET 与守卫）。只改 SET 漏改守卫**不会报错**，而是让守卫恒真 ——
     * 段 3 每天重写全部无单会员客、updated_at 日日 churn、resetNoVisit 永不归零。
     * 这是静默劣化，比两处都漏改（22P02 当场炸）更坏，所以单独钉一条。
     */
    it('SET 与守卫的「休眠」字面量必须一致（防枚举重命名只改一半）', () => {
      const setLiteral = RESET_NO_VISITS_SQL.match(
        /SET\s+customer_status\s*=\s*'([^']+)'::customer_status/,
      )?.[1]
      const guardLiteral = RESET_NO_VISITS_SQL.match(
        /customer_status\s+IS\s+DISTINCT\s+FROM\s+'([^']+)'::customer_status/,
      )?.[1]
      expect(setLiteral).toBeDefined()
      expect(guardLiteral).toBeDefined()
      expect(guardLiteral).toBe(setLiteral)
    })
  })

  /**
   * #254 回归：**在单一快照下，每一行要么被某段命中，要么现值已等于应然值**。
   * （注意不是「三段命中域并集 = 全表」—— 已处于应然值的行本就不该被重写，
   * 那是守卫在省 updated_at churn；下面的断言验的正是前者。）
   *
   * 上面的正则断言只验"SQL 长什么样"，验不出"漏没漏行"。这里对三段的 WHERE 谓词建模，
   * 穷举 (customer_type, 有无已完成服务单, customer_status 旧值) 的组合，断言
   * 「每一行至少被一段命中，且命中后落到正确的目标值」——这是 #254 缺陷唯一能被测出的形态。
   *
   * ⚠️ 本模型的两条前提，不成立时结论也不成立：
   * 1. **单一快照**。真 SQL 三段是 READ COMMITTED 下串行执行、各取一次新快照，
   *    段间并发写 service_orders 会造成瞬时偏差（次日重跑自愈，见 steps 文件头注释）。
   * 2. **`customer_type` NOT NULL**。段 1 用 `!= '会员客'`，若该列可为 NULL，
   *    `NULL != '会员客'` 为 NULL → 段 1 不命中、段 2/3 的 `= '会员客'` 也不命中 → 三值逻辑漏判。
   *    下面 `前提绑定` 用 schema 断言钉住它。
   *
   * ⚠️⚠️ 这是对 SQL 的**手工 JS 重新建模**，和真 SQL 没有机械耦合 —— 改了 SQL 忘改模型，
   * 穷举照样全绿。所以下面第一条用 inline snapshot 锁住三段 SQL 全文：
   * 任何 WHERE 变更都会让 snapshot 变红，强制改的人回来看一眼模型。
   */
  describe('#254 覆盖域穷举：单一快照下无「该改却没人碰」的行', () => {
    it('前提绑定：customer_type 必须是 NOT NULL（段 1 的三值逻辑安全性依赖它）', () => {
      expect(clientWechatUsers.customerType.notNull).toBe(true)
    })

    it('SQL 全文快照 —— 变红说明 SQL 改了，请同步下面的 seg*Hits 模型', () => {
      expect({
        seg1: RESET_NON_MEMBER_STATUS_SQL,
        seg2: UPDATE_CUSTOMER_STATUS_SQL,
        seg3: RESET_NO_VISITS_SQL,
      }).toMatchSnapshot()
    })

    type Row = {
      customerType: '会员客' | '流量客' | '体验客' | '小美客'
      hasCompletedService: boolean
      /** null 表示 customer_status IS NULL */
      status: string | null
    }

    /** 段 1：customer_status IS NOT NULL AND customer_type != '会员客' → NULL */
    const seg1Hits = (r: Row) => r.status !== null && r.customerType !== '会员客'

    /** 段 2：join visit_stats（等价于有已完成服务单）AND customer_type = '会员客' → CASE 分类 */
    const seg2Hits = (r: Row) => r.hasCompletedService && r.customerType === '会员客'

    /**
     * 段 3（修复后）：会员客 AND status IS DISTINCT FROM '休眠' AND NOT EXISTS(已完成服务单)
     * 注意 NULL IS DISTINCT FROM '休眠' 为 true —— 原 IS NULL 行依然命中。
     */
    const seg3Hits = (r: Row) =>
      r.customerType === '会员客' && r.status !== '休眠' && !r.hasCompletedService

    /** 缺陷版段 3（IS NULL），仅用于证明它确实漏行 */
    const seg3HitsBuggy = (r: Row) =>
      r.customerType === '会员客' && r.status === null && !r.hasCompletedService

    /** 该行跑完三段后 customer_status 的应然值；null = 应为 NULL */
    function expectedStatus(r: Row): string | null | '按CASE分类' {
      if (r.customerType !== '会员客') return null
      if (r.hasCompletedService) return '按CASE分类'
      return '休眠'
    }

    const TYPES: Row['customerType'][] = ['会员客', '流量客', '体验客', '小美客']
    const STATUSES: Row['status'][] = [
      null,
      '休眠',
      '保有会员-有效',
      '保有会员-稳定',
      '沉睡',
      '冰冻',
    ]

    const ALL_ROWS: Row[] = TYPES.flatMap((customerType) =>
      [true, false].flatMap((hasCompletedService) =>
        STATUSES.map((status) => ({ customerType, hasCompletedService, status })),
      ),
    )

    it('每一行要么被某段命中，要么现值已等于应然值（无漏网）', () => {
      const missed = ALL_ROWS.filter((r) => {
        if (seg1Hits(r) || seg2Hits(r) || seg3Hits(r)) return false
        // 未被任何段命中 → 现值必须已经等于应然值，否则就是永久卡住的脏行
        const want = expectedStatus(r)
        return want !== '按CASE分类' && r.status !== want
      })
      expect(missed).toEqual([])
    })

    it('缺陷版（IS NULL）会漏掉「会员客 ∧ 无已完成服务单 ∧ 已有非 NULL 旧值」', () => {
      const missedByBug = ALL_ROWS.filter((r) => {
        if (seg1Hits(r) || seg2Hits(r) || seg3HitsBuggy(r)) return false
        const want = expectedStatus(r)
        return want !== '按CASE分类' && r.status !== want
      })
      // prod 2026-09-22 实际命中的就是这一类（「保有会员-有效」+ 零服务单）
      expect(missedByBug.length).toBeGreaterThan(0)
      expect(missedByBug.every((r) => r.customerType === '会员客')).toBe(true)
      expect(missedByBug.every((r) => !r.hasCompletedService)).toBe(true)
      expect(missedByBug.every((r) => r.status !== null && r.status !== '休眠')).toBe(true)
      // 修复版把这批全接住了
      expect(missedByBug.every((r) => seg3Hits(r))).toBe(true)
    })

    it('段 2 与段 3 的命中域互斥（不会同一行写两次）', () => {
      const both = ALL_ROWS.filter((r) => seg2Hits(r) && seg3Hits(r))
      expect(both).toEqual([])
    })

    /**
     * 段 1 先写、段 3 后读同一列，所以「段 1 与段 3 不重叠」是模型能把三段当独立谓词的前提。
     * 靠的是 customer_type 守卫方向相反（段 1 反向 != / 段 3 正向 =）。
     */
    it('段 1 与段 3 的命中域互斥（段 1 的写入不会喂给段 3）', () => {
      const both = ALL_ROWS.filter((r) => seg1Hits(r) && seg3Hits(r))
      expect(both).toEqual([])
    })

    it('段 1 与段 2 的命中域互斥', () => {
      const both = ALL_ROWS.filter((r) => seg1Hits(r) && seg2Hits(r))
      expect(both).toEqual([])
    })

    it('段 3 不重写已经是「休眠」的行（避免无谓 updated_at churn）', () => {
      const alreadyDormant = ALL_ROWS.filter(
        (r) => r.customerType === '会员客' && !r.hasCompletedService && r.status === '休眠',
      )
      expect(alreadyDormant.length).toBeGreaterThan(0)
      expect(alreadyDormant.some((r) => seg3Hits(r))).toBe(false)
    })

    it('段 3 不碰非会员客（那是段 1 的活）', () => {
      const nonMemberHitBySeg3 = ALL_ROWS.filter((r) => r.customerType !== '会员客' && seg3Hits(r))
      expect(nonMemberHitBySeg3).toEqual([])
    })
  })

  describe('整体不变量', () => {
    it('段 2 与段 3 都不会写非会员客', () => {
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(/customer_type\s*=\s*'会员客'/)
      expect(RESET_NO_VISITS_SQL).toMatch(/customer_type\s*=\s*'会员客'/)
    })

    it('段 1 + 段 2 + 段 3：跑完后非会员客 customer_status 必为 NULL', () => {
      expect(RESET_NON_MEMBER_STATUS_SQL).toMatch(/SET\s+customer_status\s*=\s*NULL/i)
      expect(RESET_NON_MEMBER_STATUS_SQL).toMatch(/customer_type\s*!=\s*'会员客'/)
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(/u\.customer_type\s*=\s*'会员客'/)
      expect(RESET_NO_VISITS_SQL).toMatch(/u\.customer_type\s*=\s*'会员客'/)
    })

    it('段 2/段 3 不能写 != 会员客（防误反向）', () => {
      expect(UPDATE_CUSTOMER_STATUS_SQL).not.toMatch(/customer_type\s*!=\s*'会员客'/)
      expect(RESET_NO_VISITS_SQL).not.toMatch(/customer_type\s*!=\s*'会员客'/)
    })
  })
})
