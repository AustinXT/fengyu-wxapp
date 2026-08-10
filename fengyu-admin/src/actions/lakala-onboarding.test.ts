import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('@db/lakala', () => ({
  lakalaMerchants: {
    id: 'lakala_merchant_id',
    merchantNo: 'merchant_no',
  },
}))

vi.mock('@db/lakala-onboarding', () => ({
  lakalaOnboardingApplications: {
    id: 'application_id',
    storeId: 'store_id',
    status: 'application_status',
    updatedAt: 'updated_at',
    lakalaMerchantId: 'lakala_merchant_id',
    eContractStatus: 'e_contract_status',
  },
  lakalaOnboardingAttachments: {
    id: 'attachment_id',
    applicationId: 'application_id',
    attachmentType: 'attachment_type',
    contentType: 'content_type',
    createdAt: 'created_at',
    originalFilename: 'original_filename',
    status: 'attachment_status',
    storageKey: 'storage_key',
  },
  lakalaOnboardingRequestLogs: {
    id: 'request_log_id',
    applicationId: 'application_id',
    apiName: 'api_name',
    errorMessage: 'error_message',
    startedAt: 'started_at',
    status: 'request_log_status',
  },
}))

vi.mock('@db/org', () => ({
  stores: {
    storeId: 'store_id',
    storeName: 'store_name',
    orgNodeId: 'org_node_id',
    lakalaMerchantId: 'lakala_merchant_id',
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
  scopeCondition: vi.fn(),
}))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn(), logTransition: vi.fn() }))
vi.mock('@/lib/pg-error', () => ({ pgErrorCode: vi.fn(() => null) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/upload-file', () => ({
  readPrivateOnboardingFile: vi.fn(),
  savePrivateOnboardingFile: vi.fn(),
}))
vi.mock('@/lib/lakala-onboarding-constants', () => ({
  ATTACHMENT_REQUIREMENTS: [
    { key: 'businessLicense', label: '营业执照', attachmentType: 'BUSINESS_LICENCE', displayName: '营业执照' },
    { key: 'legalIdFront', label: '法人身份证正面', attachmentType: 'ID_CARD_FRONT', displayName: '法人身份证正面' },
  ],
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
  lakalaQueryBanks: vi.fn(),
  lakalaQueryChannelSubMerchants: vi.fn(),
  lakalaQueryMerchantAuthState: vi.fn(),
  lakalaQueryRegisterStatus: vi.fn(),
  lakalaQuerySubMerchant: vi.fn(),
  lakalaUploadFile: vi.fn(),
  maskPayload: vi.fn((value: unknown) => value),
}))

import {
  getOnboardingApplication,
  getOnboardingAttachmentForDownload,
  cancelOnboardingApplication,
  queryOnboardingApplication,
  saveOnboardingApplication,
  uploadOnboardingAttachment,
} from './lakala-onboarding'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { scopeCondition } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'
import { savePrivateOnboardingFile } from '@/lib/upload-file'
import { lakalaQuerySubMerchant } from '@/lib/lakala-onboarding'
import { and } from 'drizzle-orm'

const outOfScopeSession = {
  employeeId: 'EMP-OUTSIDE',
  name: '范围外操作员',
  roles: [{ role: 'manager', scopeId: 'store-allowed', scopeType: '门店' }],
  permissions: {
    actions: ['merchant:update'],
    scopeStoreIds: ['store-allowed'],
  },
} as any

const outOfScopeCondition = { type: 'inArray', column: 'store_id', values: ['store-allowed'] }

const validApplicationInput = {
  merchantData: { merRegName: '凤御门店', merBlisName: '凤御门店' },
  legalPersonData: { larName: '张三' },
  contactData: { merContactName: '张三' },
  settlementData: { acctName: '凤御门店' },
  shopData: { shopName: '凤御门店' },
  terminalData: {},
}

