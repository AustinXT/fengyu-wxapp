import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

const { queryChannels } = vi.hoisted(() => ({ queryChannels: vi.fn() }))

vi.mock('@/lib/lakala-onboarding', () => ({
  lakalaQueryChannelSubMerchants: queryChannels,
}))

import { refreshLakalaSubMerchants } from '../steps/refresh-lakala-submerchants'

const originalEnabled = process.env.LAKALA_ONBOARDING_ENABLED

function makeDb(applications: unknown[], affectedRows = 1) {
  const limit = vi.fn().mockResolvedValue(applications)
  const orderBy = vi.fn(() => ({ limit }))
  const whereSelect = vi.fn(() => ({ orderBy }))
  const from = vi.fn(() => ({ where: whereSelect }))
  const select = vi.fn(() => ({ from }))

  const updateWhere = vi.fn().mockResolvedValue({ count: affectedRows })
  const updateSet = vi.fn(() => ({ where: updateWhere }))
  const update = vi.fn(() => ({ set: updateSet }))

  const insertValues = vi.fn().mockResolvedValue({ count: 1 })
  const insert = vi.fn(() => ({ values: insertValues }))
  const execute = vi.fn().mockResolvedValue({ rows: [] })

  return {
    db: { select, update, insert, execute },
    select,
    orderBy,
    whereSelect,
    update,
    updateSet,
    updateWhere,
    insert,
    insertValues,
    execute,
  }
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    id: 'loa_test_1',
    merCupNo: 'merchant-should-not-be-logged',
    channelData: {},
    submittedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe('cron-worker STEP - refreshLakalaSubMerchants', () => {
  beforeEach(() => {
    queryChannels.mockReset()
    delete process.env.LAKALA_ONBOARDING_ENABLED
  })

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.LAKALA_ONBOARDING_ENABLED
    else process.env.LAKALA_ONBOARDING_ENABLED = originalEnabled
  })

  it('功能关闭时不读取申请、不调用拉卡拉', async () => {
    const { db, select } = makeDb([])

    const result = await refreshLakalaSubMerchants(db as never)

    expect(result).toEqual({
      eligible: 0,
      checked: 0,
      completed: 0,
      timedOut: 0,
      failed: 0,
      skippedDisabled: true,
    })
    expect(select).not.toHaveBeenCalled()
    expect(queryChannels).not.toHaveBeenCalled()
  })

  it('候选查询在 LIMIT 前排除完成和超时记录，并优先轮询未检查申请', async () => {
    process.env.LAKALA_ONBOARDING_ENABLED = 'true'
    const fixture = makeDb([])

    await refreshLakalaSubMerchants(fixture.db as never)

    const condition = (fixture.whereSelect.mock.calls as unknown as Array<[SQL]>)[0]?.[0]
    expect(condition).toBeDefined()
    const whereQuery = new PgDialect().sqlToQuery(condition!)
    expect(whereQuery.sql).toContain('channel_data')
    expect(whereQuery.sql).toContain("NOT IN ('DONE', 'TIMEOUT')")
    const order = (fixture.orderBy.mock.calls as unknown as Array<[SQL, ...SQL[]]>)[0]?.[0]
    expect(order).toBeDefined()
    const orderQuery = new PgDialect().sqlToQuery(order!)
    expect(orderQuery.sql).toContain('NULLS FIRST')
  })

  it('渠道号返回成功时只写脱敏摘要并使用乐观锁更新申请', async () => {
    process.env.LAKALA_ONBOARDING_ENABLED = 'true'
    queryChannels.mockResolvedValue({
      success: true,
      wechat: [{ subMerchantNo: 'wx-private-id' }],
      alipay: [{ subMerchantNo: 'ali-private-id' }],
      raw: { merchant_no: 'must-not-be-persisted' },
    })
    const fixture = makeDb([application()])

    const result = await refreshLakalaSubMerchants(fixture.db as never)

    expect(result).toMatchObject({
      eligible: 1,
      checked: 1,
      completed: 1,
      timedOut: 0,
      failed: 0,
      skippedDisabled: false,
    })
    expect(queryChannels).toHaveBeenCalledWith({ merchantNo: 'merchant-should-not-be-logged' })

    const logPayload = (fixture.insertValues.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0]
    expect(JSON.stringify(logPayload)).not.toContain('merchant-should-not-be-logged')
    expect(JSON.stringify(logPayload)).not.toContain('must-not-be-persisted')
    expect(logPayload.responsePayloadMasked).toMatchObject({
      success: true,
      wechatCount: 1,
      alipayCount: 1,
    })

    const updatePayload = (fixture.updateSet.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0]
    expect(updatePayload.channelData).toMatchObject({
      subMerchantPolling: { status: 'DONE' },
    })
    expect(fixture.updateWhere).toHaveBeenCalledOnce()
  })

  it('超过 72 小时的申请停止轮询且不调用外部接口', async () => {
    process.env.LAKALA_ONBOARDING_ENABLED = 'true'
    const old = new Date(Date.now() - 73 * 60 * 60 * 1000)
    const fixture = makeDb([application({ submittedAt: old, createdAt: old, updatedAt: old })])

    const result = await refreshLakalaSubMerchants(fixture.db as never)

    expect(result).toMatchObject({ eligible: 1, timedOut: 1, checked: 0 })
    expect(queryChannels).not.toHaveBeenCalled()
    expect(fixture.insert).not.toHaveBeenCalled()
    const updatePayload = (fixture.updateSet.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0]
    expect(updatePayload).toMatchObject({ lastErrorCode: 'SUB_MERCHANT_POLL_TIMEOUT' })
  })

  it('进件提交已超过 72 小时但近期才审核通过时仍从首次轮询起算', async () => {
    process.env.LAKALA_ONBOARDING_ENABLED = 'true'
    queryChannels.mockResolvedValue({
      success: false,
      wechat: [],
      alipay: [],
      errorCode: 'NOT_READY',
      errorMessage: '渠道报备尚未完成',
      raw: {},
    })
    const submittedAt = new Date(Date.now() - 73 * 60 * 60 * 1000)
    const updatedAt = new Date()
    const fixture = makeDb([application({ submittedAt, createdAt: submittedAt, updatedAt })])

    const result = await refreshLakalaSubMerchants(fixture.db as never)

    expect(result).toMatchObject({ eligible: 1, timedOut: 0, checked: 1, failed: 1 })
    expect(queryChannels).toHaveBeenCalledWith({ merchantNo: 'merchant-should-not-be-logged' })
    const updatePayload = (fixture.updateSet.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0]
    expect(updatePayload.channelData).toMatchObject({
      subMerchantPolling: { status: 'WAITING', startedAt: updatedAt.toISOString() },
    })
  })
})
