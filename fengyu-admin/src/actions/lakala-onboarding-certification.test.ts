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
  getOnboardingActivityId: vi.fn(),
  getOnboardingOrgCode: vi.fn(),
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
  refreshOnboardingCertificationStatus,
} from './lakala-onboarding'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'
import { lakalaQueryRegisterStatus } from '@/lib/lakala-onboarding'
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
})
