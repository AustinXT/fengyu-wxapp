import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '@/lib/types'

/**
 * 经营明细报表的 SSR 闸门（#367）：顾客明细类 / 员工提成类页面要求
 * 「dashboard + 专用权限点」由同一角色授权同时提供。只有 dashboard 的账号必须被拒成
 * PERMISSION_DENIED（error.tsx 渲染 403，不是 500），且在查库之前就拒掉。
 */

const { mockGetSession, db, loadStoreDataStarts } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  db: { select: vi.fn(() => { throw new Error('闸门之前不应查库') }) },
  loadStoreDataStarts: vi.fn(),
}))

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/db', () => ({ db }))
vi.mock('@/lib/data-center/data-start-query', () => ({ loadStoreDataStarts }))

import {
  getCustomerDetailScopeOptions,
  getDataCenterScopeOptions,
  getDataStartDates,
  getStaffCommissionScopeOptions,
} from '../shared'

type Role = AuthSession['roles'][number]

function role(actions: string[], scopeType: Role['scopeType'] = '门店', stores = ['S1']): Role {
  return { role: 'manager', scopeId: 'N1', scopeType, actions, scopeStoreIds: stores, scopeOrgNodeIds: ['N1'] }
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

beforeEach(() => {
  vi.clearAllMocks()
})

describe('经营明细报表 scope 数据源兼页面闸门', () => {
  it.each([
    ['顾客明细类', getCustomerDetailScopeOptions],
    ['员工提成类', getStaffCommissionScopeOptions],
  ])('%s：只有 dashboard 的账号被拒成 PERMISSION_DENIED，且不查库', async (_label, action) => {
    mockGetSession.mockResolvedValue(session([role(['data_center:dashboard'])]))

    await expect(action()).rejects.toMatchObject({ digest: 'PERMISSION_DENIED' })
    expect(db.select).not.toHaveBeenCalled()
  })

  it.each([
    ['顾客明细类', getCustomerDetailScopeOptions, 'data_center:customer_detail'],
    ['员工提成类', getStaffCommissionScopeOptions, 'data_center:staff_commission'],
  ])('%s：缺 dashboard 只有专用权限点同样被拒', async (_label, action, key) => {
    mockGetSession.mockResolvedValue(session([role([key])]))

    await expect(action()).rejects.toMatchObject({ digest: 'PERMISSION_DENIED' })
  })

  it('两项分属两条角色授权时被拒（不拼接两个角色的范围）', async () => {
    mockGetSession.mockResolvedValue(session([
      role(['data_center:dashboard'], '市场', ['S1', 'S2']),
      role(['data_center:customer_detail'], '门店', ['S3']),
    ]))

    const error = await getCustomerDetailScopeOptions().catch((e: unknown) => e) as Error & { digest?: string }
    expect(error.message).toMatch(/^PERMISSION_DENIED:/)
    expect(error.digest).toMatch(/^PERMISSION_DENIED/)
    expect(db.select).not.toHaveBeenCalled()
  })
})

describe('getDataStartDates', () => {
  const starts = {
    S1: { performance: '2026-07-08' },
    S2: { service: '2026-07-28' },
    S9: { performance: '2026-08-23' },
  }

  it('非总部账号只拿到授权门店的起点', async () => {
    loadStoreDataStarts.mockResolvedValue(starts)
    mockGetSession.mockResolvedValue(session([role(['data_center:dashboard'], '市场', ['S1', 'S2'])]))

    await expect(getDataStartDates()).resolves.toEqual({ S1: starts.S1, S2: starts.S2 })
  })

  it('总部账号拿到全部门店', async () => {
    loadStoreDataStarts.mockResolvedValue(starts)
    mockGetSession.mockResolvedValue(session([role(['data_center:dashboard'], '总部', [])]))

    await expect(getDataStartDates()).resolves.toEqual(starts)
  })

  it('没有 dashboard 被拒', async () => {
    mockGetSession.mockResolvedValue(session([role(['customer:list'])]))

    await expect(getDataStartDates()).rejects.toMatchObject({ digest: 'PERMISSION_DENIED' })
    expect(loadStoreDataStarts).not.toHaveBeenCalled()
  })
})

describe('scope 数据源 · 已停用门店分流（#293）', () => {
  /** drizzle 链式查询替身：任意链式方法返回自身，await 时给出 rows */
  function rowsOf(rows: unknown[]) {
    const chain: Record<string, unknown> = {}
    for (const method of ['from', 'where', 'innerJoin', 'orderBy']) chain[method] = () => chain
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject)
    return chain
  }

  it('在营只看节点（#401）：节点启用的进下拉（含只关店、节点仍启用的），节点停用的进 inactiveStores', async () => {
    mockGetSession.mockResolvedValue(session([role(['data_center:dashboard'], '总部', [])]))
    db.select
      .mockImplementationOnce(() => rowsOf([{ id: 'M1', name: '九江凤御' }, { id: 'M2', name: '自贡凤御' }]) as never)
      .mockImplementationOnce(() => rowsOf([
        { storeId: 'S1', storeName: '九江蓝湾店', marketId: 'M1', isActive: true },
        { storeId: 'X1', storeName: '九江中辉店', marketId: 'M1', isActive: false },
        { storeId: 'X2', storeName: '自贡旭阳店', marketId: 'M2', isActive: false },
        { storeId: 'X3', storeName: '只关店未停节点', marketId: 'M2', isActive: true },
      ]) as never)

    await expect(getDataCenterScopeOptions()).resolves.toEqual({
      topLevel: 'all',
      markets: [
        { id: 'M1', name: '九江凤御', stores: [{ storeId: 'S1', storeName: '九江蓝湾店' }] },
        { id: 'M2', name: '自贡凤御', stores: [{ storeId: 'X3', storeName: '只关店未停节点' }] },
      ],
      inactiveStores: [
        { storeId: 'X1', storeName: '九江中辉店', marketId: 'M1' },
        { storeId: 'X2', storeName: '自贡旭阳店', marketId: 'M2' },
      ],
    })
  })
})
