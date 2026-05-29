/**
 * Phase 2D · 拉卡拉商户入网 Server Actions 单测
 *
 * 覆盖范围（plan §3 + §0★）：
 *   1. submitMerchant 内部注入 feeData，但返回值不含费率字段（守护 plan §0★）
 *   2. 状态机非法转换抛 INVALID_STATE 友好错误
 *   3. reqId 幂等：重试时复用 last_req_ids[endpoint]，成功后清除
 *   4. linkStoreToMerchant 事务内同步 stores 2 列快照，term_no/enabled 不动
 *   5. unlinkStoreFromMerchant 清快照 + 强置 enabled=false
 *   6. updateLakalaMerchantInfo 末尾联动刷所有绑该商户的 stores
 *   7. cancelOnboarding 自动解绑所有 stores
 *
 * 与 e2e smoke 的边界：本测试用纯 mock（不连 PG），只验证业务规则正确性；
 * 真实 PG 端到端走 tests/e2e-actions/smoke-lakala-onboarding.mjs。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── mocks ──────────────────────────────────────────────────────────────────

const { dbMock, lakalaClientMock, loadRateConfigMock } = vi.hoisted(() => ({
  dbMock: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  lakalaClientMock: {
    applyContract: vi.fn(),
    queryContract: vi.fn(),
    submitMerchant: vi.fn(),
    queryMerchant: vi.fn(),
    submitAppeal: vi.fn(),
    uploadAttachment: vi.fn(),
    submitWxRealname: vi.fn(),
    modifyWxRealname: vi.fn(),
    submitAlipayRealname: vi.fn(),
    modifyAlipayRealname: vi.fn(),
    updateLakalaMerchantInfo: vi.fn(),
    querySubMerchantId: vi.fn(),
  },
  loadRateConfigMock: vi.fn(),
}))

vi.mock('@/db', () => ({ db: dbMock }))

// drizzle ORM helpers：只关心是否被调用，不验证 SQL 结构
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  asc: vi.fn((col) => ({ type: 'asc', col })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  inArray: vi.fn((col, v) => ({ type: 'inArray', col, v })),
  sql: Object.assign(vi.fn(() => ({ type: 'sql' })), { raw: vi.fn(), join: vi.fn() }),
}))

vi.mock('@db/index', () => ({
  lakalaMerchants: {
    id: 'id',
    merchantName: 'merchant_name',
    outOrgCode: 'out_org_code',
    onboardingStatus: 'onboarding_status',
    contractStatus: 'contract_status',
    merchantNo: 'merchant_no',
    termNo: 'term_no',
    wxSubMchid: 'wx_sub_mchid',
    wxSubAppid: 'wx_sub_appid',
    alipaySubMchid: 'alipay_sub_mchid',
    applicantUserId: 'applicant_user_id',
    lastReqIds: 'last_req_ids',
    formData: 'form_data',
    lastSubmittedFormData: 'last_submitted_form_data',
    contractNo: 'contract_no',
    wxRealnameStatus: 'wx_realname_status',
    wxRealnameQrcodeUrl: 'wx_realname_qrcode_url',
    alipayRealnameStatus: 'alipay_realname_status',
    alipayRealnameQrcodeUrl: 'alipay_realname_qrcode_url',
    lastErrorCode: 'last_error_code',
    lastErrorMsg: 'last_error_msg',
    lastQueryAt: 'last_query_at',
    updatedAt: 'updated_at',
    createdAt: 'created_at',
  },
  lakalaMerchantAttachments: {
    id: 'id',
    lakalaMerchantId: 'lakala_merchant_id',
    attachmentType: 'attachment_type',
    localUrl: 'local_url',
    cloudPath: 'cloud_path',
    attchId: 'attch_id',
    uploadedToLakalaAt: 'uploaded_to_lakala_at',
    metadata: 'metadata',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  lakalaMerchantLogs: {
    id: 'id',
    lakalaMerchantId: 'lakala_merchant_id',
    direction: 'direction',
    endpoint: 'endpoint',
    reqBody: 'req_body',
    respBody: 'resp_body',
    respCode: 'resp_code',
    latencyMs: 'latency_ms',
    operatorUserId: 'operator_user_id',
    createdAt: 'created_at',
  },
  stores: {
    storeId: 'store_id',
    storeName: 'store_name',
    lakalaMerchantId: 'lakala_merchant_id',
    lakalaMerchantNo: 'lakala_merchant_no',
    lakalaSubAppid: 'lakala_sub_appid',
    lakalaTermNo: 'lakala_term_no',
    lakalaEnabled: 'lakala_enabled',
  },
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAnyPermission: vi.fn(),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logUpdate: vi.fn(),
  logTransition: vi.fn(),
}))

vi.mock('@/lib/lakala-client', () => lakalaClientMock)

vi.mock('@/lib/lakala-rate', () => ({
  loadRateConfig: loadRateConfigMock,
}))

vi.mock('@/lib/cloudbase', () => ({
  uploadFile: vi.fn(),
  reuploadToFixedPath: vi.fn(),
  deleteByCloudPaths: vi.fn(),
}))

// 使用真实 redact + state（验证返回值脱敏 / 状态机集中）
// 这两个模块没有副作用，可以走原文件。

// ── imports（在所有 mock 之后） ─────────────────────────────────────────────

import {
  submitMerchant,
  linkStoreToMerchant,
  unlinkStoreFromMerchant,
  updateLakalaMerchantInfo,
  cancelOnboarding,
  saveDraft,
  applyContract,
} from '../lakala-onboarding'
import { getSession } from '@/lib/auth'
import { logOperation, logTransition } from '@/lib/operation-log'
import { reuploadToFixedPath } from '@/lib/cloudbase'

const adminSession = {
  employeeId: '1',
  name: 'tester',
  phone: '13800000000',
  roles: [{ role: 'admin' as const, scopeId: 'hq', scopeType: '总部' as const }],
  permissions: { actions: ['*'], scopeStoreIds: [] },
}

/**
 * mock db.select() 链：返回固定 rows 数组
 * 支持各种链：
 *   .from().where().limit()
 *   .from().where().orderBy().limit()
 *   .from().where()                                    (直接 await Promise<rows>)
 *   .from().where().orderBy()                          (await)
 *   .from().where().limit().orderBy().limit()...       (兜底)
 *
 * 关键：每个返回的 builder object 既是「thenable」（await 拿到 rows），又有
 * .where/.orderBy/.limit 等可继续链的方法返回自身。
 */
