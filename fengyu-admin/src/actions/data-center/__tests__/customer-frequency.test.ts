import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '@/lib/types'
import type { CustomerFrequencySourceRow } from '@/lib/data-center/customer-frequency-query'

/**
 * 顾客频率表取数 action（#370）：权限闸门（dashboard + customer_detail 同一角色授权）、scope 越权、
 * 数据起点前的月份不取数、服务端分页 / 排序兜底、表尾合计与指标卡口径、手机号脱敏。
 * SQL 本身在 prod 用 issue 基准数逐项核对（见 PR）。
 */

const { mockGetSession, loadSource } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  loadSource: vi.fn(),
}))

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/db', () => ({ db: { select: vi.fn(() => { throw new Error('不应查库') }) } }))
vi.mock('@/lib/data-center/customer-frequency-query', () => ({ loadCustomerFrequencySource: loadSource }))

import { exportCustomerFrequencyReport, getCustomerFrequencyReport } from '../customer-frequency'

type Role = AuthSession['roles'][number]

function role(actions: string[], stores = ['S1']): Role {
  return { role: 'manager', scopeId: 'N1', scopeType: '门店', actions, scopeStoreIds: stores, scopeOrgNodeIds: ['N1'] }
}

function session(roles: Role[]): AuthSession {
  return {
    employeeId: 'EMP-1',
    name: '测试',
    phone: '13800000000',
    roles,
    permissions: {
      actions: Array.from(new Set(roles.flatMap((r) => r.actions ?? []))),
      scopeStoreIds: Array.from(new Set(roles.flatMap((r) => r.scopeStoreIds ?? []))),
    },
  }
}

const BOTH = ['data_center:dashboard', 'data_center:customer_detail']

/**
 * 60 位顾客：第 i 位本月到店 i % 7 天（每天消费 10 元）；i % 7 === 0 的顾客一天都没来（整行只有顾客字段）。
 */
function source(count: number): CustomerFrequencySourceRow[] {
  const out: CustomerFrequencySourceRow[] = []
  for (let index = 0; index < count; index += 1) {
    const base = {
      clientUserId: `U${String(index).padStart(3, '0')}`,
      customerName: `顾客${index}`,
      phone: `138000${String(index).padStart(5, '0')}`,
      memberLevel: null,
      customerType: '会员客',
      storeName: '蓝莱店',
    }
    const days = index % 7
    if (days === 0) {
      out.push({ ...base, day: null, visited: false, amount: null, consume: null, items: [], stores: [] })
      continue
    }
    for (let d = 1; d <= days; d += 1) {
      out.push({ ...base, day: `2026-08-${String(d).padStart(2, '0')}`, visited: true, amount: '10.00', consume: '6.00', items: ['面部'], stores: ['蓝莱店'] })
    }
  }
  return out
}

beforeEach(() => {
  vi.clearAllMocks()
  loadSource.mockResolvedValue(source(60))
})

describe('权限闸门（页面 / action / 导出同一组常量）', () => {
  it.each([
    ['只有 dashboard', [role(['data_center:dashboard'])]],
    ['只有 customer_detail', [role(['data_center:customer_detail'])]],
    ['两项由不同角色分别提供', [role(['data_center:dashboard']), role(['data_center:customer_detail'])]],
    ['customer:list 不能代替', [role(['data_center:dashboard', 'customer:list'])]],
  ])('%s → PERMISSION_DENIED，且不取数', async (_label, roles) => {
    mockGetSession.mockResolvedValue(session(roles))
    for (const action of [getCustomerFrequencyReport, exportCustomerFrequencyReport]) {
      await expect(action({ scope: 'store', scopeId: 'S1', month: '2026-08' })).rejects.toThrow(/PERMISSION_DENIED/)
    }
    expect(loadSource).not.toHaveBeenCalled()
  })

  it('门店账号请求 all / 越权门店被拒，不以 all 取数', async () => {
    mockGetSession.mockResolvedValue(session([role(BOTH)]))
    await expect(getCustomerFrequencyReport({ month: '2026-08' })).rejects.toThrow(/PERMISSION_DENIED/)
    await expect(getCustomerFrequencyReport({ scope: 'store', scopeId: 'S9', month: '2026-08' })).rejects.toThrow(/PERMISSION_DENIED/)
    expect(loadSource).not.toHaveBeenCalled()
  })
})

