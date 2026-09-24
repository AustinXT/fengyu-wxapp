/**
 * getOperatingMaster（#372）装配与 SQL 形态单测。
 *
 * db.execute 被 mock，但 drizzle 的 sql 模板是真的：用 PgDialect 把每条查询编译成 SQL 文本 + 参数，
 * 直接断言「编译后发往 PG 的东西」——口径谓词本身与销售板的逐字一致由 consistency.operating-master 守护。
 *
 * 查询顺序（Promise.all 位置）：0 骨架 / 1 美容师 / 2 P 当月 / 3 R 年度 / 4 V 生美项目数 / 5 W 实耗 / 6 X 生美实耗
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

const { mockExecute, mockValidateScope } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockValidateScope: vi.fn(),
}))

vi.mock('@/db', () => ({ db: { execute: mockExecute } }))
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
const Q = { skeleton: 0, beautician: 1, month: 2, ytd: 3, project: 4, consume: 5, shengmei: 6 } as const

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
  mockValidateScope.mockReset()
  feed({})
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

  it('D 美容师人数：technician-sql 单源、技能只含美容师、按所选月末历史化', async () => {
    await getOperatingMaster({ scope: { type: 'all' }, month: '2026-08' })
    const { sql, params } = compiled(Q.beautician)
    expect(sql).toContain("sw.skills && ARRAY['美容师']::text[]")
    expect(sql).not.toContain('养生师')
    expect(sql).toContain('FROM technician_scoped')
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
    })
    const result = await getOperatingMaster({ scope: { type: 'all' }, month: '2026-08' })

    expect(result.multiMarket).toBe(true)
    expect(result.storeCount).toBe(3)
    expect(result.rows.map((row) => row.rowKey)).toEqual(['S1', 'S2', 'subtotal:M1', 'S3', 'subtotal:M2'])
    expect(result.rows[1].values).toMatchObject({ beauticianCount: 0, monthRevenue: -10.5, ytdRevenue: 0, shengmeiConsume: 0 })
    expect(result.rows[2].values).toMatchObject({ beauticianCount: 4, monthRevenue: 91171.5, ytdRevenue: 156152, shengmeiProjectCount: 298 })
    expect(result.totals).toMatchObject({ beauticianCount: 9, monthRevenue: 91171.5, monthConsume: 12.34, shengmeiConsume: 0 })
    expect(result).toMatchObject({ month: '2026-08', ytd: { start: '2026-01-01', end: '2026-08-31' }, scopeName: '全部' })
  })

  it('先校验 scope 再取数；越权直接上抛、不查库', async () => {
    mockValidateScope.mockRejectedValueOnce(new Error('PERMISSION_DENIED: 越权访问其他市场数据'))
    await expect(getOperatingMaster({ scope: { type: 'market', id: 'M9' }, month: '2026-08' })).rejects.toThrow('PERMISSION_DENIED')
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('月份非法直接 INVALID_PARAMS', async () => {
    await expect(getOperatingMaster({ scope: { type: 'all' }, month: '2026-8' })).rejects.toThrow('INVALID_PARAMS')
    expect(mockExecute).not.toHaveBeenCalled()
  })
})
