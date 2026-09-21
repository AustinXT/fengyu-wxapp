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
 * （到店积分自 2026-08-14 起 100% 失败，prod 积压 373 条失败日志）。
 * 这里用与运行时同一个 PgDialect 把片段展开，断言落到 params 里的都是驱动吃得下的标量。
 *
 * ⚠ 覆盖边界：真实路径是 `db.execute` → drizzle session → `client.unsafe(query, params)`，
 * 而崩溃发生在 `sqlToQuery` 的**下游**（drizzle 覆盖 serializer + postgres.js Bind）。
 * 本 helper 只到 `sqlToQuery` 为止，跨层那一段由 `__tests__/db-time.test.ts` 的
 * 「drizzle 覆盖 postgres.js 时间 serializer」用例独立取证，两者合起来才闭环。
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

    // 唯一真正的不变量：绑定层不得出现 Date 实例（Bind writer 只吃 string/Buffer/ArrayBuffer）。
    // 任一处回退裸 ${now} 这条即红。
    expect(params.some((p) => p instanceof Date)).toBe(false)

    // 片段复用守护：beijingTs() 返回的同一个 SQL 对象在本条模板里被引用两次。
    // drizzle 的 SQL 是不可变 chunk 树、序列化是纯遍历，两次引用 → 两个独立占位符 + 两份参数。
    // 锁住参数总数与占位顺序，防止将来有人"优化"成复用一个占位符（会静默错位）。
    expect(params).toEqual([
      'client-001', 20, 'visit-points:client-001:2026-08-13',
      '2026-08-13 18:00:00', 'client-001', '2026-08-13 18:00:00', 'client-001',
    ])

    // 下面两条锁的是**选型**（I5：外部入参走 beijingTs 落北京墙钟），不是 #253 的不变量：
    // 改成 nowTs() / now.toISOString() 同样能修好 #253，但这两条会红。
    // 若哪天有意改选型，应同步改这两条断言，而不是删掉它们。
    // 两处时间写入（point_transactions.created_at、client_wechat_users.points_updated_at）都被包装：
    expect(params.filter((p) => p === '2026-08-13 18:00:00')).toHaveLength(2)
    expect(text.match(/AT TIME ZONE 'Asia\/Shanghai'/g)).toHaveLength(2)
  })

  // 补发场景：业务锚点回到历史服务日，但余额变更时间必须留在真实当下，
  // 否则 points_updated_at 会倒退，按更新时间做增量同步/对账的下游会漏掉这次变更。
  it('业务锚点与余额变更时间可分离，points_updated_at 不跟着锚点倒退', async () => {
    const execute = vi.fn().mockResolvedValue([{ points_balance: 140 }])
    await grantVisitPointsEntry(
      { execute } as never,
      'client-001',
      '2026-08-13',
      20,
      new Date('2026-08-12T16:00:00.000Z'), // 锚点：北京 2026-08-13 00:00:00
      new Date('2026-09-22T02:00:00.000Z'), // 余额变更：北京 2026-09-22 10:00:00
    )

    const { params } = compile(execute.mock.calls[0][0] as SQL)
    // created_at 用锚点（出现 1 次），points_updated_at 用真实当下（出现 1 次）
    expect(params.filter((p) => p === '2026-08-13 00:00:00')).toHaveLength(1)
    expect(params.filter((p) => p === '2026-09-22 10:00:00')).toHaveLength(1)
    expect(params.some((p) => p instanceof Date)).toBe(false)
  })

  // 对照组 = drizzle 0.45 行为快照 + 升级信号。
  // 它锁的是「drizzle 不会代你把 Date 转成标量、原样交给驱动」这个前提；前提成立，
  // 上面那条主断言才有意义。**这条变红是好消息**：说明新版 drizzle 自己归一了 Date，
  // #253 的成因消失，届时主断言退化为恒真，可以连同本用例一起重新评估。
  it('对照：drizzle 0.45 下裸 Date 插值会原样穿透到绑定层（变红=成因已消失，非回归）', () => {
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