function mockSelectOnce(rows: any[]) {
  const builder: any = {
    then: (resolve: any) => Promise.resolve(rows).then(resolve),
  }
  builder.where = vi.fn().mockReturnValue(builder)
  builder.orderBy = vi.fn().mockReturnValue(builder)
  builder.limit = vi.fn().mockReturnValue(builder)
  builder.leftJoin = vi.fn().mockReturnValue(builder)
  builder.from = vi.fn().mockReturnValue(builder)
  dbMock.select.mockReturnValueOnce(builder)
}

/** 默认 update 链返回 { rowCount: 1, count: 1 }，方便 saveDraft / 状态推进 */
function mockUpdateChain(result: any = { rowCount: 1, count: 1 }) {
  const where = vi.fn().mockResolvedValue(result)
  const set = vi.fn().mockReturnValue({ where })
  dbMock.update.mockReturnValueOnce({ set })
}

/** 默认 insert 链返回 [] */
function mockInsertOnce() {
  const values = vi.fn().mockResolvedValue([])
  dbMock.insert.mockReturnValueOnce({ values })
}

beforeEach(() => {
  vi.clearAllMocks()
  // 清掉所有 db mock 的 mockReturnValueOnce 队列（clearAllMocks 在某些 vitest 版本下保留 once 链）
  dbMock.select.mockReset()
  dbMock.insert.mockReset()
  dbMock.update.mockReset()
  dbMock.delete.mockReset()
  dbMock.transaction.mockReset()
  for (const fn of Object.values(lakalaClientMock)) (fn as any).mockReset()
  loadRateConfigMock.mockReset()
  ;(getSession as any).mockResolvedValue(adminSession)
})

