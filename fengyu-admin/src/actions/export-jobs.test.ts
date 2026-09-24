import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '@/lib/types'

/**
 * 导出任务的权限闸门（#367）。
 *
 * `EXPORT_PERMISSIONS_BY_TYPE` 是「任一即可」：data-center 只要有 dashboard 就能过。
 * 经营明细报表的顾客 / 提成视图要求「dashboard + 专用权限点」同时满足，
 * 这里钉住发起与重试两条入口都按 `DATA_CENTER_VIEW_REQUIRED_ACTIONS` 收紧。
 *
 * 新视图由各页面单登记；本文件用一个夹具视图 `fixture-customer-detail` 验证机制本身，
 * 不依赖页面单是否已合入。
 */

const { FIXTURE_VIEW } = vi.hoisted(() => ({ FIXTURE_VIEW: 'fixture-customer-detail' }))

vi.mock('@/lib/export-job-types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/export-job-types')>()
  return {
    ...actual,
    DATA_CENTER_EXPORT_VIEWS: [...actual.DATA_CENTER_EXPORT_VIEWS, FIXTURE_VIEW],
    DATA_CENTER_VIEW_REQUIRED_ACTIONS: {
      ...actual.DATA_CENTER_VIEW_REQUIRED_ACTIONS,
      [FIXTURE_VIEW]: ['data_center:dashboard', 'data_center:customer_detail'],
    },
  }
})

const { mockGetSession, db, insertReturning, selectLimit, updateWhere, logOperation } = vi.hoisted(() => {
  const insertReturning = vi.fn()
  const selectLimit = vi.fn()
  const updateWhere = vi.fn()
  const chain = <T extends object>(obj: T) => obj
  const db = {
    insert: vi.fn(() => chain({
      values: () => chain({ onConflictDoNothing: () => chain({ returning: insertReturning }) }),
    })),
    select: vi.fn(() => chain({
      from: () => chain({
        where: () => chain({
          limit: selectLimit,
          orderBy: () => chain({ limit: selectLimit }),
        }),
      }),
    })),
    update: vi.fn(() => chain({ set: () => chain({ where: updateWhere }) })),
  }
  return {
    mockGetSession: vi.fn(),
    db,
    insertReturning,
    selectLimit,
    updateWhere,
    logOperation: vi.fn(),
  }
})

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/db', () => ({ db }))
vi.mock('@/lib/operation-log', () => ({ logOperation }))
vi.mock('@/lib/cloudbase', () => ({ deleteByCloudPaths: vi.fn() }))

import { createExportJob, retryMyExportJob } from './export-jobs'

type Role = AuthSession['roles'][number]

function role(actions: string[], scopeId = 'M1'): Role {
  return {
    role: 'finance',
    scopeId,
    scopeType: '市场',
    actions,
    scopeStoreIds: [`${scopeId}-S1`],
    scopeOrgNodeIds: [scopeId],
  }
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
      scopeOrgNodeIds: Array.from(new Set(roles.flatMap((r) => r.scopeOrgNodeIds ?? []))),
    },
  }
}

const dashboardOnly = session([role(['data_center:dashboard'])])
const withCustomerDetail = session([role(['data_center:dashboard', 'data_center:customer_detail'])])
/** 两项分属两条角色授权：各自范围不同，不能拼接成「全部满足」。 */
const splitAcrossRoles = session([
  role(['data_center:dashboard'], 'M1'),
  role(['data_center:customer_detail', 'sale_order:list'], 'M2'),
])

function dataCenterInput(view: string) {
  return {
    exportType: 'data-center' as const,
    payload: { view, params: { scope: 'authorized' } },
  } as Parameters<typeof createExportJob>[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  insertReturning.mockResolvedValue([{ id: 7 }])
  selectLimit.mockResolvedValue([])
  updateWhere.mockResolvedValue(undefined)
})

describe('createExportJob · data-center 视图权限（全部满足）', () => {
  it('只有 dashboard 的账号发起顾客明细视图导出被拒，且不落任务', async () => {
    mockGetSession.mockResolvedValue(dashboardOnly)

    await expect(createExportJob(dataCenterInput(FIXTURE_VIEW))).rejects.toMatchObject({
      digest: 'PERMISSION_DENIED',
    })
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('同一角色同时持有两项时放行', async () => {
    mockGetSession.mockResolvedValue(withCustomerDetail)

    await expect(createExportJob(dataCenterInput(FIXTURE_VIEW))).resolves.toEqual({ id: 7, reused: false })
    expect(db.insert).toHaveBeenCalledTimes(1)
  })

  it('两项分属两条角色授权时拒绝（不拼接两个角色的范围）', async () => {
    mockGetSession.mockResolvedValue(splitAcrossRoles)

    await expect(createExportJob(dataCenterInput(FIXTURE_VIEW))).rejects.toThrow(/PERMISSION_DENIED/)
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('旧 4 板块视图仍只要求 dashboard（不回归）', async () => {
    mockGetSession.mockResolvedValue(dashboardOnly)

    await expect(createExportJob(dataCenterInput('sales-market'))).resolves.toEqual({ id: 7, reused: false })
  })
})

describe('retryMyExportJob · data-center 视图权限（全部满足）', () => {
  function failedJob(view: string) {
    return {
      id: 7,
      exportType: 'data-center',
      status: 'failed',
      requestPayload: { view, params: { scope: 'authorized' } },
      requestHash: 'hash',
      fileCloudPath: null,
    }
  }

  it('只有 dashboard 的账号重试顾客明细视图导出被拒，且不改任务', async () => {
    mockGetSession.mockResolvedValue(dashboardOnly)
    selectLimit.mockResolvedValueOnce([failedJob(FIXTURE_VIEW)])

    await expect(retryMyExportJob(7)).rejects.toMatchObject({ digest: 'PERMISSION_DENIED' })
    expect(db.update).not.toHaveBeenCalled()
  })

  it('同一角色同时持有两项时可重试', async () => {
    mockGetSession.mockResolvedValue(withCustomerDetail)
    selectLimit.mockResolvedValueOnce([failedJob(FIXTURE_VIEW)]).mockResolvedValueOnce([])

    await expect(retryMyExportJob(7)).resolves.toEqual({ id: 7 })
    expect(db.update).toHaveBeenCalledTimes(1)
  })

  it('任务参数无法解析时按 INVALID_STATE 拒绝，不放行', async () => {
    mockGetSession.mockResolvedValue(withCustomerDetail)
    selectLimit.mockResolvedValueOnce([failedJob('no-such-view')])

    await expect(retryMyExportJob(7)).rejects.toThrow(/INVALID_STATE/)
    expect(db.update).not.toHaveBeenCalled()
  })
})
