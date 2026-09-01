import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  },
}))

vi.mock('@db/lakala', () => ({
  lakalaMerchants: {
    id: 'lakala_merchant_id',
    merchantNo: 'merchant_no',
    termNo: 'term_no',
    enabled: 'enabled',
    marketOrgNodeId: 'market_org_node_id',
  },
}))

vi.mock('@db/lakala-onboarding', () => ({
  lakalaOnboardingApplications: {
    id: 'application_id',
    storeId: 'store_id',
    status: 'application_status',
    updatedAt: 'updated_at',
    lakalaMerchantId: 'application_lakala_merchant_id',
    channelData: 'channel_data',
    subMerchantCheckedAt: 'sub_merchant_checked_at',
  },
  lakalaOnboardingAttachments: {
    id: 'attachment_id',
    applicationId: 'application_id',
    attachmentType: 'attachment_type',
    status: 'attachment_status',
    createdAt: 'created_at',
  },
  lakalaOnboardingRequestLogs: {
    id: 'request_log_id',
    applicationId: 'request_application_id',
    apiName: 'api_name',
    idempotencyKey: 'idempotency_key',
    attemptNo: 'attempt_no',
    startedAt: 'started_at',
  },
}))

vi.mock('@db/org', () => ({
  stores: {
    storeId: 'store_id',
    storeName: 'store_name',
    orgNodeId: 'org_node_id',
    lakalaMerchantId: 'store_lakala_merchant_id',
  },
  orgNodes: {
    id: 'org_node_id',
    parentId: 'parent_id',
  },
}))

vi.mock('drizzle-orm', () => {
  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ type: 'sql', strings, values })),
    { raw: vi.fn(), join: vi.fn() },
  )
  return {
    and: vi.fn((...args: unknown[]) => ({ type: 'and', args: args.filter(Boolean) })),
    asc: vi.fn((column: unknown) => ({ type: 'asc', column })),
    desc: vi.fn((column: unknown) => ({ type: 'desc', column })),
    eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
    isNull: vi.fn((column: unknown) => ({ type: 'isNull', column })),
    or: vi.fn((...args: unknown[]) => ({ type: 'or', args: args.filter(Boolean) })),
    sql,
  }
})

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))
vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAnyPermission: vi.fn(),
  scopeCondition: vi.fn(),
}))
vi.mock('@/lib/action-scope', () => ({ scopeSessionToActions: (session: unknown) => session }))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn(), logTransition: vi.fn() }))
vi.mock('@/lib/pg-error', () => ({ pgErrorCode: vi.fn(() => null) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/upload-file', () => ({
  bufferToUploadFileLike: vi.fn(),
  getPrivateUploadRoot: vi.fn(),
  readPrivateOnboardingFile: vi.fn(),
  savePrivateOnboardingFile: vi.fn(),
}))
vi.mock('@/lib/lakala-bank-directory', () => ({
  findLocalLakalaBankAreaCodes: vi.fn(),
  queryLocalLakalaBanks: vi.fn(),
  queryLocalLakalaBanksByAreaKeywords: vi.fn(),
}))
vi.mock('@/lib/lakala-onboarding-constants', () => ({
  ATTACHMENT_REQUIREMENTS: [],
  ELECTRONIC_CONTRACT_PDF_ATTACHMENT: {
    attachmentType: 'E_CONTRACT_PDF',
    displayName: 'contract.pdf',
    label: '电子合同',
  },
  MAX_ONBOARDING_ATTACHMENT_BYTES: 5 * 1024 * 1024,
  normalizeTkbsAttachmentType: vi.fn((value: string) => value),
}))
vi.mock('@/lib/lakala-onboarding', () => ({
  getEContractCallbackUrl: vi.fn(),
  getEContractOrgId: vi.fn(),
  getEContractType: vi.fn(),
  getLakalaOnboardingApiFamily: vi.fn().mockReturnValue('tkbs'),
  getOnboardingActivityId: vi.fn(),
  getOrgCode: vi.fn().mockReturnValue('TEST_ORG_CODE'),
  getOnboardingUserNo: vi.fn(),
  getServerOnboardingFeePolicy: vi.fn(),
  lakalaAddMerchant: vi.fn(),
  lakalaApplyElectronicContract: vi.fn(),
  lakalaDownloadElectronicContract: vi.fn(),
  lakalaQueryBanks: vi.fn(),
  lakalaQueryChannelSubMerchants: vi.fn(),
  lakalaQueryElectronicContract: vi.fn(),
  lakalaQueryMerchantAuthState: vi.fn(),
  lakalaQueryOcrResult: vi.fn(),
  lakalaQueryRegisterStatus: vi.fn(),
  lakalaQuerySubMerchant: vi.fn(),
  lakalaUploadFile: vi.fn(),
  maskPayload: vi.fn((value: unknown) => value),
}))