describe('取数、分页与合计', () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(session([role(BOTH)]))
  })

  it('按所选月份整月取数；服务端分页，表尾合计按全部筛选行、翻页不变；指标卡三档不变量成立', async () => {
    const first = await getCustomerFrequencyReport({ scope: 'store', scopeId: 'S1', month: '2026-08', size: '20' })
    const second = await getCustomerFrequencyReport({ scope: 'store', scopeId: 'S1', month: '2026-08', size: '20', page: '2' })

    expect(loadSource).toHaveBeenCalledWith(expect.anything(), { type: 'store', id: 'S1' }, { start: '2026-08-01', end: '2026-08-31' })
    expect(first.rows).toHaveLength(20)
    expect(first.total).toBe(60)
    expect(second.page).toBe(2)
    expect(first.totals).toEqual(second.totals)

    const { summary } = first
    // 统计顾客数含 0 次到店（9 位：index 0,7,...,56）
    expect(summary.customerCount).toBe(60)
    expect(summary.visitedCount).toBe(51)
    expect(summary.tiers.low.count + summary.tiers.mid.count + summary.tiers.high.count).toBe(summary.visitedCount)
    expect(summary.visitTotal).toBe(first.totals.visitDays)
    expect(summary.amountTotal).toBe(first.totals.amount)
    expect(summary.amountTotal).toBe(summary.visitTotal * 10)
    expect(summary.consumeRatio).toBeCloseTo(0.6)
    // 默认到店次数降序：第一页全是 6 天的顾客（index % 7 === 6 共 8 位）排在最前
    expect(first.rows.slice(0, 8).every((row) => row.visitDays === 6)).toBe(true)
    // 手机号只出脱敏值
    expect(first.rows.map((row) => row.phoneMasked)).toContain('138****0006')
    expect(JSON.stringify(first)).not.toMatch(/138000\d{5}/)
  })

  it('翻遍所有页：不重复、不漏行（同分值按顾客 id 兜底）', async () => {
    const seen: string[] = []
    for (let page = 1; page <= 3; page += 1) {
      const report = await getCustomerFrequencyReport({ scope: 'store', scopeId: 'S1', month: '2026-08', size: '20', page: String(page) })
      seen.push(...report.rows.map((row) => row.clientUserId))
    }
    expect(seen).toHaveLength(60)
    expect(new Set(seen).size).toBe(60)
  })

  it('搜索 / 只看有到店只影响表格行与表尾，不影响指标卡；页码越界回到末页', async () => {
    const all = await getCustomerFrequencyReport({ scope: 'store', scopeId: 'S1', month: '2026-08' })
    const visited = await getCustomerFrequencyReport({ scope: 'store', scopeId: 'S1', month: '2026-08', show: 'visited', page: '99' })
    expect(visited.total).toBe(51)
    expect(visited.page).toBe(2)
    expect(visited.filtered).toBe(true)
    expect(visited.summary).toEqual(all.summary)

    // 完整手机号精确匹配；部分号码不做模糊匹配
    const byPhone = await getCustomerFrequencyReport({ scope: 'store', scopeId: 'S1', month: '2026-08', q: '13800000013' })
    expect(byPhone.rows.map((row) => row.clientUserId)).toEqual(['U013'])
    const partial = await getCustomerFrequencyReport({ scope: 'store', scopeId: 'S1', month: '2026-08', q: '0013' })
    expect(partial.total).toBe(0)
    const byName = await getCustomerFrequencyReport({ scope: 'store', scopeId: 'S1', month: '2026-08', q: '顾客5' })
    expect(byName.total).toBe(11) // 顾客5、顾客50..59
    expect(byName.totals.visitDays).toBe(byName.rows.reduce((sum, row) => sum + row.visitDays, 0))
  })

  it('URL 手工传入 2026-07 之前的月份：不取数，返回空表并标记早于数据起点', async () => {
    const report = await getCustomerFrequencyReport({ scope: 'store', scopeId: 'S1', month: '2026-05' })
    expect(loadSource).not.toHaveBeenCalled()
    expect(report).toMatchObject({ month: '2026-05', beforeDataStart: true, total: 0, rows: [] })
    expect(report.summary.customerCount).toBe(0)
    expect(report.summary.visitRate).toBeNull()
  })

  it('导出返回当前筛选的全部行（不分页），合计与页面表尾一致', async () => {
    const params = { scope: 'store', scopeId: 'S1', month: '2026-08', show: 'visited', page: '2', size: '20' }
    const exported = await exportCustomerFrequencyReport(params)
    const page = await getCustomerFrequencyReport(params)

    expect(exported.rows).toHaveLength(51)
    expect(exported.totals).toEqual(page.totals)
    expect(exported.params).toEqual({
      scope: { type: 'store', id: 'S1' },
      searchLabel: '',
      show: 'visited',
      month: '2026-08',
      monthLabel: '2026年8月',
      range: { start: '2026-08-01', end: '2026-08-31' },
    })
    expect(JSON.stringify(exported)).not.toMatch(/138000\d{5}/)

    // 按完整手机号搜索：导出 action 的整个回包（含回显的搜索词）都没有明文号码
    const byPhone = await exportCustomerFrequencyReport({ ...params, q: '13800000013' })
    expect(byPhone.rows.map((row) => row.clientUserId)).toEqual(['U013'])
    expect(byPhone.params.searchLabel).toBe('138****0013')
    expect(JSON.stringify(byPhone)).not.toMatch(/138000\d{5}/)
  })
})
