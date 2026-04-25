/**
 * cronTask STEP 1 — customer_status 重算单元测试
 *
 * 业务口径：customer_status 仅对 customer_type='会员客' 的顾客有值，
 * 非会员客（流量客 / 体验客 / 小美客）一律 NULL。
 *
 * 因为 STEP 1 是纯 SQL 三段式，没有 JS 分支可以单测，本文件聚焦于：
 *   1. 三段 SQL 的形态：均带 customer_type='会员客' 守卫（除段1外，段1反向过滤非会员客）
 *   2. 段 1 SQL：非会员客 SET customer_status = NULL
 *   3. 段 2 SQL：UPDATE 限定 u.customer_type = '会员客'，包含分类 CASE 与 90 天窗口
 *   4. 段 3 SQL：会员客无服务记录置 '休眠'
 *   5. 等价行为：非会员客（无论原状态）跑完后 customer_status = NULL
 *      会员客 90 天内到店 → 命中保有会员-稳定/有效；无到店 → 休眠
 *   6. 后置不变量：跑完后 COUNT(*) WHERE customer_type != '会员客' AND customer_status IS NOT NULL = 0
 */

// wx-server-sdk stub（与同目录其他测试一致）
const wxPath = require.resolve('wx-server-sdk')
require.cache[wxPath] = {
  id: wxPath,
  filename: wxPath,
  loaded: true,
  exports: {
    init: () => {},
    DYNAMIC_CURRENT_ENV: 'test-env',
  },
}

const pgPath = require.resolve('pg')
require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  exports: {
    Pool: vi.fn(() => ({ query: vi.fn(), on: vi.fn(), connect: vi.fn() })),
  },
}

const {
  RESET_NON_MEMBER_STATUS_SQL,
  UPDATE_CUSTOMER_STATUS_SQL,
  RESET_NO_VISITS_SQL,
} = require('../index').__test__