import {
  confirmOnboardingExternalCertification,
  queryOnboardingApplication,
  refreshOnboardingCertificationStatus,
  refreshOnboardingSubMerchants,
} from './lakala-onboarding'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'
import {
  lakalaQueryChannelSubMerchants,
  lakalaQueryRegisterStatus,
  lakalaQuerySubMerchant,
} from '@/lib/lakala-onboarding'
import { lakalaMerchants } from '@db/lakala'
import { lakalaOnboardingApplications } from '@db/lakala-onboarding'
import { stores } from '@db/org'

type WriteRecord = { table: unknown; values: Record<string, unknown> }

const session = {
  employeeId: 'EMP-1',
  name: '操作员',
  phone: '13800000000',
  roles: [{ role: 'admin', scopeId: 'root', scopeType: '总部', actions: ['merchant:update'] }],
  permissions: { actions: ['merchant:update'], scopeStoreIds: [] },
} as any

function scopedSelection(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows)
  const where = vi.fn().mockReturnValue({ limit })
  const innerJoin = vi.fn().mockReturnValue({ where })
  const from = vi.fn().mockReturnValue({ innerJoin })
  return { from }
}

function limitedSelection(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows)
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  return { from }
}

function updateMock(records: WriteRecord[]) {
  return (table: unknown) => ({
    set: vi.fn((values: Record<string, unknown>) => {
      records.push({ table, values })
      return {
        where: vi.fn(() => ({
          count: 1,
          returning: vi.fn().mockResolvedValue([{ storeId: 'store-1' }]),
        })),
      }
    }),
  })
}

function insertMock(records: WriteRecord[]) {
  return (table: unknown) => ({
    values: vi.fn(async (values: Record<string, unknown>) => {
      records.push({ table, values })
      return { count: 1 }
    }),
  })
}

function approvedApplication(overrides: Record<string, unknown> = {}) {
  return {
    app: {
      id: 'onb-cert',
      applicationNo: 'ONB-20260817-CERT',
      storeId: 'store-1',
      status: 'SUCCESS',
      updatedAt: new Date('2026-08-17T00:00:00.000Z'),
      merchantData: { merRegName: '凤御南昌店' },
      legalPersonData: {},
      contactData: {},
      settlementData: {},
      shopData: {},
      terminalData: { termNo: 'TERM-1' },
      merCupNo: '821234567890',
      channelData: {
        wechat: [{ subMerchantNo: 'WX-1' }],
        alipay: [{ subMerchantNo: 'ALI-1' }],
      },
      lakalaMerchantId: null,
      ...overrides,
    },
    storeName: '南昌店',
    marketName: '南昌市场',
    lakalaMerchantEnabled: false,
  }
}

function certification(registerType: 'WXZF' | 'ZFBZF', overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    registerType,
    registerState: 'SUCCESS',
    authorizeState: 'SUCCESS',
    applymentState: 'SUCCESS',
    registerCode: '000000',
    raw: {},
    ...overrides,
  }
}

function setupExternalResults(alipayOverrides: Record<string, unknown> = {}) {
  ;(lakalaQueryRegisterStatus as any).mockImplementation(({ registerType }: { registerType: 'WXZF' | 'ZFBZF' }) => (
    registerType === 'WXZF'
      ? certification('WXZF')
      : certification('ZFBZF', alipayOverrides)
  ))
}

function setupTransaction(selectRows: unknown[][] = []) {
  const writes: WriteRecord[] = []
  const inserts: WriteRecord[] = []
  const select = vi.fn()
  for (const rows of selectRows) select.mockReturnValueOnce(limitedSelection(rows))
  const tx = {
    select,
    update: vi.fn(updateMock(writes)),
    insert: vi.fn(insertMock(inserts)),
  }
  ;(db.transaction as any).mockImplementation(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx))
  return { tx, writes, inserts }
}

