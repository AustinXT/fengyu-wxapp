/**
 * getOperatingMaster（#372）装配与 SQL 形态单测。
 *
 * db.execute 被 mock，但 drizzle 的 sql 模板是真的：用 PgDialect 把每条查询编译成 SQL 文本 + 参数，
 * 直接断言「编译后发往 PG 的东西」——口径谓词本身与销售板的逐字一致由 consistency.operating-master 守护。
 *
 * 查询顺序（Promise.all 位置）：0 骨架 / 1 美容师 / 2 P 当月 / 3 R 年度 / 4 V 生美项目数 / 5 W 实耗 / 6 X 生美实耗 /
 * 7 E·F·H 保有会员与回店 / 8 K·L 被经营年度与当月 / 9 S·T 到店天数（#373）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

const { mockExecute, mockValidateScope } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockValidateScope: vi.fn(),
}))

vi.mock('@/db', () => ({ db: { execute: mockExecute } }))
vi.mock('@/lib/member-threshold', () => ({ getMemberThreshold: vi.fn(async () => 1990) }))
vi.mock('@/lib/with-permission', () => ({
  withPermission: (_action: string, fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => fn({ employeeId: 'E1', roles: [], permissions: { actions: [], scopeStoreIds: [] } }, ...args),
}))
vi.mock('@/lib/permissions', () => ({ isAdminScope: () => true }))
vi.mock('@/lib/data-center/context', () => ({
  validateScope: mockValidateScope,
  resolveScopeName: vi.fn(async () => '全部'),
}))

import { getOperatingMaster } from '../operating-master'

const dialect = new PgDialect()
const Q = {
  skeleton: 0, beautician: 1, month: 2, ytd: 3, project: 4, consume: 5, shengmei: 6,
  retained: 7, managed: 8, footfall: 9,
} as const

function compiled(index: number) {
  return dialect.sqlToQuery(mockExecute.mock.calls[index][0] as SQL)
}

/** 按位置喂数；未给的位置返回空结果 */
function feed(results: Partial<Record<keyof typeof Q, unknown[]>>) {
  mockExecute.mockReset()
  const byIndex = new Map<number, unknown[]>(Object.entries(results).map(([key, rows]) => [Q[key as keyof typeof Q], rows]))
  let call = 0
  mockExecute.mockImplementation(async () => byIndex.get(call++) ?? [])
}