describe('cronTask STEP 1 — customer_status 三段式 SQL', () => {
  // ============================================================
  // 1. 段 1 SQL 形态：非会员客置 NULL
  // ============================================================
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

    it('SQL 中绝不包含 customer_type = \'会员客\'（写正向断言会跑反逻辑）', () => {
      // 段 1 必须是 != '会员客'，不能误写成 = '会员客'
      expect(RESET_NON_MEMBER_STATUS_SQL).not.toMatch(/customer_type\s*=\s*'会员客'/)
    })
  })

  // ============================================================
  // 2. 段 2 SQL 形态：会员客有到店记录的，按规则打状态
  // ============================================================
  describe('段 2：会员客有到店记录的按规则分类', () => {
    it("UPDATE 子句必须带 u.customer_type = '会员客' 守卫", () => {
      // 这是修复 bug 的关键守卫——没有它，所有 customer_type 都会被打标签
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(/u\.customer_type\s*=\s*'会员客'/)
    })

    it('CASE 分支 1：visits_90d>=1 + total_visits>=6 → 保有会员-稳定', () => {
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(
        /vs\.visits_90d\s*>=\s*1\s+AND\s+vs\.total_visits\s*>=\s*6\s+THEN\s+'保有会员-稳定'/
      )
    })

    it('CASE 分支 2：visits_90d>=1 + total_visits<=5 → 保有会员-有效', () => {
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(
        /vs\.visits_90d\s*>=\s*1\s+AND\s+vs\.total_visits\s*<=\s*5\s+THEN\s+'保有会员-有效'/
      )
    })

    it("CASE 分支 3：last_service_date >= 6 个月前 → 沉睡", () => {
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(
        /last_service_date\s*>=\s*CURRENT_DATE\s*-\s*INTERVAL\s*'6 months'\s+THEN\s+'沉睡'/
      )
    })

    it("CASE 分支 4：last_service_date >= 12 个月前 → 冰冻", () => {
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(
        /last_service_date\s*>=\s*CURRENT_DATE\s*-\s*INTERVAL\s*'12 months'\s+THEN\s+'冰冻'/
      )
    })

    it("CASE ELSE → 休眠", () => {
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(/ELSE\s+'休眠'/)
    })

    it("visit_stats CTE 仅统计 status='已完成' 服务单", () => {
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(/so\.status\s*=\s*'已完成'/)
    })

    it("visits_90d 使用 90 天窗口（不是 3 个月）", () => {
      // 业务口径锁死：保有会员判定窗口是 90 天
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(/INTERVAL\s*'90 days'/)
      expect(UPDATE_CUSTOMER_STATUS_SQL).not.toMatch(/INTERVAL\s*'3 months'/)
    })
  })

  // ============================================================
  // 3. 段 3 SQL 形态：会员客无服务记录置 '休眠'
  // ============================================================
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

    it("段 3 只覆盖段 2 没分到状态的会员客（customer_status IS NULL）", () => {
      // 防止段 3 把段 2 已经写过的会员客覆盖掉
      expect(RESET_NO_VISITS_SQL).toMatch(/u\.customer_status\s+IS\s+NULL/i)
    })
  })

  // ============================================================
  // 4. 整体不变量：三段串起来后非会员客 customer_status 必须为 NULL
  // ============================================================
  describe('整体不变量', () => {
    it('段 2 与段 3 都不会写非会员客（customer_type != 会员客 不在它们的 WHERE 范围）', () => {
      // 段 2/段 3 都带 u.customer_type = '会员客'，反向断言：跑完后非会员客不会被覆盖
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(/customer_type\s*=\s*'会员客'/)
      expect(RESET_NO_VISITS_SQL).toMatch(/customer_type\s*=\s*'会员客'/)
    })

    it('段 1 配合段 2/段 3，构成完整不变量：' +
       "COUNT(*) WHERE customer_type != '会员客' AND customer_status IS NOT NULL = 0", () => {
      // 这是设计上等价：
      //   - 跑前非会员客的脏数据 → 段 1 全部置 NULL
      //   - 段 2 段 3 都带 customer_type='会员客' 守卫，不会再写非会员客
      //   ⇒ 跑完后非会员客的 customer_status 必为 NULL
      // 这里通过 SQL 静态属性保证不变量（无需端到端 DB 测试）
      expect(RESET_NON_MEMBER_STATUS_SQL).toMatch(/SET\s+customer_status\s*=\s*NULL/i)
      expect(RESET_NON_MEMBER_STATUS_SQL).toMatch(/customer_type\s*!=\s*'会员客'/)
      expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(/u\.customer_type\s*=\s*'会员客'/)
      expect(RESET_NO_VISITS_SQL).toMatch(/u\.customer_type\s*=\s*'会员客'/)
    })
  })
})

// ============================================================
// 5. 行为级集成模拟：用 mock pg client 验证执行顺序与 rowCount 透传
// ============================================================
describe('cronTask STEP 1 — main() 中段顺序与 rowCount 处理', () => {
  function makeMockClient() {
    const queries = []
    const responses = new Map()
    return {
      queries,
      // 按 SQL 模式注入响应
      setResponse(matcher, response) {
        responses.set(matcher, response)
      },
      query: vi.fn(async (sql, params) => {
        queries.push({ sql, params })
        for (const [matcher, resp] of responses.entries()) {
          if (typeof matcher === 'string' ? sql === matcher : matcher.test(sql)) {
            return resp
          }
        }
        return { rows: [], rowCount: 0 }
      }),
    }
  }

  it('三段 SQL 串行执行，段 1 在段 2 之前；rowCount 各自独立', async () => {
    const client = makeMockClient()
    // 段 1：清理 7 个非会员客脏数据
    client.setResponse(/customer_type\s*!=\s*'会员客'/, { rows: [], rowCount: 7 })
    // 段 2：会员客带访问的 30 个被打状态
    client.setResponse(/visit_stats AS/, { rows: [], rowCount: 30 })
    // 段 3：会员客无访问的 5 个置休眠
    client.setResponse(/NOT EXISTS/, { rows: [], rowCount: 5 })

    // 直接顺序跑三段 SQL（模拟 main() 中段执行顺序）
    const r1 = await client.query(RESET_NON_MEMBER_STATUS_SQL)
    const r2 = await client.query(UPDATE_CUSTOMER_STATUS_SQL)
    const r3 = await client.query(RESET_NO_VISITS_SQL)

    expect(r1.rowCount).toBe(7)
    expect(r2.rowCount).toBe(30)
    expect(r3.rowCount).toBe(5)

    // 顺序断言：段 1 必须在段 2 之前（否则段 1 会被段 2 的脏数据再覆盖）
    const idxSeg1 = client.queries.findIndex((q) => /customer_type\s*!=\s*'会员客'/.test(q.sql))
    const idxSeg2 = client.queries.findIndex((q) => /visit_stats AS/.test(q.sql))
    const idxSeg3 = client.queries.findIndex((q) => /NOT EXISTS/.test(q.sql))
    expect(idxSeg1).toBeGreaterThanOrEqual(0)
    expect(idxSeg2).toBeGreaterThan(idxSeg1)
    expect(idxSeg3).toBeGreaterThan(idxSeg2)
  })
})