describe('拉卡拉入网渠道认证闭环', () => {
  let writes: WriteRecord[]

  beforeEach(() => {
    vi.clearAllMocks()
    writes = []
    ;(getSession as any).mockResolvedValue(session)
    ;(scopeCondition as any).mockReturnValue(undefined)
    ;(db.update as any).mockImplementation(updateMock(writes))
    ;(db.insert as any).mockImplementation(insertMock([]))
  })

  it('微信通过且有终端号时自动绑定并启用，支付宝不作为阻断条件', async () => {
    ;(db.select as any).mockReturnValueOnce(scopedSelection([approvedApplication()]))
    setupExternalResults({
      success: false,
      registerState: 'PROCESSING',
      registerCode: 'PROCESSING',
      errorMessage: '支付宝认证中',
    })
    const transaction = setupTransaction([
      [{ storeId: 'store-1', lakalaMerchantId: null, orgNodeId: 'store-node-1' }],
      [{ marketOrgNodeId: 'market-1' }],
      [],
    ])

    const result = await refreshOnboardingCertificationStatus('onb-cert')

    expect(result).toEqual({ success: true, message: '微信认证已通过，办理完成，收款商户已启用' })
    expect(db.select).toHaveBeenCalledWith(expect.objectContaining({
      app: lakalaOnboardingApplications,
      storeName: stores.storeName,
      marketName: expect.anything(),
      lakalaMerchantEnabled: expect.anything(),
    }))
    expect(transaction.inserts).toContainEqual(expect.objectContaining({
      table: lakalaMerchants,
      values: expect.objectContaining({ merchantNo: '821234567890', termNo: 'TERM-1', enabled: true }),
    }))
    expect(transaction.writes).toContainEqual(expect.objectContaining({
      table: lakalaOnboardingApplications,
      values: expect.objectContaining({
        channelData: expect.objectContaining({
          certificationPolling: expect.objectContaining({ status: 'DONE' }),
        }),
      }),
    }))
    expect(logOperation).toHaveBeenCalledWith(
      session,
      'merchant.onboarding.certification.complete',
      'lakala_onboarding_application',
      'onb-cert',
      expect.objectContaining({ collectionMerchantEnabled: true, alipayCertificationCompleted: false }),
    )
  })

  it('微信通过但无终端号时只记录 WAIT_TERMINAL', async () => {
    ;(db.select as any).mockReturnValueOnce(scopedSelection([
      approvedApplication({ terminalData: {} }),
    ]))
    setupExternalResults()

    const result = await refreshOnboardingCertificationStatus('onb-cert')

    expect(result.success).toBe(true)
    expect(result.message).toContain('尚未获取终端号')
    expect(db.transaction).not.toHaveBeenCalled()
    expect(writes).toContainEqual(expect.objectContaining({
      table: lakalaOnboardingApplications,
      values: expect.objectContaining({
        lastErrorMessage: expect.stringContaining('尚未获取终端号'),
        channelData: expect.objectContaining({
          certificationPolling: expect.objectContaining({ status: 'WAIT_TERMINAL' }),
        }),
      }),
    }))
  })

  it('微信通过时复用已关联的未启用商户，不重复建档', async () => {
    ;(db.select as any).mockReturnValueOnce(scopedSelection([
      approvedApplication({ lakalaMerchantId: 'merchant-1' }),
    ]))
    setupExternalResults()
    const transaction = setupTransaction([
      [{ storeId: 'store-1', lakalaMerchantId: 'merchant-1', orgNodeId: 'store-node-1' }],
      [{ marketOrgNodeId: 'market-1' }],
      [{
        id: 'merchant-1',
        merchantName: '凤御南昌店',
        merchantNo: '821234567890',
        termNo: 'TERM-1',
        enabled: false,
        marketOrgNodeId: 'market-1',
      }],
    ])

    const result = await refreshOnboardingCertificationStatus('onb-cert')

    expect(result.success).toBe(true)
    expect(transaction.inserts).toHaveLength(0)
    expect(transaction.writes).toContainEqual(expect.objectContaining({
      table: lakalaMerchants,
      values: expect.objectContaining({ enabled: true }),
    }))
  })

  it('已属于其他市场的商户不能被自动跨市场绑定', async () => {
    ;(db.select as any).mockReturnValueOnce(scopedSelection([approvedApplication()]))
    setupExternalResults()
    const transaction = setupTransaction([
      [{ storeId: 'store-1', lakalaMerchantId: null, orgNodeId: 'store-node-1' }],
      [{ marketOrgNodeId: 'market-1' }],
      [{
        id: 'merchant-other-market',
        merchantName: '其他市场商户',
        merchantNo: '821234567890',
        termNo: 'TERM-1',
        enabled: false,
        marketOrgNodeId: 'market-2',
      }],
    ])

    const result = await refreshOnboardingCertificationStatus('onb-cert')

    expect(result).toEqual({ success: false, message: '拉卡拉商户已属于其他市场，不能跨市场绑定' })
    expect(transaction.inserts).toHaveLength(0)
  })

  it('微信认证失败时在同一事务内禁用、解绑并清除申请关联', async () => {
    ;(db.select as any).mockReturnValueOnce(scopedSelection([
      approvedApplication({ lakalaMerchantId: 'merchant-1' }),
    ]))
    ;(lakalaQueryRegisterStatus as any).mockImplementation(({ registerType }: { registerType: 'WXZF' | 'ZFBZF' }) => (
      registerType === 'WXZF'
        ? certification('WXZF', { success: false, registerState: 'REJECTED', rejectReason: '法人资料不一致' })
        : certification('ZFBZF')
    ))
    const transaction = setupTransaction()

    const result = await refreshOnboardingCertificationStatus('onb-cert')

    expect(result).toEqual({ success: true, message: '微信认证未通过：法人资料不一致' })
    expect(transaction.writes).toContainEqual(expect.objectContaining({
      table: lakalaMerchants,
      values: expect.objectContaining({ enabled: false }),
    }))
    expect(transaction.writes).toContainEqual(expect.objectContaining({
      table: stores,
      values: expect.objectContaining({ lakalaMerchantId: null }),
    }))
    expect(transaction.writes).toContainEqual(expect.objectContaining({
      table: lakalaOnboardingApplications,
      values: expect.objectContaining({ lakalaMerchantId: null, lastErrorMessage: '法人资料不一致' }),
    }))
  })

  it('人工确认只校验收款标识，不调用认证查询且绑定后保持未启用', async () => {
    ;(db.select as any).mockReturnValueOnce(scopedSelection([approvedApplication()]))
    const transaction = setupTransaction([
      [{ storeId: 'store-1', lakalaMerchantId: null, orgNodeId: 'store-node-1' }],
      [{ marketOrgNodeId: 'market-1' }],
      [],
    ])

    const result = await confirmOnboardingExternalCertification('onb-cert')

    expect(result.success).toBe(true)
    expect(lakalaQueryRegisterStatus).not.toHaveBeenCalled()
    expect(transaction.inserts).toContainEqual(expect.objectContaining({
      table: lakalaMerchants,
      values: expect.objectContaining({ enabled: false }),
    }))
    expect(transaction.writes).toContainEqual(expect.objectContaining({
      table: lakalaOnboardingApplications,
      values: expect.objectContaining({
        channelData: expect.objectContaining({ externalCertificationConfirmedBy: '操作员' }),
      }),
    }))
  })

  it('无 merchant:update 权限时在读取申请前拒绝', async () => {
    ;(requirePermission as any).mockImplementationOnce(() => {
      throw new Error('PERMISSION_DENIED: 无权限')
    })

    await expect(refreshOnboardingCertificationStatus('onb-cert')).rejects.toThrow('PERMISSION_DENIED')
    expect(db.select).not.toHaveBeenCalled()
  })

  it('手动查询子商户号失败时只记录错误，不覆盖已有渠道数据', async () => {
    ;(db.select as any).mockReturnValueOnce(scopedSelection([approvedApplication()]))
    ;(lakalaQueryChannelSubMerchants as any).mockResolvedValue({
      success: false,
      wechat: [],
      alipay: [],
      errorCode: 'TEMPORARY_ERROR',
      errorMessage: '临时查询失败',
      raw: {},
    })

    const result = await refreshOnboardingSubMerchants('onb-cert')

    expect(result).toEqual({ success: false, message: '临时查询失败' })
    expect(writes).toContainEqual(expect.objectContaining({
      table: lakalaOnboardingApplications,
      values: expect.objectContaining({
        lastErrorCode: 'TEMPORARY_ERROR',
        lastErrorMessage: '临时查询失败',
      }),
    }))
    expect(writes.some((write) => Object.hasOwn(write.values, 'channelData'))).toBe(false)
  })

  it('手动查询只返回部分渠道时保留此前已取得的渠道号', async () => {
    const existingWechat = [{ subMerchantNo: 'WX-EXISTING' }]
    const returnedAlipay = [{
      subMerchantNo: 'ALI-NEW',
      registerType: 'ZFBZF',
      channelId: 'alipay',
      registerChannelName: '支付宝',
    }]
    ;(db.select as any)
      .mockReturnValueOnce(scopedSelection([approvedApplication()]))
      .mockReturnValueOnce(limitedSelection([{ channelData: { wechat: existingWechat, alipay: [] } }]))
    ;(lakalaQueryChannelSubMerchants as any).mockResolvedValue({
      success: true,
      wechat: [],
      alipay: returnedAlipay,
      raw: {},
    })

    const result = await refreshOnboardingSubMerchants('onb-cert')

    expect(result.success).toBe(true)
    expect(result.message).toContain('WX-EXISTING')
    expect(result.message).toContain('ALI-NEW')
    expect(writes).toContainEqual(expect.objectContaining({
      table: lakalaOnboardingApplications,
      values: expect.objectContaining({
        channelData: expect.objectContaining({
          wechat: [expect.objectContaining({ subMerchantNo: 'WX-EXISTING' })],
          alipay: returnedAlipay,
        }),
      }),
    }))
  })

  it('非 82 前缀商户号不能手动查询子商户号', async () => {
    ;(db.select as any).mockReturnValueOnce(scopedSelection([
      approvedApplication({ merCupNo: 'MOCK-MERCHANT' }),
    ]))

    const result = await refreshOnboardingSubMerchants('onb-cert')

    expect(result.success).toBe(false)
    expect(lakalaQueryChannelSubMerchants).not.toHaveBeenCalled()
  })

  it('手动查询进件状态不会联动查询子商户号', async () => {
    ;(db.select as any).mockReturnValueOnce(scopedSelection([approvedApplication()]))
    ;(lakalaQuerySubMerchant as any).mockResolvedValue({
      success: true,
      status: 'SUCCESS',
      merchantNo: '821234567890',
      terminalNo: 'TERM-1',
      raw: {},
    })

    const result = await queryOnboardingApplication('onb-cert')

    expect(result).toEqual({ success: true, message: '状态已更新：成功' })
    expect(lakalaQueryChannelSubMerchants).not.toHaveBeenCalled()
  })

  it('自动启用时申请关联商户与商户号持有者不一致，以商户号持有者为准并同步关联', async () => {
    ;(db.select as any).mockReturnValueOnce(scopedSelection([
      approvedApplication({ lakalaMerchantId: 'merchant-stale' }),
    ]))
    setupExternalResults()
    const transaction = setupTransaction([
      [{ storeId: 'store-1', lakalaMerchantId: 'merchant-stale', orgNodeId: 'store-node-1' }],
      [{ marketOrgNodeId: 'market-1' }],
      [{ id: 'merchant-live', marketOrgNodeId: 'market-1' }],
    ])

    const result = await refreshOnboardingCertificationStatus('onb-cert')

    expect(result.success).toBe(true)
    expect(transaction.inserts).toHaveLength(0)
    expect(transaction.writes).toContainEqual(expect.objectContaining({
      table: lakalaOnboardingApplications,
      values: expect.objectContaining({ lakalaMerchantId: 'merchant-live' }),
    }))
    expect(transaction.writes).toContainEqual(expect.objectContaining({
      table: stores,
      values: expect.objectContaining({ lakalaMerchantId: 'merchant-live' }),
    }))
  })

  it('人工确认时申请关联商户与商户号持有者不一致，改绑到商户号持有者', async () => {
    ;(db.select as any).mockReturnValueOnce(scopedSelection([
      approvedApplication({ lakalaMerchantId: 'merchant-stale' }),
    ]))
    const transaction = setupTransaction([
      [{ storeId: 'store-1', lakalaMerchantId: 'merchant-stale', orgNodeId: 'store-node-1' }],
      [{ marketOrgNodeId: 'market-1' }],
      [{ id: 'merchant-live', marketOrgNodeId: 'market-1' }],
    ])

    const result = await confirmOnboardingExternalCertification('onb-cert')

    expect(result).toEqual({ success: true, message: '已关联收款商户，状态为未启用；请到“收款商户”页手动启用' })
    expect(transaction.inserts).toHaveLength(0)
    expect(transaction.writes).toContainEqual(expect.objectContaining({
      table: lakalaOnboardingApplications,
      values: expect.objectContaining({ lakalaMerchantId: 'merchant-live' }),
    }))
    expect(transaction.writes).toContainEqual(expect.objectContaining({
      table: stores,
      values: expect.objectContaining({ lakalaMerchantId: 'merchant-live' }),
    }))
  })

  it('人工确认时已属于其他市场的商户不能被改绑市场', async () => {
    ;(db.select as any).mockReturnValueOnce(scopedSelection([approvedApplication()]))
    const transaction = setupTransaction([
      [{ storeId: 'store-1', lakalaMerchantId: null, orgNodeId: 'store-node-1' }],
      [{ marketOrgNodeId: 'market-1' }],
      [{ id: 'merchant-other-market', marketOrgNodeId: 'market-2' }],
    ])

    const result = await confirmOnboardingExternalCertification('onb-cert')

    expect(result).toEqual({ success: false, message: '拉卡拉商户已属于其他市场，不能跨市场绑定' })
    expect(transaction.inserts).toHaveLength(0)
    expect(transaction.writes).not.toContainEqual(expect.objectContaining({
      table: lakalaMerchants,
      values: expect.objectContaining({ marketOrgNodeId: 'market-1' }),
    }))
    expect(logOperation).not.toHaveBeenCalled()
  })

  it('商户号持有者市场为 NULL（市场节点被删残留）时收编到门店市场', async () => {
    ;(db.select as any).mockReturnValueOnce(scopedSelection([approvedApplication()]))
    const transaction = setupTransaction([
      [{ storeId: 'store-1', lakalaMerchantId: null, orgNodeId: 'store-node-1' }],
      [{ marketOrgNodeId: 'market-1' }],
      [{ id: 'merchant-orphan', marketOrgNodeId: null }],
    ])

    const result = await confirmOnboardingExternalCertification('onb-cert')

    expect(result.success).toBe(true)
    expect(transaction.inserts).toHaveLength(0)
    expect(transaction.writes).toContainEqual(expect.objectContaining({
      table: lakalaMerchants,
      values: expect.objectContaining({ marketOrgNodeId: 'market-1', enabled: false }),
    }))
    expect(transaction.writes).toContainEqual(expect.objectContaining({
      table: stores,
      values: expect.objectContaining({ lakalaMerchantId: 'merchant-orphan' }),
    }))
  })

  it('门店未归属市场时不能把已归属市场的商户抹成无市场', async () => {
    ;(db.select as any).mockReturnValueOnce(scopedSelection([approvedApplication()]))
    const transaction = setupTransaction([
      [{ storeId: 'store-1', lakalaMerchantId: null, orgNodeId: 'store-node-1' }],
      [],
      [{ id: 'merchant-1', marketOrgNodeId: 'market-1' }],
    ])

    const result = await confirmOnboardingExternalCertification('onb-cert')

    expect(result).toEqual({ success: false, message: '门店未归属市场，无法变更已归属市场的收款商户' })
    expect(transaction.inserts).toHaveLength(0)
    expect(transaction.writes).not.toContainEqual(expect.objectContaining({
      table: lakalaMerchants,
      values: expect.objectContaining({ marketOrgNodeId: null }),
    }))
    expect(logOperation).not.toHaveBeenCalled()
  })

  it('商户号无持有者时复用申请单旧关联商户，须校验其市场归属', async () => {
    ;(db.select as any).mockReturnValueOnce(scopedSelection([
      approvedApplication({ lakalaMerchantId: 'merchant-stale' }),
    ]))
    const transaction = setupTransaction([
      [{ storeId: 'store-1', lakalaMerchantId: 'merchant-stale', orgNodeId: 'store-node-1' }],
      [{ marketOrgNodeId: 'market-1' }],
      [],
      [{ merchantNo: '821234567890', marketOrgNodeId: 'market-2' }],
    ])

    const result = await confirmOnboardingExternalCertification('onb-cert')

    expect(result).toEqual({ success: false, message: '拉卡拉商户已属于其他市场，不能跨市场绑定' })
    expect(transaction.inserts).toHaveLength(0)
    expect(transaction.writes).not.toContainEqual(expect.objectContaining({
      table: stores,
      values: expect.objectContaining({ lakalaMerchantId: 'merchant-stale' }),
    }))
    expect(logOperation).not.toHaveBeenCalled()
  })
})