function selectScopedApplication(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows)
  const where = vi.fn().mockReturnValue({ limit })
  const innerJoin = vi.fn().mockReturnValue({ where })
  const from = vi.fn().mockReturnValue({ innerJoin })
  return { from }
}

function selectRows(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows)
  const from = vi.fn().mockReturnValue({ where })
  return { from }
}

function selectLimitedRows(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows)
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  return { from }
}

function mockApplicationUpdate(affectedRows = 1) {
  const where = vi.fn().mockResolvedValue({ count: affectedRows })
  const set = vi.fn().mockReturnValue({ where })
  ;(db.update as any).mockReturnValue({ set })
  return { set, where }
}

function scopedEditableApplication(updatedAt: Date) {
  return {
    app: {
      id: 'onb_editable',
      applicationNo: 'ONB-20260810-TEST',
      status: 'DRAFT',
      updatedAt,
    },
    storeName: '测试门店',
    marketName: null,
    lakalaMerchantEnabled: null,
  }
}

function asArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

function mockOutOfScopeApplication() {
  ;(db.select as any).mockReturnValue(selectScopedApplication([]))
}

function expectNoWrite() {
  expect(db.insert).not.toHaveBeenCalled()
  expect(db.update).not.toHaveBeenCalled()
  expect(db.transaction).not.toHaveBeenCalled()
  expect(logOperation).not.toHaveBeenCalled()
  expect(savePrivateOnboardingFile).not.toHaveBeenCalled()
}

function expectScopedLookup() {
  expect(scopeCondition).toHaveBeenCalledWith(outOfScopeSession, 'store_id')
  expect(and).toHaveBeenCalledWith(
    { type: 'eq', left: 'application_id', right: 'onb_outside' },
    outOfScopeCondition,
  )
  expect(db.select).toHaveBeenCalledTimes(1)
}

describe('拉卡拉入网申请 - 门店 scope 隔离', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(outOfScopeSession)
    ;(scopeCondition as any).mockReturnValue(outOfScopeCondition)
  })

  it('范围外申请不能读取详情，且不会继续读取关联资料', async () => {
    mockOutOfScopeApplication()

    await expect(getOnboardingApplication('onb_outside')).resolves.toBeNull()

    expectScopedLookup()
    expectNoWrite()
  })

  it('范围外申请不能保存，且不会进入更新或审计写入', async () => {
    mockOutOfScopeApplication()

    const result = await saveOnboardingApplication('onb_outside', validApplicationInput)

    expect(result).toEqual({ success: false, message: '申请不存在或无权访问' })
    expectScopedLookup()
    expectNoWrite()
  })

  it('范围外申请不能取得私有附件下载元数据，且不会查询附件或触发写入', async () => {
    mockOutOfScopeApplication()

    await expect(getOnboardingAttachmentForDownload('onb_outside', 'att_outside')).resolves.toBeNull()

    expectScopedLookup()
    expectNoWrite()
  })
})

