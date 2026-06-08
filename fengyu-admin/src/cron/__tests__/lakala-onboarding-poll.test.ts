/**
 * 拉卡拉商户入网回调兜底 cron 测试（plan §7.1）
 *
 * 覆盖：
 *   段 1 进件状态扫描
 *     - 无 pending 商户 → scannedMerchant=0
 *     - WAIT_FOR_CONTACT 推进 submitted → approved + UPDATE merchant_no/term_no
 *     - 未知 contractStatus → 仅刷 last_query_at，不推进
 *     - nextState 抛 TransitionError → 仅刷 last_query_at + 写日志，不阻塞下一行
 *     - 拉卡拉接口抛错 → errors++ 不阻塞其他商户
 *     - 缺 contractId 或 orgCode → 跳过查询（不调拉卡拉）
 *
 *   段 2 实名报备扫描
 *     - 无 realname_pending → scannedRealname=0
 *     - 没拿到 merchant_no 的行 → skip
 *     - wx + alipay 同时已 success 的不再调拉卡拉
 *     - 仅 wx 成功（alipay 仍 submitted）→ 不推进主状态机
 *     - wx + alipay 双 success → 推进主状态机 realname_pending → completed
 *     - 拉卡拉接口部分失败（一通道 reject）→ 另一通道继续推进
 *
 *   并发：每行处理走 db.transaction + SELECT FOR UPDATE
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// 让所有用例默认有 LAKALA_ORG_CODE，否则 poll 跳过查询
vi.stubEnv('LAKALA_ORG_CODE', '1')

// —— vi.mock 必须在 import poll 之前声明 ——

const queryMerchantMock = vi.fn()
const queryWxRealnameMock = vi.fn()
const queryAlipayRealnameMock = vi.fn()
vi.mock('@/lib/lakala-client', () => ({
  queryMerchant: (args: unknown) => queryMerchantMock(args),
  queryWxRealname: (args: unknown) => queryWxRealnameMock(args),
  queryAlipayRealname: (args: unknown) => queryAlipayRealnameMock(args),
}))

const nextStateMock = vi.fn<(current: string, event: string) => string>()
vi.mock('@/lib/lakala-onboarding-state', () => {
  class FakeTransitionError extends Error {
    override name = 'TransitionError'
    constructor(public current: string, public event: string) {
      super(`Illegal transition: ${current} + ${event}`)
    }
  }
  return {
    nextState: (c: string, e: string) => nextStateMock(c, e),
    TransitionError: FakeTransitionError,
  }
})

const redactMock = vi.fn((v: unknown) => v)
vi.mock('@/lib/lakala-redact', () => ({
  redact: (v: unknown) => redactMock(v),
}))

const dbExecuteMock = vi.fn()
const txExecuteMock = vi.fn()
const dbTransactionMock = vi.fn(
  async (fn: (tx: { execute: typeof txExecuteMock }) => Promise<unknown>) => {
    return fn({ execute: txExecuteMock })
  },
)
vi.mock('@/db', () => ({
  db: {
    get execute() {
      return dbExecuteMock
    },
    get transaction() {
      return dbTransactionMock
    },
  },
}))
const mockDb = {
  execute: dbExecuteMock,
  transaction: dbTransactionMock,
}

import { pollLakalaOnboarding } from '../lakala-onboarding-poll'

describe('cron · pollLakalaOnboarding', () => {
  beforeEach(() => {
    queryMerchantMock.mockReset()
    queryWxRealnameMock.mockReset()
    queryAlipayRealnameMock.mockReset()
    nextStateMock.mockReset()
    redactMock.mockReset().mockImplementation((v) => v)
    dbExecuteMock.mockReset()
    txExecuteMock.mockReset()
    dbTransactionMock.mockClear()
  })

  it('A. 全部段无 pending → 不调拉卡拉', async () => {
    dbExecuteMock
      .mockResolvedValueOnce([]) // 段 1 scan
      .mockResolvedValueOnce([]) // 段 2 scan

    const result = await pollLakalaOnboarding(mockDb as never)
    expect(result.scannedMerchant).toBe(0)
    expect(result.scannedRealname).toBe(0)
    expect(result.advancedMerchant).toBe(0)
    expect(result.advancedRealname).toBe(0)
    expect(queryMerchantMock).not.toHaveBeenCalled()
    expect(queryWxRealnameMock).not.toHaveBeenCalled()
    expect(queryAlipayRealnameMock).not.toHaveBeenCalled()
  })

  it('B. 段 1：WAIT_FOR_CONTACT 推进 submitted → approved，UPDATE merchant_no/term_no', async () => {
    dbExecuteMock
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          out_org_code: 'lm-1-code',
          onboarding_status: 'submitted',
          merchant_no: null,
          term_no: null,
          last_req_ids: { addMerContractId: 'CID-1' },
        },
      ])
      .mockResolvedValueOnce([]) // 段 2 scan 空

    queryMerchantMock.mockResolvedValue({
      code: '000000',
      msg: 'ok',
      resp_data: {
        contractStatus: 'WAIT_FOR_CONTACT',
        merInnerNo: '822100001',
        termDatas: [{ termNo: 'T001' }],
      },
    })
    nextStateMock.mockReturnValue('approved')

    // tx: SELECT FOR UPDATE → INSERT log → UPDATE merchants
    txExecuteMock
      .mockResolvedValueOnce([{ id: 'lm-1', onboarding_status: 'submitted' }])
      .mockResolvedValueOnce([]) // INSERT log
      .mockResolvedValueOnce([]) // UPDATE merchants

    const result = await pollLakalaOnboarding(mockDb as never)
    expect(result.scannedMerchant).toBe(1)
    expect(result.advancedMerchant).toBe(1)
    expect(result.errors).toBe(0)
    expect(nextStateMock).toHaveBeenCalledWith('submitted', 'callback_approved')

    // 验证 tx 序列
    expect(txExecuteMock).toHaveBeenCalledTimes(3)
    expect(stringifySql(txExecuteMock.mock.calls[0][0])).toMatch(/FOR UPDATE/i)
    expect(stringifySql(txExecuteMock.mock.calls[1][0])).toMatch(/INSERT INTO lakala_merchant_logs/i)
    const updateText = stringifySql(txExecuteMock.mock.calls[2][0])
    expect(updateText).toMatch(/UPDATE\s+lakala_merchants/i)
    expect(updateText).toMatch(/onboarding_status\s*=/i)
    expect(updateText).toMatch(/merchant_no\s*=/i)
    expect(updateText).toMatch(/term_no\s*=/i)
  })

  it('C. 段 1：REVIEW_ING 不映射事件 → 仅刷 last_query_at，不推进', async () => {
    dbExecuteMock
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          out_org_code: 'c1',
          onboarding_status: 'submitted',
          merchant_no: null,
          term_no: null,
          last_req_ids: { addMerContractId: 'CID-1' },
        },
      ])
      .mockResolvedValueOnce([])

    queryMerchantMock.mockResolvedValue({
      code: '000000',
      msg: 'ok',
      resp_data: { contractStatus: 'REVIEW_ING' },
    })

    txExecuteMock
      .mockResolvedValueOnce([{ id: 'lm-1', onboarding_status: 'submitted' }])
      .mockResolvedValueOnce([]) // log
      .mockResolvedValueOnce([]) // UPDATE last_query_at only

    const result = await pollLakalaOnboarding(mockDb as never)
    expect(result.advancedMerchant).toBe(0)
    expect(nextStateMock).not.toHaveBeenCalled()
  })

  it('D. 段 1：未知 contractStatus → 仅刷 last_query_at，不推进', async () => {
    dbExecuteMock
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          out_org_code: 'c1',
          onboarding_status: 'submitted',
          merchant_no: null,
          term_no: null,
          last_req_ids: { addMerContractId: 'CID-1' },
        },
      ])
      .mockResolvedValueOnce([])

    queryMerchantMock.mockResolvedValue({
      code: '000000',
      msg: 'ok',
      resp_data: { contractStatus: 'WEIRD_STATUS' },
    })

    txExecuteMock
      .mockResolvedValueOnce([{ id: 'lm-1', onboarding_status: 'submitted' }])
      .mockResolvedValueOnce([]) // log
      .mockResolvedValueOnce([]) // UPDATE last_query_at only

    const result = await pollLakalaOnboarding(mockDb as never)
    expect(result.scannedMerchant).toBe(1)
    expect(result.advancedMerchant).toBe(0)
    expect(nextStateMock).not.toHaveBeenCalled()
    const updateText = stringifySql(txExecuteMock.mock.calls[2][0])
    expect(updateText).toMatch(/last_query_at\s*=\s*NOW/i)
    // 不应包含 onboarding_status 推进
    expect(updateText).not.toMatch(/onboarding_status\s*=\s*\?/i)
  })

  it('E. 段 1：nextState 抛 TransitionError → 仅刷 last_query_at（不阻塞下一行）', async () => {
    dbExecuteMock
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          out_org_code: 'c1',
          onboarding_status: 'completed',
          merchant_no: null,
          term_no: null,
          last_req_ids: { addMerContractId: 'CID-1' },
        },
      ])
      .mockResolvedValueOnce([])

    queryMerchantMock.mockResolvedValue({
      code: '000000',
      msg: 'ok',
      resp_data: { contractStatus: 'WAIT_FOR_CONTACT' },
    })
    // 模拟 TransitionError —— 必须有 name='TransitionError' 让 poll 识别
    const transitionErr = Object.assign(
      new Error('illegal: completed + callback_approved'),
      { name: 'TransitionError' },
    )
    nextStateMock.mockImplementation(() => {
      throw transitionErr
    })

    txExecuteMock
      .mockResolvedValueOnce([{ id: 'lm-1', onboarding_status: 'completed' }])
      .mockResolvedValueOnce([]) // log
      .mockResolvedValueOnce([]) // last_query_at

    const result = await pollLakalaOnboarding(mockDb as never)
    expect(result.scannedMerchant).toBe(1)
    expect(result.advancedMerchant).toBe(0)
    expect(result.errors).toBe(0)
  })

  it('F. 段 1：拉卡拉抛错 → errors++ 不阻塞下一行', async () => {
    dbExecuteMock
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          out_org_code: 'c1',
          onboarding_status: 'submitted',
          merchant_no: null,
          term_no: null,
          last_req_ids: { addMerContractId: 'CID-1' },
        },
        {
          id: 'lm-2',
          out_org_code: 'c2',
          onboarding_status: 'submitted',
          merchant_no: null,
          term_no: null,
          last_req_ids: { addMerContractId: 'CID-2' },
        },
      ])
      .mockResolvedValueOnce([])

    queryMerchantMock
      .mockRejectedValueOnce(new Error('LAKALA_TIMEOUT'))
      .mockResolvedValueOnce({
        code: '000000',
        msg: 'ok',
        resp_data: {
          contractStatus: 'WAIT_FOR_CONTACT',
          merInnerNo: 'M2',
          termDatas: [{ termNo: 'T2' }],
        },
      })
    nextStateMock.mockReturnValue('approved')

    txExecuteMock
      // 第一行抛错前就 catch 了，不进入 tx
      // 第二行 tx
      .mockResolvedValueOnce([{ id: 'lm-2', onboarding_status: 'submitted' }])
      .mockResolvedValueOnce([]) // log
      .mockResolvedValueOnce([]) // UPDATE

    const result = await pollLakalaOnboarding(mockDb as never)
    expect(result.scannedMerchant).toBe(2)
    expect(result.advancedMerchant).toBe(1)
    expect(result.errors).toBe(1)
  })

  // —— 段 2：实名扫描 ——

  it('G. 段 2：无 merchant_no 行 → skip 不调拉卡拉', async () => {
    dbExecuteMock
      .mockResolvedValueOnce([]) // 段 1 空
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          out_org_code: 'c1',
          merchant_no: null, // 没 merInnerNo
          wx_sub_mchid: null,
          alipay_sub_mchid: null,
          wx_realname_status: 'submitted',
          alipay_realname_status: 'submitted',
        },
      ])

    const result = await pollLakalaOnboarding(mockDb as never)
    expect(result.scannedRealname).toBe(1)
    expect(result.advancedRealname).toBe(0)
    expect(queryWxRealnameMock).not.toHaveBeenCalled()
    expect(queryAlipayRealnameMock).not.toHaveBeenCalled()
  })

  it('H. 段 2：wx + alipay 双 success → 推进主状态机 completed', async () => {
    dbExecuteMock
      .mockResolvedValueOnce([]) // 段 1 空
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          out_org_code: 'c1',
          merchant_no: 'M1',
          wx_sub_mchid: 'wxsub1',
          alipay_sub_mchid: 'alisub1',
          wx_realname_status: 'submitted',
          alipay_realname_status: 'submitted',
        },
      ])

    queryWxRealnameMock.mockResolvedValue({
      code: '000000',
      msg: 'ok',
      resp_data: {
        applymentState: 'APPLYMENT_STATE_PASSED',
        authorizeState: 'AUTHORIZE_STATE_AUTHORIZED',
      },
    })
    queryAlipayRealnameMock.mockResolvedValue({
      code: '000000',
      msg: 'ok',
      resp_data: {
        applymentState: 'AUDIT_PASS',
        authorizeState: 'AUTHORIZED',
      },
    })
    nextStateMock.mockReturnValue('completed')

    txExecuteMock
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          onboarding_status: 'realname_pending',
          wx_realname_status: 'submitted',
          alipay_realname_status: 'submitted',
        },
      ])
      .mockResolvedValueOnce([]) // wx log
      .mockResolvedValueOnce([]) // alipay log
      .mockResolvedValueOnce([]) // UPDATE merchants

    const result = await pollLakalaOnboarding(mockDb as never)
    expect(result.advancedRealname).toBe(1)
    expect(nextStateMock).toHaveBeenCalledWith('realname_pending', 'realname_success')

    const updateText = stringifySql(txExecuteMock.mock.calls[3][0])
    expect(updateText).toMatch(/wx_realname_status\s*=/i)
    expect(updateText).toMatch(/alipay_realname_status\s*=/i)
    expect(updateText).toMatch(/onboarding_status\s*=/i)
  })

  it('I. 段 2：仅 wx 成功，alipay 仍 submitted → 不推进主状态机', async () => {
    dbExecuteMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          out_org_code: 'c1',
          merchant_no: 'M1',
          wx_sub_mchid: 'wxsub1',
          alipay_sub_mchid: 'alisub1',
          wx_realname_status: 'submitted',
          alipay_realname_status: 'submitted',
        },
      ])

    queryWxRealnameMock.mockResolvedValue({
      code: '000000',
      msg: 'ok',
      resp_data: {
        applymentState: 'APPLYMENT_STATE_PASSED',
        authorizeState: 'AUTHORIZE_STATE_AUTHORIZED',
      },
    })
    queryAlipayRealnameMock.mockResolvedValue({
      code: '000000',
      msg: 'ok',
      resp_data: {
        applymentState: 'AUDITING',
        authorizeState: 'UNAUTHORIZED',
      },
    })

    txExecuteMock
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          onboarding_status: 'realname_pending',
          wx_realname_status: 'submitted',
          alipay_realname_status: 'submitted',
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    const result = await pollLakalaOnboarding(mockDb as never)
    expect(result.advancedRealname).toBe(1) // wx 改了 success
    // 主状态机不应被推进（只有一通道 success）
    expect(nextStateMock).not.toHaveBeenCalled()
  })

  it('J. 段 2：wx 抛错 → alipay 继续推进', async () => {
    dbExecuteMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          out_org_code: 'c1',
          merchant_no: 'M1',
          wx_sub_mchid: 'wxsub1',
          alipay_sub_mchid: 'alisub1',
          wx_realname_status: 'submitted',
          alipay_realname_status: 'submitted',
        },
      ])

    queryWxRealnameMock.mockRejectedValue(new Error('LAKALA_TIMEOUT'))
    queryAlipayRealnameMock.mockResolvedValue({
      code: '000000',
      msg: 'ok',
      resp_data: {
        applymentState: 'AUDIT_PASS',
        authorizeState: 'AUTHORIZED',
      },
    })

    txExecuteMock
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          onboarding_status: 'realname_pending',
          wx_realname_status: 'submitted',
          alipay_realname_status: 'submitted',
        },
      ])
      .mockResolvedValueOnce([]) // wx log (error)
      .mockResolvedValueOnce([]) // alipay log
      .mockResolvedValueOnce([]) // UPDATE

    const result = await pollLakalaOnboarding(mockDb as never)
    expect(result.advancedRealname).toBe(1) // alipay 改了
    expect(result.errors).toBe(0) // Promise.allSettled 兜底，不算 error
  })

  it('K. 段 2：跳过已 success 的通道 → 不重复调拉卡拉', async () => {
    dbExecuteMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          out_org_code: 'c1',
          merchant_no: 'M1',
          wx_sub_mchid: 'wxsub1',
          alipay_sub_mchid: 'alisub1',
          wx_realname_status: 'success', // 已 success
          alipay_realname_status: 'submitted',
        },
      ])

    queryAlipayRealnameMock.mockResolvedValue({
      code: '000000',
      msg: 'ok',
      resp_data: {
        applymentState: 'AUDIT_PASS',
        authorizeState: 'AUTHORIZED',
      },
    })
    nextStateMock.mockReturnValue('completed')

    txExecuteMock
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          onboarding_status: 'realname_pending',
          wx_realname_status: 'success',
          alipay_realname_status: 'submitted',
        },
      ])
      .mockResolvedValueOnce([]) // alipay log
      .mockResolvedValueOnce([]) // UPDATE

    await pollLakalaOnboarding(mockDb as never)
    expect(queryWxRealnameMock).not.toHaveBeenCalled()
    expect(queryAlipayRealnameMock).toHaveBeenCalledTimes(1)
  })

  // —— 通用 ——

  it('L. 段 1 SQL 形态：扫描 submitted/callback_pending/appealing', async () => {
    dbExecuteMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    await pollLakalaOnboarding(mockDb as never)
    const scanSql = stringifySql(dbExecuteMock.mock.calls[0][0])
    expect(scanSql).toMatch(/onboarding_status\s+IN\s*\(\s*'submitted'\s*,\s*'callback_pending'\s*,\s*'appealing'\s*\)/i)
  })

  it("M. 段 2 SQL 形态：扫描 onboarding_status = 'realname_pending'", async () => {
    dbExecuteMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    await pollLakalaOnboarding(mockDb as never)
    const scanSql = stringifySql(dbExecuteMock.mock.calls[1][0])
    expect(scanSql).toMatch(/onboarding_status\s*=\s*'realname_pending'/i)
  })

  it('N. 段 1：SELECT FOR UPDATE 锁行（并发保护）', async () => {
    dbExecuteMock
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          out_org_code: 'c1',
          onboarding_status: 'submitted',
          merchant_no: null,
          term_no: null,
          last_req_ids: { addMerContractId: 'CID-1' },
        },
      ])
      .mockResolvedValueOnce([])

    queryMerchantMock.mockResolvedValue({
      code: '000000',
      msg: 'ok',
      resp_data: { contractStatus: 'WAIT_FOR_CONTACT' },
    })
    nextStateMock.mockReturnValue('approved')

    txExecuteMock
      .mockResolvedValueOnce([{ id: 'lm-1', onboarding_status: 'submitted' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    await pollLakalaOnboarding(mockDb as never)
    const lockSql = stringifySql(txExecuteMock.mock.calls[0][0])
    expect(lockSql).toMatch(/SELECT[\s\S]+FOR UPDATE/i)
  })

  it('O. 段 1：缺 addMerContractId → 跳过查询，不调拉卡拉', async () => {
    dbExecuteMock
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          out_org_code: 'c1',
          onboarding_status: 'submitted',
          merchant_no: null,
          term_no: null,
          last_req_ids: {}, // 没 contractId
        },
      ])
      .mockResolvedValueOnce([])

    const result = await pollLakalaOnboarding(mockDb as never)
    expect(result.scannedMerchant).toBe(1)
    expect(result.advancedMerchant).toBe(0)
    expect(queryMerchantMock).not.toHaveBeenCalled()
    expect(txExecuteMock).not.toHaveBeenCalled()
  })

  it('P. 段 1：缺 LAKALA_ORG_CODE → 跳过查询', async () => {
    vi.stubEnv('LAKALA_ORG_CODE', '')

    dbExecuteMock
      .mockResolvedValueOnce([
        {
          id: 'lm-1',
          out_org_code: 'c1',
          onboarding_status: 'submitted',
          merchant_no: null,
          term_no: null,
          last_req_ids: { addMerContractId: 'CID-1' },
        },
      ])
      .mockResolvedValueOnce([])

    const result = await pollLakalaOnboarding(mockDb as never)
    expect(result.scannedMerchant).toBe(1)
    expect(result.advancedMerchant).toBe(0)
    expect(queryMerchantMock).not.toHaveBeenCalled()

    vi.stubEnv('LAKALA_ORG_CODE', '1')
  })
})

/** 从 drizzle sql 模板对象中提取拼接后的 SQL 文本 */
function stringifySql(sqlObj: unknown): string {
  if (!sqlObj || typeof sqlObj !== 'object') return ''
  const chunks = (sqlObj as { queryChunks?: unknown[] }).queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((c) => {
      if (c && typeof c === 'object' && 'value' in (c as Record<string, unknown>)) {
        const v = (c as { value: unknown }).value
        return Array.isArray(v) ? v.join('') : String(v)
      }
      if (c && typeof c === 'object' && 'queryChunks' in (c as Record<string, unknown>)) {
        return stringifySql(c)
      }
      return '?'
    })
    .join('')
}
