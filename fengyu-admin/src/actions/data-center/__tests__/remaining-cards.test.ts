import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '@/lib/types'
import type { RemainingCardsSqlRow } from '@/lib/data-center/remaining-cards'

/**
 * 顾客剩余卡项清单取数 action（#371）：权限闸门（dashboard + customer_detail 同一角色授权）、
 * scope 越权、服务端分页与表尾合计口径。SQL 本身在 prod 用独立复算交叉核对（见 PR）。
 */

const { mockGetSession, loadSnapshot } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  loadSnapshot: vi.fn(),
}))

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/db', () => ({ db: { select: vi.fn(() => { throw new Error('不应查库') }) } }))
vi.mock('@/lib/data-center/remaining-cards-query', () => ({ loadRemainingCardsSnapshot: loadSnapshot }))

import { exportRemainingCardsReport, getRemainingCardsReport } from '../remaining-cards'

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

function rows(count: number): RemainingCardsSqlRow[] {
  return Array.from({ length: count }, (_, index) => ({
    clientUserId: `U${String(index).padStart(3, '0')}`,
    storeId: 'S1',
    storeName: '蓝莱店',
    customerName: `顾客${index}`,
    phone: `138000${String(index).padStart(5, '0')}`,
    memberLevel: null,
    customerType: '会员客',
    cells: [{ categoryId: 'C1', remaining: index % 3, unpaid: 0, activeRows: 1, expiredRows: 0, served: 0, convertedOut: 0, deposit: false, frozen: false }],
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  loadSnapshot.mockResolvedValue({
    rows: rows(60),
    categories: [{ categoryId: 'C1', categoryName: '招牌', kind: '招牌', kindSort: 1, sort: 1 }],
  })
})

describe('权限闸门（页面 / action / 导出同一组常量）', () => {
  it.each([
    ['只有 dashboard', [role(['data_center:dashboard'])]],
    ['只有 customer_detail', [role(['data_center:customer_detail'])]],
    ['两项由不同角色分别提供', [role(['data_center:dashboard']), role(['data_center:customer_detail'])]],
    ['customer:list + sale_item:list 不能代替', [role(['data_center:dashboard', 'customer:list', 'sale_item:list'])]],
  ])('%s → PERMISSION_DENIED，且不取数', async (_label, roles) => {
    mockGetSession.mockResolvedValue(session(roles))
    for (const action of [getRemainingCardsReport, exportRemainingCardsReport]) {
      await expect(action({ scope: 'store', scopeId: 'S1' })).rejects.toThrow(/PERMISSION_DENIED/)
    }
    expect(loadSnapshot).not.toHaveBeenCalled()
  })

  it('门店账号请求 all / 越权门店被拒，不以 all 取数', async () => {
    mockGetSession.mockResolvedValue(session([role(BOTH)]))
    await expect(getRemainingCardsReport({})).rejects.toThrow(/PERMISSION_DENIED/)
    await expect(getRemainingCardsReport({ scope: 'store', scopeId: 'S9' })).rejects.toThrow(/PERMISSION_DENIED/)
    expect(loadSnapshot).not.toHaveBeenCalled()
  })
})

describe('分页与合计', () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(session([role(BOTH)]))
  })

  it('服务端分页；表尾合计按全部筛选行，翻页不变；指标卡按范围全量', async () => {
    const first = await getRemainingCardsReport({ scope: 'store', scopeId: 'S1', size: '20' })
    const second = await getRemainingCardsReport({ scope: 'store', scopeId: 'S1', size: '20', page: '2' })

    expect(loadSnapshot).toHaveBeenCalledWith(expect.anything(), { type: 'store', id: 'S1' }, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
    expect(first.rows).toHaveLength(20)
    expect(first.total).toBe(60)
    expect(second.page).toBe(2)
    expect(first.totals).toEqual(second.totals)
    // 0..59 的 index % 3 之和 = 20 × (0 + 1 + 2)
    expect(first.totals.remaining).toBe(60)
    expect(first.totals.remaining).toBe(first.summary.remainingSessions)
    // 默认剩余降序：第一页全是剩余 2 的行
    expect(first.rows.every((row) => row.remaining === 2)).toBe(true)
    expect(first.rows.map((row) => row.phoneMasked)).toContain('138****0002')
    expect(JSON.stringify(first)).not.toMatch(/138000\d{5}/)
  })

  it('页码越界回到末页；有搜索时表尾按筛选结果、指标卡不变', async () => {
    const report = await getRemainingCardsReport({ scope: 'store', scopeId: 'S1', q: '顾客1', page: '99' })
    // 顾客1、顾客10..19 共 11 行
    expect(report.total).toBe(11)
    expect(report.page).toBe(1)
    expect(report.filtered).toBe(true)
    expect(report.filteredCustomerCount).toBe(11)
    expect(report.totals.remaining).toBe(report.rows.reduce((sum, row) => sum + row.remaining, 0))
    expect(report.summary.remainingSessions).toBe(60)
  })

  it('导出返回当前筛选的全部行（不分页），合计与页面表尾一致', async () => {
    const params = { scope: 'store', scopeId: 'S1', show: 'remaining', page: '2', size: '20' }
    const exported = await exportRemainingCardsReport(params)
    const page = await getRemainingCardsReport(params)

    expect(exported.rows).toHaveLength(40)
    expect(exported.totals).toEqual(page.totals)
    expect(exported.params).toEqual({ scope: { type: 'store', id: 'S1' }, q: '', show: 'remaining' })
  })
})