beforeEach(() => {
  // 未来月份守卫读真实时钟：钉死「今天」，用例里的 2026-08 / 2026-01 不随运行日期变化
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-25T10:00:00+08:00'))
  mockValidateScope.mockReset()
  feed({})
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getOperatingMaster', () => {
  it('1 月：R 年度累计与 P 当月完成是同一条 SQL、同一组参数（R = P）', async () => {
    await getOperatingMaster({ scope: { type: 'all' }, month: '2026-01' })
    const p = compiled(Q.month)
    const r = compiled(Q.ytd)
    expect(r.sql).toBe(p.sql)
    expect(r.params).toEqual(p.params)
    expect(p.params).toEqual(expect.arrayContaining(['2026-01-01', '2026-01-31']))
  })

  it('8 月：R 只把区间起点换成当年 1 月 1 日，其余谓词与 P 相同', async () => {
    await getOperatingMaster({ scope: { type: 'all' }, month: '2026-08' })
    const p = compiled(Q.month)
    const r = compiled(Q.ytd)
    expect(r.sql).toBe(p.sql)
    expect(p.params.slice(-2)).toEqual(['2026-08-01', '2026-08-31'])
    expect(r.params.slice(-2)).toEqual(['2026-01-01', '2026-08-31'])
  })

  it('款项类 SQL 限定 sale_order_type 且不含寄存单、排除 WorkFine 历史单；所有查询不加 >0 / HAVING 过滤、不读售前售后快照', async () => {
    await getOperatingMaster({ scope: { type: 'all' }, month: '2026-08' })
    for (const index of [Q.month, Q.ytd]) {
      const { sql } = compiled(index)
      expect(sql).toMatch(/spe\.sale_order_type IN \('销售单', '转换单', '充值单'\)/)
      expect(sql).not.toMatch(/寄存单/)
      expect(sql).toMatch(/spe\.legacy_source IS DISTINCT FROM 'workfine'/)
    }
    for (let index = 0; index < mockExecute.mock.calls.length; index += 1) {
      const { sql } = compiled(index)
      expect(sql, `第 ${index} 条`).not.toMatch(/HAVING/i)
      expect(sql, `第 ${index} 条`).not.toMatch(/>\s*0\b/)
      // 售前 / 售后快照已过时，本页一律不读（#372）
      expect(sql, `第 ${index} 条`).not.toMatch(/service_order_type/)
    }
  })

  it('K / L 被经营：一条查询扫年度区间、当月用 FILTER 截取；款项只含销售单 + 转换单，门槛读配置、外层 >=', async () => {
    await getOperatingMaster({ scope: { type: 'all' }, month: '2026-08' })
    const { sql, params } = compiled(Q.managed)
    const flat = sql.replace(/\s+/g, ' ')
    expect(params.slice(0, 3)).toEqual([1990, 1990, '2026-08-01'])
    expect(params.slice(-2)).toEqual(['2026-01-01', '2026-08-31'])
    expect(flat).toMatch(/COUNT\(\*\) FILTER \(WHERE t\.year_amount >= \$1\) AS year_v, COUNT\(\*\) FILTER \(WHERE t\.month_amount >= \$2\) AS month_v/)
    expect(flat).toMatch(/SUM\(spe\.amount::numeric\) FILTER \(WHERE spe\.performance_date >= \$3\) AS month_amount/)
    expect(flat).toContain("spe.sale_order_type IN ('销售单', '转换单')")
    expect(flat).not.toMatch(/充值单|寄存单|储值卡抵扣/)
    expect(flat).toContain("spe.change_type IN ('首次支付', '回款', '退款')")
    expect(flat).toContain("spe.legacy_source IS DISTINCT FROM 'workfine'")
    expect(flat).toMatch(/GROUP BY spe\.store_id, so\.client_user_id \) t GROUP BY t\.store_id/)
  })

  it('1 月：年度区间 = 当月区间，K 与 L 同一门槛同一区间（K = L）', async () => {
    feed({ managed: [{ store_id: 'S1', year_v: '3', month_v: '3' }], skeleton: [{ store_id: 'S1', store_name: 'A', market_id: 'M1', market_name: 'M' }] })
    const result = await getOperatingMaster({ scope: { type: 'all' }, month: '2026-01' })
    const { params } = compiled(Q.managed)
    expect(params[2]).toBe('2026-01-01')
    expect(params.slice(-2)).toEqual(['2026-01-01', '2026-01-31'])
    expect(result.rows[0].values).toMatchObject({ managedYearCustomers: 3, managedMonthCustomers: 3 })
  })

  it('E 保有会员：按绑定门店 scope，截至统计时点 T（过去月份 = 月末、当月 = 今天）；F / H 用 #298 到店天数、不限到店门店', async () => {
    await getOperatingMaster({ scope: { type: 'all' }, month: '2026-08' })
    const past = compiled(Q.retained)
    const flat = past.sql.replace(/\s+/g, ' ')
    expect(flat).toMatch(/so\.service_date BETWEEN \(\$\d+::date - INTERVAL '90 days'\)::date AND \$\d+/)
    expect(flat).toMatch(/c\.became_member_at IS NOT NULL AND c\.became_member_at::date <= \$\d+/)
    expect(past.params.filter((param) => param === '2026-08-31')).toHaveLength(4) // 窗口两端 + 会员守卫 + F/H 当月末
    expect(flat).toContain('COUNT(*) FILTER (WHERE mv.days >= 1) AS once')
    expect(flat).toContain('COUNT(*) FILTER (WHERE mv.days >= 2) AS twice')
    // 到店天数子查询 scope 传 TRUE：保有会员去了别的门店也算回店
    expect(flat).toMatch(/SELECT DISTINCT so\.client_user_id, so\.service_date AS visit_date FROM service_orders so WHERE true AND/i)

    feed({})
    await getOperatingMaster({ scope: { type: 'all' }, month: '2026-09' })
    const current = compiled(Q.retained)
    expect(current.params).toContain('2026-09-25')
    expect(current.params).toContain('2026-09-30') // F / H 仍按整月（今天之后没有已完成服务单）
  })

  it('S / T 到店天数：按服务门店 × 顾客 × 服务日去重，售前 = 当天核销过体验项；寄存单退款专用单照常算到店（真到店、假消耗）', async () => {
    await getOperatingMaster({ scope: { type: 'all' }, month: '2026-08' })
    const { sql, params } = compiled(Q.footfall)
    const flat = sql.replace(/\s+/g, ' ')
    expect(flat).toContain('GROUP BY so.store_id, so.client_user_id, so.service_date')
    expect(flat).toContain('si.is_experience = TRUE')
    expect(flat).toContain("so.status = '已完成'")
    expect(flat).not.toMatch(/remark/)
    expect(params).not.toContain('寄存单退款专用 — 老系统寄存疗程卡退款核销，不计消耗业绩')
  })

  it('V 生美项目数 = SUM(session_used) ∩ 已完成 ∩ 生美 ∩ 剔除寄存单退款专用单', async () => {
    await getOperatingMaster({ scope: { type: 'all' }, month: '2026-08' })
    const { sql, params } = compiled(Q.project)
    expect(sql).toMatch(/COALESCE\(SUM\(sit\.session_used\), 0\)/)
    expect(sql).toMatch(/so\.status = '已完成'/)
    expect(sql).toMatch(/sit\.is_shengmei = TRUE/)
    expect(sql).toMatch(/so\.remark IS DISTINCT FROM \$\d+/)
    expect(params).toContain('寄存单退款专用 — 老系统寄存疗程卡退款核销，不计消耗业绩')
    expect(sql).not.toMatch(/sales_category/)
  })

  it('D 美容师人数：产能技师人池（technician-sql 单源，不改 CTE）之上只收窄「技能含美容师」，按所选月末历史化', async () => {
    await getOperatingMaster({ scope: { type: 'all' }, month: '2026-08' })
    const { sql, params } = compiled(Q.beautician)
    const flat = sql.replace(/\s+/g, ' ')
    // technician_base 仍是产能技师原样（#320 跨端守护钉的就是这段），没有被改成别的人池
    const baseWhere = flat.match(/FROM staff_wechat_users sw .*? WHERE (.*?) \),/)?.[1]
    expect(baseWhere).toMatch(
      /^sw\.skills && ARRAY\['美容师','养生师'\]::text\[\] AND sw\.hired_at IS NOT NULL AND sw\.hired_at::date <= \$\d+ AND \(sw\.resigned_at IS NULL OR sw\.resigned_at::date > \$\d+\)$/,
    )
    // 外层整段钉死：只在 technician_scoped 上加一个「技能含美容师」的 EXISTS，不得多出岗位等人群条件
    const outer = flat.slice(flat.lastIndexOf(') SELECT store_id'))
    expect(outer).toBe(
      ") SELECT store_id, COUNT(*)::int AS v FROM technician_scoped ts WHERE store_id IS NOT NULL AND EXISTS ( SELECT 1 FROM staff_wechat_users bw WHERE bw.employee_id = ts.employee_id AND bw.skills && ARRAY['美容师']::text[] ) GROUP BY store_id ",
    )
    expect(sql).not.toMatch(/position/i)
    expect(params).toContain('2026-08-31')
  })

  it('装配：numeric 字符串转数字、没数据的门店补 0、跨市场出小计与总计', async () => {
    feed({
      skeleton: [
        { store_id: 'S1', store_name: '汇东店', market_id: 'M1', market_name: '自贡' },
        { store_id: 'S2', store_name: '南湖店', market_id: 'M1', market_name: '自贡' },
        { store_id: 'S3', store_name: '蓝莱店', market_id: 'M2', market_name: '南昌凤御' },
      ],
      beautician: [{ store_id: 'S1', v: 4 }, { store_id: 'S3', v: 5 }],
      month: [{ store_id: 'S1', v: '91182.00' }, { store_id: 'S2', v: '-10.50' }],
      ytd: [{ store_id: 'S1', v: '156152.00' }],
      project: [{ store_id: 'S1', v: '298' }],
      consume: [{ store_id: 'S3', v: '12.34' }],
      shengmei: [],
      retained: [{ store_id: 'S1', retained: '120', once: '90', twice: '40' }],
      managed: [{ store_id: 'S1', year_v: '11', month_v: '7' }, { store_id: 'S2', year_v: '1', month_v: '0' }],
      footfall: [{ store_id: 'S1', footfall: '300', pre_sale: '12' }, { store_id: 'S3', footfall: '5', pre_sale: '0' }],
    })
    const result = await getOperatingMaster({ scope: { type: 'all' }, month: '2026-08' })

    expect(result.multiMarket).toBe(true)
    expect(result.storeCount).toBe(3)
    expect(result.rows.map((row) => row.rowKey)).toEqual(['S1', 'S2', 'subtotal:M1', 'S3', 'subtotal:M2'])
    expect(result.rows[1].values).toMatchObject({ beauticianCount: 0, monthRevenue: -10.5, ytdRevenue: 0, shengmeiConsume: 0 })
    expect(result.rows[0].values).toMatchObject({
      retainedMembers: 120, returnOnceHeads: 90, returnTwiceHeads: 40, managedMonthCustomers: 7, managedYearCustomers: 11,
      monthFootfall: 300, preSaleFootfall: 12, afterSaleFootfall: 288,
    })
    expect(result.rows[1].values).toMatchObject({ retainedMembers: 0, managedYearCustomers: 1, monthFootfall: 0, afterSaleFootfall: 0 })
    expect(result.rows[2].values).toMatchObject({ beauticianCount: 4, monthRevenue: 91171.5, ytdRevenue: 156152, shengmeiProjectCount: 298 })
    expect(result.totals).toMatchObject({ beauticianCount: 9, monthRevenue: 91171.5, monthConsume: 12.34, shengmeiConsume: 0 })
    expect(result.totals).toMatchObject({ monthFootfall: 305, preSaleFootfall: 12, afterSaleFootfall: 293, returnOnceRate: 0.75 })
    expect(result).toMatchObject({ month: '2026-08', ytd: { start: '2026-01-01', end: '2026-08-31' }, asOf: '2026-08-31', scopeName: '全部' })
  })

  it('先校验 scope 再取数；越权直接上抛、不查库', async () => {
    mockValidateScope.mockRejectedValueOnce(new Error('PERMISSION_DENIED: 越权访问其他市场数据'))
    await expect(getOperatingMaster({ scope: { type: 'market', id: 'M9' }, month: '2026-08' })).rejects.toThrow('PERMISSION_DENIED')
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('月份非法直接 INVALID_PARAMS', async () => {
    await expect(getOperatingMaster({ scope: { type: 'all' }, month: '2026-8' })).rejects.toThrow('INVALID_PARAMS')
    await expect(getOperatingMaster({ scope: { type: 'all' }, month: '2099-01' })).rejects.toThrow('未来月份')
    expect(mockExecute).not.toHaveBeenCalled()
  })
})