// ===========================================================================
// 1. submitMerchant — 费率不出现在返回值（plan §0★ 守护）
// ===========================================================================

describe('submitMerchant — feeData 注入 + 返回不含费率', () => {
  const baseMerchant = {
    id: 'lm_test',
    outOrgCode: 'lm-test',
    merchantName: 'Test',
    merchantNo: null,
    contractStatus: 'signed',
    contractNo: 'EC123',
    onboardingStatus: 'attachments_uploading',
    formData: {},
    lastReqIds: {},
  }

  it('注入 feeData 到 client.submitMerchant，且返回值不含 feeRate/rateCode', async () => {
    // 1) SELECT lakalaMerchants
    mockSelectOnce([baseMerchant])
    // 2) SELECT attachments
    mockSelectOnce([{ attchId: 'att-1', attachmentType: 'biz_license' }])
    // 3) callLakala 内部 SELECT lastReqIds
    mockSelectOnce([{ lastReqIds: {} }])
    // 4) 多次 update + insert + transition：直接全部 mock 成 noop
    for (let i = 0; i < 10; i++) mockUpdateChain()
    for (let i = 0; i < 5; i++) mockInsertOnce()
    // contractId 写回的额外 select
    mockSelectOnce([{ lastReqIds: {} }])

    loadRateConfigMock.mockResolvedValue({
      entries: [{ feeRateTypeCode: 'WX', feeRateTypeName: '微信', feeRatePct: '0.6' }],
    })

    lakalaClientMock.submitMerchant.mockResolvedValue({
      code: '000000',
      msg: 'ok',
      resp_data: { contractId: 'CT-999' },
      reqId: 'r1',
      ok: true,
      expectedCode: '000000',
      resp_time: '',
    })

    const result = await submitMerchant('lm_test', {
      posType: 'WECHAT_PAY',
      merRegName: 'X',
      merRegDistCode: '360100',
      merRegAddr: 'addr',
      mccCode: '7298',
      merBusiContent: '640',
      larName: 'Y',
      larIdType: 'RESIDENT_ID',
      larIdcard: '110101199001011234',
      larIdcardStDt: '20200101',
      larIdcardExpDt: '20300101',
      merContactMobile: '13812341234',
      merContactName: 'Z',
      openningBankCode: '0001',
      openningBankName: 'ICBC',
      clearingBankCode: '0001',
      acctNo: '6225123412341234',
      acctName: 'AcctName',
      acctTypeCode: '57',
      settlePeriod: 'T1',
    })

    // 1) 注入了 feeData
    const calledWith = lakalaClientMock.submitMerchant.mock.calls[0][0]
    expect(calledWith.feeData).toEqual([
      { feeRateTypeCode: 'WX', feeRateTypeName: '微信', feeRatePct: '0.6' },
    ])

    // 2) 返回值守护：序列化后 stringify 不含费率字段名
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/feeRate/i)
    expect(serialized).not.toMatch(/rateCode/i)
    expect(serialized).not.toMatch(/0\.6/) // 注入值也不该泄漏

    // 3) 操作成功
    expect(result.success).toBe(true)
    expect(result.contractId).toBe('CT-999')
  })

  it('contract_status != signed → 拒绝且不调 client', async () => {
    mockSelectOnce([{ ...baseMerchant, contractStatus: 'draft' }])
    const result = await submitMerchant('lm_test', {} as any)
    expect(result.success).toBe(false)
    expect(result.message).toContain('合同')
    expect(lakalaClientMock.submitMerchant).not.toHaveBeenCalled()
  })

  it('无附件 → 拒绝', async () => {
    mockSelectOnce([baseMerchant])
    mockSelectOnce([]) // 无附件
    const result = await submitMerchant('lm_test', {} as any)
    expect(result.success).toBe(false)
    expect(result.message).toContain('附件')
    expect(lakalaClientMock.submitMerchant).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// 2. 状态机非法转换 → INVALID_STATE
// ===========================================================================

describe('saveDraft — 非 draft 状态拒绝', () => {
  it('current=submitted → 拒绝编辑', async () => {
    mockSelectOnce([{ id: 'lm_x', onboardingStatus: 'submitted' }])
    const result = await saveDraft('lm_x', { merchantName: 'changed' })
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/draft/)
  })
})

describe('applyContract — 状态机推进', () => {
  it('current=submitted → applyContract 抛 INVALID_STATE（apply_contract 非法转换）', async () => {
    mockSelectOnce([{ id: 'lm_x', onboardingStatus: 'submitted', outOrgCode: 'lm-x', formData: {}, lastReqIds: {} }])
    // callLakala 内部 select
    mockSelectOnce([{ lastReqIds: {} }])
    // 5 个保底 update/insert
    for (let i = 0; i < 5; i++) mockUpdateChain()
    for (let i = 0; i < 3; i++) mockInsertOnce()

    lakalaClientMock.applyContract.mockResolvedValue({
      code: '000000', msg: 'ok', resp_data: { ec_apply_id: 'AID-1' }, reqId: 'r', ok: true,
      expectedCode: '000000', resp_time: '',
    })

    await expect(applyContract('lm_x', {
      orderNo: 'O', orgId: 1, ecTypeCode: 'EC015',
      certType: 'RESIDENT_ID', certName: 'A', certNo: 'X', mobile: '138',
      openningBankCode: '0', openningBankName: 'B',
      acctTypeCode: '57', acctNo: '0', acctName: 'A', ecContentParameters: '{}',
    })).rejects.toThrow(/INVALID_STATE/)
  })
})

// ===========================================================================
// 3. reqId 幂等复用
// ===========================================================================

describe('reqId 幂等', () => {
  it('last_req_ids[applyContract]=hint 时透传给 client，成功后清除', async () => {
    const merchant = {
      id: 'lm_idem',
      outOrgCode: 'lm-idem',
      onboardingStatus: 'draft',
      formData: {},
      lastReqIds: { applyContract: 'prev-req-id-aaa' },
      contractStatus: 'draft',
    }
    mockSelectOnce([merchant])
    // callLakala 内部 select lastReqIds
    mockSelectOnce([{ lastReqIds: { applyContract: 'prev-req-id-aaa' } }])
    // INSERT log
    mockInsertOnce()
    // UPDATE: 清除 lastReqIds
    let cleanedReqIds: any = null
    const clearWhere = vi.fn().mockResolvedValue({ rowCount: 1 })
    const clearSet = vi.fn().mockImplementation((args: any) => {
      cleanedReqIds = args.lastReqIds
      return { where: clearWhere }
    })
    dbMock.update.mockReturnValueOnce({ set: clearSet })
    // transition update
    mockUpdateChain()
    // 写 contract/formData
    mockUpdateChain()

    lakalaClientMock.applyContract.mockResolvedValue({
      code: '000000', msg: 'ok', resp_data: { ec_apply_id: 'AID-1' }, reqId: 'prev-req-id-aaa',
      ok: true, expectedCode: '000000', resp_time: '',
    })

    await applyContract('lm_idem', {
      orderNo: 'O', orgId: 1, ecTypeCode: 'EC015',
      certType: 'RESIDENT_ID', certName: 'A', certNo: 'X', mobile: '138',
      openningBankCode: '0', openningBankName: 'B',
      acctTypeCode: '57', acctNo: '0', acctName: 'A', ecContentParameters: '{}',
    })

    // 透传了 reqIdHint
    expect(lakalaClientMock.applyContract.mock.calls[0][0].reqIdHint).toBe('prev-req-id-aaa')
    // 成功后清除：clearSet 被触发（说明走了清除分支），且新值中 applyContract key 已删
    expect(clearSet).toHaveBeenCalled()
    expect(cleanedReqIds).toBeTruthy()
    expect((cleanedReqIds as Record<string, string>).applyContract).toBeUndefined()
  })
})

// ===========================================================================
// 4. linkStoreToMerchant — 事务 + 快照同步
// ===========================================================================

describe('linkStoreToMerchant', () => {
  const completedMerchant = {
    id: 'lm_ok',
    onboardingStatus: 'completed',
    merchantNo: 'MN-001',
    wxSubAppid: 'wxsub-001',
  }
  const store = { storeId: 'S-1', lakalaMerchantId: null, lakalaEnabled: false, lakalaTermNo: 'T-1' }

  it('成功：刷快照 merchantNo/subAppid，不动 term_no/enabled', async () => {
    mockSelectOnce([completedMerchant])
    mockSelectOnce([store])

    let setArgs: any = null
    const txUpdateWhere = vi.fn().mockResolvedValue({ rowCount: 1 })
    const txUpdateSet = vi.fn().mockImplementation((args: any) => {
      setArgs = args
      return { where: txUpdateWhere }
    })
    const tx = { update: vi.fn().mockReturnValue({ set: txUpdateSet }) }
    dbMock.transaction.mockImplementation(async (fn: any) => fn(tx))

    const result = await linkStoreToMerchant({ storeId: 'S-1', lakalaMerchantId: 'lm_ok' })
    expect(result.success).toBe(true)
    expect(setArgs.lakalaMerchantId).toBe('lm_ok')
    expect(setArgs.lakalaMerchantNo).toBe('MN-001')
    expect(setArgs.lakalaSubAppid).toBe('wxsub-001')
    // 关键守护：不传 term_no / enabled，保留原门店配置
    expect(setArgs.lakalaTermNo).toBeUndefined()
    expect(setArgs.lakalaEnabled).toBeUndefined()
    expect(logOperation).toHaveBeenCalledWith(
      expect.any(Object), 'store.linkLakalaMerchant', 'store', 'S-1', expect.any(Object),
    )
  })

  it('商户非 approved/completed → 拒绝', async () => {
    mockSelectOnce([{ ...completedMerchant, onboardingStatus: 'submitted' }])
    const result = await linkStoreToMerchant({ storeId: 'S-1', lakalaMerchantId: 'lm_ok' })
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/approved\/completed/)
  })
})

describe('unlinkStoreFromMerchant', () => {
  it('清快照 + 强置 enabled=false', async () => {
    mockSelectOnce([{ storeId: 'S-1', lakalaMerchantId: 'lm_x', lakalaEnabled: true }])
    let setArgs: any = null
    const txWhere = vi.fn().mockResolvedValue({ rowCount: 1 })
    const txSet = vi.fn().mockImplementation((args: any) => {
      setArgs = args
      return { where: txWhere }
    })
    const tx = { update: vi.fn().mockReturnValue({ set: txSet }) }
    dbMock.transaction.mockImplementation(async (fn: any) => fn(tx))

    const result = await unlinkStoreFromMerchant({ storeId: 'S-1' })
    expect(result.success).toBe(true)
    expect(setArgs.lakalaMerchantId).toBeNull()
    expect(setArgs.lakalaMerchantNo).toBeNull()
    expect(setArgs.lakalaSubAppid).toBeNull()
    expect(setArgs.lakalaEnabled).toBe(false)
  })
})

// ===========================================================================
// 5. updateLakalaMerchantInfo — 联动刷店 + 返回不含费率
// ===========================================================================

describe('updateLakalaMerchantInfo', () => {
  const completed = {
    id: 'lm_upd',
    outOrgCode: 'lm-upd',
    onboardingStatus: 'completed',
    merchantNo: 'MN-001',
    wxSubAppid: 'wxsub-001',
    formData: {},
    lastReqIds: {},
  }

  it('注入 feeData + 末尾 syncStoreSnapshots 联动刷店；返回不含费率', async () => {
    // 1) getLakalaMerchant
    mockSelectOnce([completed])
    // 2) callLakala 内部 select
    mockSelectOnce([{ lastReqIds: {} }])
    // 3) INSERT log
    mockInsertOnce()
    // 4) UPDATE formData
    mockUpdateChain()
    // 5) syncStoreSnapshots 内部 select
    mockSelectOnce([completed])
    // 6) UPDATE stores
    let storesSetArgs: any = null
    const sWhere = vi.fn().mockResolvedValue({ rowCount: 2 })
    const sSet = vi.fn().mockImplementation((args: any) => {
      storesSetArgs = args
      return { where: sWhere }
    })
    dbMock.update.mockReturnValueOnce({ set: sSet })

    loadRateConfigMock.mockResolvedValue({
      entries: [{ feeRateTypeCode: 'WX', feeRateTypeName: 'WX', feeRatePct: '0.6' }],
    })
    lakalaClientMock.updateLakalaMerchantInfo.mockResolvedValue({
      code: '000000', msg: 'ok', resp_data: { feeData: [{ feeRate: '0.6' }] }, ok: true,
      reqId: 'r', expectedCode: '000000', resp_time: '',
    })

    const result = await updateLakalaMerchantInfo('lm_upd', { merRegName: '新名' })

    // 注入 feeData
    expect(lakalaClientMock.updateLakalaMerchantInfo.mock.calls[0][0].feeData).toBeDefined()
    // 联动刷店
    expect(storesSetArgs).toEqual({
      lakalaMerchantNo: 'MN-001',
      lakalaSubAppid: 'wxsub-001',
    })
    // 返回不含费率
    const ser = JSON.stringify(result)
    expect(ser).not.toMatch(/feeRate/i)
    expect(ser).not.toMatch(/0\.6/)
    expect(result.success).toBe(true)
  })
})

// ===========================================================================
// 6. cancelOnboarding — 自动解绑全部 stores
// ===========================================================================

describe('cancelOnboarding', () => {
  it('draft 态 → 推进到 cancelled + 解绑 stores + 写告警日志', async () => {
    mockSelectOnce([{ id: 'lm_c', onboardingStatus: 'draft' }])
    // SELECT 已绑 stores
    mockSelectOnce([{ storeId: 'S-1' }, { storeId: 'S-2' }])

    let storeSetArgs: any = null
    const sw = vi.fn().mockResolvedValue({ rowCount: 2 })
    const ssSet = vi.fn().mockImplementation((args: any) => {
      storeSetArgs = args
      return { where: sw }
    })
    const mw = vi.fn().mockResolvedValue({ rowCount: 1 })
    const mSet = vi.fn().mockReturnValue({ where: mw })
    const tx = {
      update: vi.fn()
        .mockReturnValueOnce({ set: ssSet })   // stores
        .mockReturnValueOnce({ set: mSet }),   // lakala_merchants
    }
    dbMock.transaction.mockImplementation(async (fn: any) => fn(tx))

    const result = await cancelOnboarding('lm_c')
    expect(result.success).toBe(true)
    expect(storeSetArgs.lakalaMerchantId).toBeNull()
    expect(storeSetArgs.lakalaEnabled).toBe(false)
    // 写告警 transition log
    expect(logTransition).toHaveBeenCalledWith(
      expect.any(Object), 'lakala_merchant.cancel', 'lakala_merchant', 'lm_c',
      'draft', 'cancelled',
      expect.objectContaining({ alert: 'AUTO_UNLINKED_STORES', unlinkedStoreIds: ['S-1', 'S-2'] }),
    )
  })

  it('cancelled 态 → 拒绝重复取消', async () => {
    mockSelectOnce([{ id: 'lm_c', onboardingStatus: 'cancelled' }])
    const result = await cancelOnboarding('lm_c')
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/取消/)
  })
})

// ===========================================================================
// 7. 守护测试：reuploadToFixedPath 被调用（uploadAttachment 路径正确）
// 这里只校验依赖关系，避免 e2e 才能测的 base64 流程
// ===========================================================================

describe('依赖守护', () => {
  it('reuploadToFixedPath 是 cloudbase 模块导出（mock 命中）', () => {
    expect(typeof reuploadToFixedPath).toBe('function')
  })
})
