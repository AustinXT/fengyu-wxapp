import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

vi.mock('@/db', () => ({
  db: { execute: vi.fn(), transaction: vi.fn() },
}))

import {
  DEFAULT_VISIT_POINTS_REWARD,
  buildVisitPointsExternalRef,
  grantVisitPointsEntry,
  grantVisitPointsSafe,
  isVisitPointsEligible,
  normalizeServiceDate,
  parseVisitPointsReward,
  type VisitPointsServiceSnapshot,
} from './visit-points'

const snapshot: VisitPointsServiceSnapshot = {
  serviceOrderId: 'HLD-WX-2608130001',
  serviceOrderType: '售后',
  serviceDate: '2026-08-13',
  clientUserId: 'client-001',
  remark: '',
  hasPositiveItem: true,
}

describe('会员到店积分（admin）', () => {
  const oldFlag = process.env.POINTS_ACCRUAL_ENABLED

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.POINTS_ACCRUAL_ENABLED
  })

  afterAll(() => {
    if (oldFlag === undefined) delete process.env.POINTS_ACCRUAL_ENABLED
    else process.env.POINTS_ACCRUAL_ENABLED = oldFlag
  })

  it('配置缺失默认 20，非法值 fail-closed 为 0', () => {
    expect(parseVisitPointsReward(undefined)).toBe(DEFAULT_VISIT_POINTS_REWARD)
    expect(parseVisitPointsReward('0')).toBe(0)
    expect(parseVisitPointsReward(' 30 ')).toBe(30)
    expect(parseVisitPointsReward('-1')).toBe(0)
    expect(parseVisitPointsReward('1.5')).toBe(0)
  })

  it('资格按创建时会员快照、正价项目和特殊备注判断', () => {
    expect(isVisitPointsEligible(snapshot)).toBe(true)
    expect(isVisitPointsEligible({ ...snapshot, serviceOrderType: '售前' })).toBe(false)
    expect(isVisitPointsEligible({ ...snapshot, hasPositiveItem: false })).toBe(false)
    expect(isVisitPointsEligible({ ...snapshot, clientUserId: null })).toBe(false)
  })

  it('流水插入成功才更新余额并返回 granted', async () => {
    const execute = vi.fn().mockResolvedValue([{ points_balance: 120 }])
    const now = new Date('2026-08-13T10:00:00.000Z')
    const result = await grantVisitPointsEntry(
      { execute } as never,
      'client-001',
      '2026-08-13',
      20,
      now,
    )

    expect(result).toEqual({
      granted: true,
      skipped: null,
      amount: 20,
      externalRef: 'visit-points:client-001:2026-08-13',
    })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('同日重复 external_ref 返回 duplicate', async () => {
    const execute = vi.fn().mockResolvedValue([])
    const result = await grantVisitPointsEntry(
      { execute } as never,
      'client-001',
      '2026-08-13',
      20,
      new Date(),
    )
    expect(result).toMatchObject({ granted: false, skipped: 'duplicate' })
    expect(buildVisitPointsExternalRef('client-001', '2026-08-13')).toBe(result.externalRef)
    expect(normalizeServiceDate(new Date('2026-08-13T16:30:00.000Z'))).toBe('2026-08-14')
  })

  it('嵌套事务失败后写失败日志，外层服务确认可继续', async () => {
    const failureExecute = vi.fn().mockRejectedValue(new Error('points insert failed'))
    const logExecute = vi.fn().mockResolvedValue([])
    const transaction = vi.fn()
      .mockImplementationOnce(async (fn) => fn({ execute: failureExecute }))
      .mockImplementationOnce(async (fn) => fn({ execute: logExecute }))

    const result = await grantVisitPointsSafe(
      { transaction } as never,
      snapshot,
      'admin.service.confirm',
    )

    expect(result).toMatchObject({ granted: false, skipped: 'failed', amount: 20 })
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(logExecute).toHaveBeenCalledOnce()
  })

  it('配置 0 时不写流水', async () => {
    const execute = vi.fn().mockResolvedValue([{ value: '0' }])
    const transaction = vi.fn(async (fn) => fn({ execute }))

    const result = await grantVisitPointsSafe(
      { transaction } as never,
      snapshot,
      'admin.service.confirm',
    )

    expect(result).toMatchObject({ granted: false, skipped: 'disabled' })
    expect(execute).toHaveBeenCalledOnce()
  })
})
