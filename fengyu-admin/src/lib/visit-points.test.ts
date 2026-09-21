import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { sql, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

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

/**
 * 把 drizzle 的 SQL 片段编译成驱动真正收到的 `{sql, params}`。
 *
 * mock 掉 `execute` 的单测看不到绑定层，Date 塞进模板也全绿——#253 就是这么漏出去的
 * （postgres.js Bind 阶段对 Date 实例抛 ERR_INVALID_ARG_TYPE，到店积分自 2026-08-14 起 100% 失败）。
 * 这里用与运行时同一个 PgDialect 把片段展开，断言落到 params 里的都是驱动吃得下的标量。
 */
function compile(fragment: SQL) {
  return new PgDialect().sqlToQuery(fragment)
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

  // #253 回归守护：绑定层不得出现 Date 实例。
  it('发放 SQL 的时间参数经 beijingTs 落成北京墙钟字面，绑定层无 Date 实例', async () => {
    const execute = vi.fn().mockResolvedValue([{ points_balance: 120 }])
    // 2026-08-13T10:00:00Z = 北京 2026-08-13 18:00:00
    await grantVisitPointsEntry(
      { execute } as never,
      'client-001',
      '2026-08-13',
      20,
      new Date('2026-08-13T10:00:00.000Z'),
    )

    const { sql: text, params } = compile(execute.mock.calls[0][0] as SQL)

    // 主断言：postgres.js 的 Bind 阶段只吃 string/Buffer/ArrayBuffer 等标量，Date 会直接抛型错
    expect(params.some((p) => p instanceof Date)).toBe(false)
    // 两处时间写入（point_transactions.created_at、client_wechat_users.points_updated_at）都被包装
    expect(params.filter((p) => p === '2026-08-13 18:00:00')).toHaveLength(2)
    expect(text.match(/AT TIME ZONE 'Asia\/Shanghai'/g)).toHaveLength(2)
  })

  // 对照组：证明上面那条断言不是空转——drizzle 自己不会把 Date 转成标量，
  // 它原样交给驱动，所以「不写 beijingTs 就一定炸」在类型层面无人拦截。
  it('对照：裸 Date 插值会原样穿透到绑定层（说明守护有效）', () => {
    const { params } = compile(sql`SELECT ${new Date('2026-08-13T10:00:00.000Z')}`)
    expect(params[0]).toBeInstanceOf(Date)
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