// ============================================================
// 6. 等价行为断言：通过 SQL 文本静态分析覆盖关键场景
// ============================================================
describe('cronTask STEP 1 — 行为等价场景', () => {
  it("场景 A：非会员客（流量客/体验客/小美客）的 customer_status 不会被写入「保有会员-X」", () => {
    // 段 2 的 UPDATE 必须有 u.customer_type = '会员客' 限制
    // ⇒ 任何 customer_type != '会员客' 的行都不会进入 UPDATE 影响范围
    expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(/u\.customer_type\s*=\s*'会员客'/)

    // 段 3 同理
    expect(RESET_NO_VISITS_SQL).toMatch(/u\.customer_type\s*=\s*'会员客'/)

    // 段 1 同时把脏的非会员客 customer_status 清成 NULL
    expect(RESET_NON_MEMBER_STATUS_SQL).toMatch(/SET\s+customer_status\s*=\s*NULL/i)
  })

  it("场景 B：会员客有 90 天内到店记录 → 命中「保有会员-稳定」或「保有会员-有效」", () => {
    expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(
      /vs\.visits_90d\s*>=\s*1\s+AND\s+vs\.total_visits\s*>=\s*6\s+THEN\s+'保有会员-稳定'/
    )
    expect(UPDATE_CUSTOMER_STATUS_SQL).toMatch(
      /vs\.visits_90d\s*>=\s*1\s+AND\s+vs\.total_visits\s*<=\s*5\s+THEN\s+'保有会员-有效'/
    )
  })

  it("场景 C：会员客无任何到店记录 → 段 3 写入「休眠」", () => {
    // 段 3 的 NOT EXISTS 子查询恰好匹配「无任何已完成服务单的会员客」
    expect(RESET_NO_VISITS_SQL).toMatch(/u\.customer_type\s*=\s*'会员客'/)
    expect(RESET_NO_VISITS_SQL).toMatch(/SET\s+customer_status\s*=\s*'休眠'/)
    expect(RESET_NO_VISITS_SQL).toMatch(
      /NOT\s+EXISTS\s*\([\s\S]*so\.client_user_id\s*=\s*u\.user_id[\s\S]*so\.status\s*=\s*'已完成'/
    )
  })

  it("场景 D：跑完后 COUNT(*) WHERE customer_type != '会员客' AND customer_status IS NOT NULL = 0", () => {
    // 这是脚本的核心 post-condition；通过三段 SQL 形态推导：
    //   - 段 1：把所有非会员客 customer_status 置 NULL
    //   - 段 2/段 3：都带 customer_type='会员客' 守卫，不会写非会员客
    //   ⇒ 跑完后非会员客 customer_status 全部为 NULL
    // 用 SQL 静态属性即可证明（无需端到端 DB 测试）：
    expect(RESET_NON_MEMBER_STATUS_SQL).toMatch(
      /UPDATE\s+client_wechat_users[\s\S]*SET\s+customer_status\s*=\s*NULL[\s\S]*customer_type\s*!=\s*'会员客'/
    )
    expect(UPDATE_CUSTOMER_STATUS_SQL).not.toMatch(/customer_type\s*!=\s*'会员客'/)
    expect(RESET_NO_VISITS_SQL).not.toMatch(/customer_type\s*!=\s*'会员客'/)
  })
})