describe('拉卡拉入网申请 - 乐观锁与附件类型', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(outOfScopeSession)
    ;(scopeCondition as any).mockReturnValue(outOfScopeCondition)
  })

  it('保存草稿返回数据库写入使用的 updatedAt', async () => {
    const previousUpdatedAt = new Date('2026-08-10T00:00:00.000Z')
    ;(db.select as any).mockReturnValue(selectScopedApplication([scopedEditableApplication(previousUpdatedAt)]))
    const applicationUpdate = mockApplicationUpdate()

    const result = await saveOnboardingApplication(
      'onb_editable',
      validApplicationInput,
      previousUpdatedAt.toISOString(),
    )

    expect(result.success).toBe(true)
    const writeValues = applicationUpdate.set.mock.calls[0]?.[0] as { updatedAt?: Date }
    expect(writeValues.updatedAt).toBeInstanceOf(Date)
    expect(result.updatedAt).toBe(writeValues.updatedAt?.toISOString())
  })

  it('上传附件返回应用实际写入的 updatedAt', async () => {
    const previousUpdatedAt = new Date('2026-08-10T00:00:00.000Z')
    const firstSelect = selectScopedApplication([scopedEditableApplication(previousUpdatedAt)])
    const attachmentSelect = selectRows([])
    ;(db.select as any).mockImplementationOnce(() => firstSelect).mockImplementationOnce(() => attachmentSelect)
    const applicationUpdate = mockApplicationUpdate()
    const transactionUpdateWhere = vi.fn().mockResolvedValue({ count: 1 })
    const transactionUpdateSet = vi.fn().mockReturnValue({ where: transactionUpdateWhere })
    const transactionInsertValues = vi.fn().mockResolvedValue({ count: 1 })
    ;(db.transaction as any).mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      update: vi.fn().mockReturnValue({ set: transactionUpdateSet }),
      insert: vi.fn().mockReturnValue({ values: transactionInsertValues }),
    }))
    ;(savePrivateOnboardingFile as any).mockResolvedValue({
      storageKey: 'lakala-onboarding/onb_editable/0123456789abcdef0123456789abcdef.png',
      originalFilename: 'id-card.png',
      fileExt: 'png',
      fileSizeBytes: 8,
      contentType: 'image/png',
      contentSha256: 'a'.repeat(64),
    })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    const result = await uploadOnboardingAttachment(
      'onb_editable',
      {
        name: 'id-card.png',
        type: 'image/png',
        size: png.length,
        arrayBuffer: async () => asArrayBuffer(png),
      },
      'ID_CARD_FRONT',
      '法人身份证正面',
      previousUpdatedAt.toISOString(),
    )

    expect(result.success).toBe(true)
    const writeValues = applicationUpdate.set.mock.calls[0]?.[0] as { updatedAt?: Date }
    expect(writeValues.updatedAt).toBeInstanceOf(Date)
    expect(result.updatedAt).toBe(writeValues.updatedAt?.toISOString())
  })

  it('最后一份资料就绪时返回 FILES_READY 写入的 updatedAt', async () => {
    const previousUpdatedAt = new Date('2026-08-10T00:00:00.000Z')
    const applicationUpdate = mockApplicationUpdate()
    const firstSelect = selectScopedApplication([scopedEditableApplication(previousUpdatedAt)])
    const attachmentSelect = selectRows([
      { attachmentType: 'BUSINESS_LICENCE', status: 'LOCAL_SAVED' },
      { attachmentType: 'ID_CARD_FRONT', status: 'LOCAL_SAVED' },
    ])
    const currentSelect = selectLimitedRows([{
      get updatedAt() {
        return (applicationUpdate.set.mock.calls[0]?.[0] as { updatedAt: Date }).updatedAt
      },
    }])
    ;(db.select as any)
      .mockImplementationOnce(() => firstSelect)
      .mockImplementationOnce(() => attachmentSelect)
      .mockImplementationOnce(() => currentSelect)
    const transactionUpdateWhere = vi.fn().mockResolvedValue({ count: 1 })
    const transactionUpdateSet = vi.fn().mockReturnValue({ where: transactionUpdateWhere })
    const transactionInsertValues = vi.fn().mockResolvedValue({ count: 1 })
    ;(db.transaction as any).mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      update: vi.fn().mockReturnValue({ set: transactionUpdateSet }),
      insert: vi.fn().mockReturnValue({ values: transactionInsertValues }),
    }))
    ;(savePrivateOnboardingFile as any).mockResolvedValue({
      storageKey: 'lakala-onboarding/onb_editable/0123456789abcdef0123456789abcdef.png',
      originalFilename: 'id-card.png',
      fileExt: 'png',
      fileSizeBytes: 8,
      contentType: 'image/png',
      contentSha256: 'a'.repeat(64),
    })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    const result = await uploadOnboardingAttachment(
      'onb_editable',
      {
        name: 'id-card.png',
        type: 'image/png',
        size: png.length,
        arrayBuffer: async () => asArrayBuffer(png),
      },
      'ID_CARD_FRONT',
      '法人身份证正面',
      previousUpdatedAt.toISOString(),
    )

    expect(result.success).toBe(true)
    expect(applicationUpdate.set).toHaveBeenCalledTimes(2)
    const filesReadyWrite = applicationUpdate.set.mock.calls[1]?.[0] as { updatedAt?: Date; status?: string }
    expect(filesReadyWrite.status).toBe('FILES_READY')
    expect(result.updatedAt).toBe(filesReadyWrite.updatedAt?.toISOString())
  })

  it('审核查询失败写回的 updatedAt 严格大于已有锁令牌', async () => {
    const previousUpdatedAt = new Date('2099-08-10T00:00:00.000Z')
    const application = scopedEditableApplication(previousUpdatedAt)
    Object.assign(application.app, {
      status: 'REGISTERING',
      merInnerNo: 'inner_001',
      merCupNo: 'merchant_001',
    })
    ;(db.select as any).mockReturnValue(selectScopedApplication([application]))

    const requestLogWhere = vi.fn().mockResolvedValue({ count: 1 })
    const requestLogSet = vi.fn().mockReturnValue({ where: requestLogWhere })
    const applicationWhere = vi.fn().mockResolvedValue({ count: 1 })
    const applicationSet = vi.fn().mockReturnValue({ where: applicationWhere })
    ;(db.update as any)
      .mockReturnValueOnce({ set: requestLogSet })
      .mockReturnValueOnce({ set: applicationSet })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({ count: 1 }) })
    ;(lakalaQuerySubMerchant as any).mockResolvedValue({
      success: false,
      status: 'REGISTERING',
      errorCode: 'REMOTE_BUSY',
      raw: {},
    })

    const result = await queryOnboardingApplication('onb_editable')

    expect(result).toEqual({ success: false, message: '拉卡拉审核状态查询失败，请稍后重试' })
    const writeValues = applicationSet.mock.calls[0]?.[0] as { updatedAt?: Date }
    expect(writeValues.updatedAt).toEqual(new Date(previousUpdatedAt.getTime() + 1))
    expect(writeValues.updatedAt?.getTime()).toBeGreaterThan(previousUpdatedAt.getTime())
  })

  it('Action 层按附件类型拒绝伪装成图片的 PDF', async () => {
    const pdf = Buffer.from('%PDF-1.7\nprivate')

    const result = await uploadOnboardingAttachment(
      'onb_pdf_rejected',
      {
        name: 'id-card.png',
        type: 'image/png',
        size: pdf.length,
        arrayBuffer: async () => asArrayBuffer(pdf),
      },
      'ID_CARD_FRONT',
      '法人身份证正面',
    )

    expect(result).toEqual({ success: false, message: '法人身份证正面仅支持 JPG 或 PNG 图片' })
    expect(db.select).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
    expect(savePrivateOnboardingFile).not.toHaveBeenCalled()
  })

  it('电子合同已发起时不能通过 Action 取消申请', async () => {
    const previousUpdatedAt = new Date('2026-08-10T00:00:00.000Z')
    const application = scopedEditableApplication(previousUpdatedAt)
    ;(application.app as Record<string, unknown>).eContractOrderNo = 'ec-order-already-created'
    ;(db.select as any).mockReturnValue(selectScopedApplication([application]))

    const result = await cancelOnboardingApplication('onb_editable', previousUpdatedAt.toISOString())

    expect(result).toEqual({
      success: false,
      message: '电子合同已发起，不能取消，请先联系拉卡拉确认签约状态',
    })
    expect(db.update).not.toHaveBeenCalled()
    expect(logOperation).not.toHaveBeenCalled()
  })
})
