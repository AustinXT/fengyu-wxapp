'use server'

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { and, asc, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/db'
import { lakalaMerchants } from '@db/lakala'
import {
  lakalaOnboardingApplications,
  lakalaOnboardingAttachments,
  lakalaOnboardingRequestLogs,
  type LakalaOnboardingApplication,
  type LakalaOnboardingAttachment,
  type LakalaOnboardingStatus,
} from '@db/lakala-onboarding'
import { orgNodes, stores } from '@db/org'
import {
  getEContractOrgId,
  getEContractType,
  getEContractCallbackUrl,
  getOnboardingActivityId,
  getOnboardingOrgCode,
  getOnboardingUserNo,
  getServerOnboardingFeePolicy,
  lakalaAddMerchant,
  lakalaApplyElectronicContract,
  lakalaDownloadElectronicContract,
  lakalaQueryElectronicContract,
  lakalaQueryBanks,
  lakalaQueryChannelSubMerchants,
  lakalaQueryMerchantAuthState,
  lakalaQueryOcrResult,
  lakalaQueryRegisterStatus,
  lakalaQuerySubMerchant,
  lakalaUploadFile,
  maskPayload,
  type LakalaCertificationResult,
  type LakalaChannelSubMerchantResult,
} from '@/lib/lakala-onboarding'
import {
  findLocalLakalaBankAreaCodes,
  queryLocalLakalaBanks,
  queryLocalLakalaBanksByAreaKeywords,
} from '@/lib/lakala-bank-directory'
import {
  ATTACHMENT_REQUIREMENTS,
  ELECTRONIC_CONTRACT_PDF_ATTACHMENT,
  MAX_ONBOARDING_ATTACHMENT_BYTES,
  normalizeTkbsAttachmentType,
} from '@/lib/lakala-onboarding-constants'
import { getLakalaMerchantAreaPathByCode } from '@/lib/lakala-merchant-area'
import { normalizeLakalaDetailAddress } from '@/lib/lakala-onboarding-address'
import { logOperation, logTransition } from '@/lib/operation-log'
import { pgErrorCode } from '@/lib/pg-error'
import { scopeCondition } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { rowsAffected } from '@/lib/pg-rows'
import {
  bufferToUploadFileLike,
  readPrivateOnboardingFile,
  savePrivateOnboardingFile,
  getPrivateUploadRoot,
  type UploadFileLike,
} from '@/lib/upload-file'
import type { AuthSession } from '@/lib/types'

type AdminTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type JsonRecord = Record<string, string>

export type OnboardingStatus = LakalaOnboardingStatus

export interface OnboardingApplicationInput {
  merchantData: JsonRecord
  legalPersonData: JsonRecord
  contactData: JsonRecord
  settlementData: JsonRecord
  shopData: JsonRecord
  terminalData: JsonRecord
}

export interface OnboardingListItem {
  id: string
  applicationNo: string
  /** 兼容交接页面字段；值与 applicationNo 相同。 */
  orderNo: string
  storeId: string
  storeName: string
  marketName: string | null
  subjectName: string
  status: OnboardingStatus
  missing: string | null
  owner: string | null
  updatedAt: string
  merCupNo: string | null
  terminalNo: string | null
  lakalaMerchantId: string | null
  lakalaMerchantEnabled: boolean | null
  channelData: Record<string, unknown>
  subMerchantCheckedAt: string | null
}

export interface OnboardingStoreOption {
  storeId: string
  storeName: string
  marketName: string | null
  hasCollectionMerchant: boolean
  activeApplicationId: string | null
}

export interface OnboardingAttachment {
  id: string
  displayName: string
  attachmentType: string
  /** 兼容交接页面字段。 */
  attType: string
  fileName: string
  mimeType: string | null
  previewUrl: string | null
  status: string
  lakalaFileId: string | null
  /** 兼容交接页面字段。 */
  attFileId: string | null
  lakalaFileReference: string | null
  lakalaBatchNo: string | null
  lakalaOcrStatus: string | null
  expiresAt: string | null
  lastErrorMessage: string | null
}

export interface OnboardingDetail extends OnboardingListItem, OnboardingApplicationInput {
  eContractOrderNo: string | null
  eContractApplyId: string | null
  eContractNo: string | null
  eContractStatus: string | null
  eContractSignedAt: string | null
  contractId: string | null
  merInnerNo: string | null
  lastErrorMessage: string | null
  attachments: OnboardingAttachment[]
  requestLogs: Array<{
    id: string
    apiName: string
    status: string
    success: boolean
    errorMessage: string | null
    createdAt: string
  }>
}

export interface OnboardingBankOption {
  branchBankNo: string
  clearNo: string
  branchBankName: string
  areaCode: string
  bankNo?: string
}

const scalarSchema = z.union([
  z.string().max(2_000),
  z.number().finite(),
  z.boolean(),
]).transform((value) => String(value).trim())

const dataRecordSchema = z.record(z.string().min(1).max(80), scalarSchema)
  .refine((value) => Object.keys(value).length <= 100, '单个资料分组字段过多')
  // 费率只允许从服务端环境变量注入给拉卡拉，不能由浏览器写入申请资料。
  .refine((value) => Object.keys(value).every((key) => !/(?:fee|rate)/i.test(key)), '费率字段由服务器策略统一管理')
  .transform((value) => {
    const result: JsonRecord = {}
    for (const [key, fieldValue] of Object.entries(value)) {
      if (!['__proto__', 'constructor', 'prototype'].includes(key)) result[key] = fieldValue
    }
    return result
  })

const applicationInputSchema = z.object({
  merchantData: dataRecordSchema,
  legalPersonData: dataRecordSchema,
  contactData: dataRecordSchema,
  settlementData: dataRecordSchema,
  shopData: dataRecordSchema,
  terminalData: dataRecordSchema,
})

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, '编号格式不合法')
const expectedUpdatedAtSchema = z.string().datetime().optional()

const EDITABLE_STATUSES = new Set<OnboardingStatus>(['DRAFT', 'FILES_UPLOADING', 'FILES_READY', 'FAILED'])
const ACTIVE_STATUSES = new Set<OnboardingStatus>(['DRAFT', 'FILES_UPLOADING', 'FILES_READY', 'SUBMITTING', 'SUBMITTED', 'REGISTERING'])
const PDF_ATTACHMENT_TYPES = new Set(['BUSINESS_LICENCE', 'OPENING_PERMIT'])

function ksuid(prefix: string): string {
  const time = Math.floor(Date.now() / 1000).toString(36).padStart(8, '0')
  return `${prefix}${time}${randomBytes(6).toString('hex')}`
}

function applicationNo(): string {
  const now = new Date()
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  return `ONB-${ymd}-${randomBytes(4).toString('hex').toUpperCase()}`
}

function parseId(id: string): string | null {
  return idSchema.safeParse(id).success ? id : null
}

function parseExpectedUpdatedAt(value: string | undefined, fallback: Date): Date | null {
  if (value === undefined) return fallback
  const parsed = expectedUpdatedAtSchema.safeParse(value)
  if (!parsed.success) return null
  if (!parsed.data) return null
  const result = new Date(parsed.data)
  return Number.isNaN(result.getTime()) ? null : result
}

function nextUpdatedAt(previous?: Date): Date {
  const now = new Date()
  return previous && now.getTime() <= previous.getTime()
    ? new Date(previous.getTime() + 1)
    : now
}

function asStringRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: JsonRecord = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') result[key] = item
  }
  return result
}

/** 审核通过时固定子商户号轮询起点；兼容旧申请中不存在该 JSON 标记的情况。 */
function markSubMerchantPollingStartedAt(value: unknown, startedAt: Date): Record<string, unknown> {
  const channelData = value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
  const previous = channelData.subMerchantPolling && typeof channelData.subMerchantPolling === 'object' && !Array.isArray(channelData.subMerchantPolling)
    ? { ...(channelData.subMerchantPolling as Record<string, unknown>) }
    : {}
  const previousStartedAt = typeof previous.startedAt === 'string' && !Number.isNaN(new Date(previous.startedAt).getTime())
    ? previous.startedAt
    : startedAt.toISOString()
  return {
    ...channelData,
    subMerchantPolling: {
      ...previous,
      status: previous.status ?? 'WAITING',
      startedAt: previousStartedAt,
    },
  }
}

/** 电子合同轮询窗口从首次发起时开始，后续查询不能延长该窗口。 */
function markElectronicContractPollingStartedAt(value: unknown, startedAt: Date): Record<string, unknown> {
  const channelData = value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
  const previous = channelData.electronicContractPolling && typeof channelData.electronicContractPolling === 'object' && !Array.isArray(channelData.electronicContractPolling)
    ? { ...(channelData.electronicContractPolling as Record<string, unknown>) }
    : {}
  const previousStartedAt = typeof previous.startedAt === 'string' && !Number.isNaN(new Date(previous.startedAt).getTime())
    ? previous.startedAt
    : startedAt.toISOString()
  return {
    ...channelData,
    electronicContractPolling: {
      ...previous,
      status: previous.status === 'DONE' ? 'DONE' : 'WAITING',
      startedAt: previousStartedAt,
    },
  }
}

function emptyInput(): OnboardingApplicationInput {
  return {
    merchantData: {},
    legalPersonData: {},
    contactData: {},
    settlementData: {},
    shopData: {},
    terminalData: {},
  }
}

function normalizeInput(input: OnboardingApplicationInput): OnboardingApplicationInput {
  const subjectName = input.merchantData.subjectName || input.merchantData.merRegName || input.merchantData.merBlisName || ''
  const registeredRegion = getLakalaMerchantAreaPathByCode(input.merchantData.merRegDistCode)
  const settlementRegion = getLakalaMerchantAreaPathByCode(input.settlementData.bankDistCode)
  const registeredAddress = input.merchantData.merRegAddr
    ? normalizeLakalaDetailAddress(input.merchantData.merRegAddr, registeredRegion.label)
    : ''
  const merchantData: JsonRecord = {
    ...input.merchantData,
    ...(subjectName ? { subjectName, merRegName: subjectName, merBlisName: subjectName } : {}),
    ...(registeredAddress ? { merRegAddr: registeredAddress } : {}),
    ...(registeredRegion.provinceCode ? { merRegProvinceCode: registeredRegion.provinceCode } : {}),
    ...(registeredRegion.cityCode ? { merRegCityCode: registeredRegion.cityCode } : {}),
  }
  const businessName = merchantData.merBizName || input.shopData.shopName || subjectName
  return {
    merchantData: { ...merchantData, ...(businessName ? { merBizName: businessName } : {}) },
    legalPersonData: { ...input.legalPersonData },
    contactData: { ...input.contactData },
    settlementData: {
      ...input.settlementData,
      ...(input.settlementData.acctName || !subjectName ? {} : { acctName: subjectName }),
      ...(settlementRegion.provinceCode ? { settleProvinceCode: settlementRegion.provinceCode } : {}),
      ...(settlementRegion.cityCode ? { settleCityCode: settlementRegion.cityCode } : {}),
    },
    shopData: {
      ...input.shopData,
      ...(input.shopData.shopName || !businessName ? {} : { shopName: businessName }),
      ...(input.shopData.shopDistCode || !merchantData.merRegDistCode ? {} : { shopDistCode: merchantData.merRegDistCode }),
      ...(input.shopData.shopAddr || !registeredAddress ? {} : { shopAddr: registeredAddress }),
      ...(input.shopData.shopContactName || !input.contactData.merContactName ? {} : { shopContactName: input.contactData.merContactName }),
      ...(input.shopData.shopContactMobile || !input.contactData.merContactMobile ? {} : { shopContactMobile: input.contactData.merContactMobile }),
    },
    terminalData: { ...input.terminalData },
  }
}

function parseInput(input: unknown): OnboardingApplicationInput | null {
  const parsed = applicationInputSchema.safeParse(input)
  return parsed.success ? normalizeInput(parsed.data) : null
}

function licenseExpiry(data: JsonRecord): string {
  return data.merBlisLongTerm === 'true' ? '9999-12-31' : data.merBlisExpDt || ''
}

function idCardExpiry(data: JsonRecord): string {
  return data.larIdcardLongTerm === 'true' ? '9999-12-31' : data.larIdcardExpDt || ''
}

function missingFields(data: OnboardingApplicationInput): string[] {
  const missing: string[] = []
  const merchant = data.merchantData
  const legal = data.legalPersonData
  const contact = data.contactData
  const settlement = data.settlementData
  if (!merchant.merRegName || !merchant.merBlis || !merchant.merBlisStDt || !licenseExpiry(merchant)) missing.push('主体证照')
  if (!merchant.merRegDistCode || !merchant.merRegAddr) missing.push('注册地址')
  if (!legal.larName || !legal.larIdcard || !legal.larIdcardStDt || !idCardExpiry(legal)) missing.push('法人信息')
  if (!contact.merContactName || !contact.merContactMobile) missing.push('联系人')
  if (!settlement.acctName || !settlement.acctNo || !settlement.openningBankCode || !settlement.openningBankName || !settlement.clearingBankCode || !settlement.bankAreaCode) missing.push('结算账户')
  return missing
}

function dataFromApplication(app: LakalaOnboardingApplication): OnboardingApplicationInput {
  return normalizeInput({
    merchantData: asStringRecord(app.merchantData),
    legalPersonData: asStringRecord(app.legalPersonData),
    contactData: asStringRecord(app.contactData),
    settlementData: asStringRecord(app.settlementData),
    shopData: asStringRecord(app.shopData),
    terminalData: asStringRecord(app.terminalData),
  })
}

function statusLabel(status: OnboardingStatus): string {
  const labels: Record<OnboardingStatus, string> = {
    DRAFT: '草稿',
    FILES_UPLOADING: '资料上传中',
    FILES_READY: '资料已就绪',
    SUBMITTING: '提交中',
    SUBMITTED: '已提交',
    REGISTERING: '审核中',
    SUCCESS: '审核通过',
    FAILED: '审核失败',
    CANCELLED: '已取消',
  }
  return labels[status]
}

async function getScopedApplication(session: AuthSession, id: string): Promise<{
  app: LakalaOnboardingApplication
  storeName: string
  marketName: string | null
  lakalaMerchantEnabled: boolean | null
} | null> {
  const rows = await db.select({
    app: lakalaOnboardingApplications,
    storeName: stores.storeName,
    marketName: sql<string | null>`(
      SELECT market.name
      FROM org_nodes store_node
      LEFT JOIN org_nodes market ON market.id = store_node.parent_id
      WHERE store_node.id = ${stores.orgNodeId}
      LIMIT 1
    )`,
    lakalaMerchantEnabled: sql<boolean | null>`(
      SELECT enabled FROM lakala_merchants WHERE id = ${lakalaOnboardingApplications.lakalaMerchantId} LIMIT 1
    )`,
  })
    .from(lakalaOnboardingApplications)
    .innerJoin(stores, eq(stores.storeId, lakalaOnboardingApplications.storeId))
    .where(and(
      eq(lakalaOnboardingApplications.id, id),
      scopeCondition(session, stores.storeId),
    ))
    .limit(1)
  return rows[0] ?? null
}

function mapAttachment(row: LakalaOnboardingAttachment): OnboardingAttachment {
  const canPreview = Boolean(row.contentType?.startsWith('image/') || row.contentType === 'application/pdf')
  return {
    id: row.id,
    displayName: row.displayName,
    attachmentType: row.attachmentType,
    attType: row.attachmentType,
    fileName: row.originalFilename,
    mimeType: row.contentType ?? null,
    previewUrl: canPreview ? `/api/merchants/onboarding/${row.applicationId}/attachments/${row.id}` : null,
    status: row.status,
    lakalaFileId: row.lakalaFileId ?? null,
    attFileId: row.lakalaFileId ?? null,
    // 拉卡拉可能把临时文件 URL 放在此字段；不要返回给浏览器。
    lakalaFileReference: null,
    lakalaBatchNo: row.lakalaBatchNo ?? null,
    lakalaOcrStatus: row.lakalaOcrStatus ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastErrorMessage: row.lastErrorMessage ?? null,
  }
}

function terminalNo(terminalData: unknown): string | null {
  const data = asStringRecord(terminalData)
  return data.termNo || data.terminalNo || null
}

function serializeListItem(row: {
  app: LakalaOnboardingApplication
  storeName: string
  marketName: string | null
  lakalaMerchantEnabled: boolean | null
}): OnboardingListItem {
  const data = dataFromApplication(row.app)
  return {
    id: row.app.id,
    applicationNo: row.app.applicationNo,
    orderNo: row.app.applicationNo,
    storeId: row.app.storeId,
    storeName: row.storeName,
    marketName: row.marketName,
    subjectName: data.merchantData.subjectName || '未填写',
    status: row.app.status,
    missing: ['DRAFT', 'FILES_UPLOADING', 'FILES_READY', 'FAILED'].includes(row.app.status) ? missingFields(data).join('、') || null : null,
    owner: row.app.createdByName ?? null,
    updatedAt: row.app.updatedAt.toISOString(),
    merCupNo: row.app.merCupNo ?? null,
    terminalNo: terminalNo(row.app.terminalData),
    lakalaMerchantId: row.app.lakalaMerchantId ?? null,
    lakalaMerchantEnabled: row.lakalaMerchantEnabled,
    channelData: (row.app.channelData as Record<string, unknown>) ?? {},
    subMerchantCheckedAt: row.app.subMerchantCheckedAt?.toISOString() ?? null,
  }
}

function lockCondition(id: string, expectedUpdatedAt: Date) {
  return and(
    eq(lakalaOnboardingApplications.id, id),
    sql`date_trunc('milliseconds', ${lakalaOnboardingApplications.updatedAt}) = ${expectedUpdatedAt.toISOString()}`,
  )
}

/**
 * update/delete 不能只依赖前置 getScopedApplication() 的读取结果。权限范围可能在外部调用期间
 * 被收回，因此每次落库都把门店 scope 固化在 SQL WHERE 中。
 */
function applicationScopeCondition(session: AuthSession) {
  const scope = scopeCondition(session, stores.storeId)
  if (!scope) return undefined
  return sql`EXISTS (
    SELECT 1
    FROM ${stores}
    WHERE ${stores.storeId} = ${lakalaOnboardingApplications.storeId}
      AND ${scope}
  )`
}

function scopedApplicationCondition(session: AuthSession, applicationId: string, ...conditions: Array<SQL | undefined>) {
  return and(
    eq(lakalaOnboardingApplications.id, applicationId),
    applicationScopeCondition(session),
    ...conditions,
  )
}

function scopedAttachmentCondition(session: AuthSession, applicationId: string, attachmentId?: string) {
  const scope = scopeCondition(session, stores.storeId)
  return and(
    eq(lakalaOnboardingAttachments.applicationId, applicationId),
    attachmentId ? eq(lakalaOnboardingAttachments.id, attachmentId) : undefined,
    scope
      ? sql`EXISTS (
          SELECT 1
          FROM ${lakalaOnboardingApplications}
          INNER JOIN ${stores} ON ${stores.storeId} = ${lakalaOnboardingApplications.storeId}
          WHERE ${lakalaOnboardingApplications.id} = ${lakalaOnboardingAttachments.applicationId}
            AND ${scope}
        )`
      : undefined,
  )
}

function scopedRequestLogCondition(session: AuthSession, applicationId: string) {
  const scope = scopeCondition(session, stores.storeId)
  return and(
    eq(lakalaOnboardingRequestLogs.applicationId, applicationId),
    scope
      ? sql`EXISTS (
          SELECT 1
          FROM ${lakalaOnboardingApplications}
          INNER JOIN ${stores} ON ${stores.storeId} = ${lakalaOnboardingApplications.storeId}
          WHERE ${lakalaOnboardingApplications.id} = ${lakalaOnboardingRequestLogs.applicationId}
            AND ${scope}
        )`
      : undefined,
  )
}

async function updateWithOptimisticLock(
  session: AuthSession,
  id: string,
  expectedUpdatedAt: Date,
  values: Partial<typeof lakalaOnboardingApplications.$inferInsert>,
  updatedAt = nextUpdatedAt(expectedUpdatedAt),
): Promise<Date | null> {
  const writeUpdatedAt = updatedAt.getTime() > expectedUpdatedAt.getTime()
    ? updatedAt
    : nextUpdatedAt(expectedUpdatedAt)
  const result = await db.update(lakalaOnboardingApplications)
    .set({ ...values, updatedAt: writeUpdatedAt })
    .where(and(lockCondition(id, expectedUpdatedAt), applicationScopeCondition(session)))
  return rowsAffected(result) > 0 ? writeUpdatedAt : null
}

function revalidateOnboarding(applicationId?: string): void {
  revalidatePath('/merchants')
  revalidatePath('/merchants/onboarding')
  if (applicationId) revalidatePath(`/merchants/onboarding/${applicationId}`)
}

async function writeRequestLog<T extends { success: boolean; raw: Record<string, unknown>; errorCode?: string; errorMessage?: string }>(input: {
  applicationId: string
  apiName: string
  requestPayload: unknown
  invoke: () => Promise<T>
  idempotencyKey?: string
}): Promise<T> {
  const logId = ksuid('ol_')
  const requestId = randomUUID()
  const values = {
    id: logId,
    applicationId: input.applicationId,
    apiName: input.apiName,
    requestId,
    idempotencyKey: input.idempotencyKey ?? null,
    requestPayloadMasked: maskPayload(input.requestPayload),
    responsePayloadMasked: {},
    status: 'PENDING',
  } as const

  if (!input.idempotencyKey) {
    await db.insert(lakalaOnboardingRequestLogs).values({ ...values, attemptNo: 1 })
  } else {
    let inserted = false
    for (let retry = 0; retry < 3 && !inserted; retry += 1) {
      const [previous] = await db.select({ attemptNo: lakalaOnboardingRequestLogs.attemptNo })
        .from(lakalaOnboardingRequestLogs)
        .where(and(
          eq(lakalaOnboardingRequestLogs.applicationId, input.applicationId),
          eq(lakalaOnboardingRequestLogs.apiName, input.apiName),
          eq(lakalaOnboardingRequestLogs.idempotencyKey, input.idempotencyKey),
        ))
        .orderBy(desc(lakalaOnboardingRequestLogs.attemptNo))
        .limit(1)
      try {
        await db.insert(lakalaOnboardingRequestLogs).values({
          ...values,
          attemptNo: (previous?.attemptNo ?? 0) + 1,
        })
        inserted = true
      } catch (error) {
        if (pgErrorCode(error) !== '23505') throw error
      }
    }
    if (!inserted) throw new Error('CONFLICT: 外部请求日志并发创建，请重试')
  }
  let result: T
  try {
    result = await input.invoke()
  } catch (error) {
    await db.update(lakalaOnboardingRequestLogs).set({
      status: 'FAILED',
      errorCode: 'EXTERNAL_REQUEST_FAILED',
      errorMessage: '外部服务调用失败',
      completedAt: new Date(),
    }).where(eq(lakalaOnboardingRequestLogs.id, logId))
    throw error
  }
  // invoke 成功后日志更新失败不应导致调用方回滚——外部 API 调用已经完成。
  // 日志写入是审计辅助，不能因为审计失败而否认已发生的业务事实。
  try {
    await db.update(lakalaOnboardingRequestLogs).set({
      responsePayloadMasked: maskPayload(result.raw),
      status: result.success ? 'SUCCEEDED' : 'FAILED',
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
      completedAt: new Date(),
    }).where(eq(lakalaOnboardingRequestLogs.id, logId))
  } catch {
    // 外部调用已完成；避免把第三方原始错误对象输出到应用日志。
    console.error('writeRequestLog: 外部调用已完成但日志更新失败')
  }
  return result
}

async function getOnboardingStoreOptionsInternal(session: AuthSession): Promise<OnboardingStoreOption[]> {
  const [storeRows, activeRows] = await Promise.all([
    db.select({
      storeId: stores.storeId,
      storeName: stores.storeName,
      lakalaMerchantId: stores.lakalaMerchantId,
      marketName: sql<string | null>`(
        SELECT market.name FROM org_nodes store_node
        LEFT JOIN org_nodes market ON market.id = store_node.parent_id
        WHERE store_node.id = ${stores.orgNodeId} LIMIT 1
      )`,
    }).from(stores).where(scopeCondition(session, stores.storeId)).orderBy(asc(stores.storeName)),
    db.select({ id: lakalaOnboardingApplications.id, storeId: lakalaOnboardingApplications.storeId })
      .from(lakalaOnboardingApplications)
      .innerJoin(stores, eq(stores.storeId, lakalaOnboardingApplications.storeId))
      .where(and(
        scopeCondition(session, stores.storeId),
        sql`${lakalaOnboardingApplications.status} NOT IN ('SUCCESS', 'FAILED', 'CANCELLED')`,
      )),
  ])
  const activeByStore = new Map(activeRows.map((row) => [row.storeId, row.id]))
  return storeRows.map((row) => ({
    storeId: row.storeId,
    storeName: row.storeName,
    marketName: row.marketName,
    hasCollectionMerchant: Boolean(row.lakalaMerchantId),
    activeApplicationId: activeByStore.get(row.storeId) ?? null,
  }))
}

async function listOnboardingApplicationsInternal(session: AuthSession): Promise<OnboardingListItem[]> {
  const rows = await db.select({
    app: lakalaOnboardingApplications,
    storeName: stores.storeName,
    marketName: sql<string | null>`(
      SELECT market.name FROM org_nodes store_node
      LEFT JOIN org_nodes market ON market.id = store_node.parent_id
      WHERE store_node.id = ${stores.orgNodeId} LIMIT 1
    )`,
    lakalaMerchantEnabled: sql<boolean | null>`(
      SELECT enabled FROM lakala_merchants WHERE id = ${lakalaOnboardingApplications.lakalaMerchantId} LIMIT 1
    )`,
  })
    .from(lakalaOnboardingApplications)
    .innerJoin(stores, eq(stores.storeId, lakalaOnboardingApplications.storeId))
    .where(scopeCondition(session, stores.storeId))
    .orderBy(desc(lakalaOnboardingApplications.updatedAt))
  return rows.map(serializeListItem)
}

async function getOnboardingApplicationInternal(session: AuthSession, id: string): Promise<OnboardingDetail | null> {
  if (!parseId(id)) return null
  const row = await getScopedApplication(session, id)
  if (!row) return null
  const [attachments, logs] = await Promise.all([
    db.select().from(lakalaOnboardingAttachments)
      .where(and(scopedAttachmentCondition(session, id), sql`${lakalaOnboardingAttachments.status} <> 'DELETED'`))
      .orderBy(desc(lakalaOnboardingAttachments.createdAt)),
    db.select({
      id: lakalaOnboardingRequestLogs.id,
      apiName: lakalaOnboardingRequestLogs.apiName,
      status: lakalaOnboardingRequestLogs.status,
      errorMessage: lakalaOnboardingRequestLogs.errorMessage,
      createdAt: lakalaOnboardingRequestLogs.startedAt,
    }).from(lakalaOnboardingRequestLogs)
      .where(scopedRequestLogCondition(session, id))
      .orderBy(desc(lakalaOnboardingRequestLogs.startedAt))
      .limit(10),
  ])
  const base = serializeListItem(row)
  const data = dataFromApplication(row.app)
  return {
    ...base,
    ...data,
    eContractOrderNo: row.app.eContractOrderNo ?? null,
    eContractApplyId: row.app.eContractApplyId ?? null,
    eContractNo: row.app.eContractNo ?? null,
    eContractStatus: row.app.eContractStatus ?? null,
    eContractSignedAt: row.app.eContractSignedAt?.toISOString() ?? null,
    contractId: row.app.contractId ?? null,
    merInnerNo: row.app.merInnerNo ?? null,
    lastErrorMessage: row.app.lastErrorMessage ?? null,
    attachments: attachments.map(mapAttachment),
    requestLogs: logs.map((log) => ({
      id: log.id,
      apiName: log.apiName,
      status: log.status,
      success: log.status === 'SUCCEEDED',
      errorMessage: log.errorMessage ?? null,
      createdAt: log.createdAt.toISOString(),
    })),
  }
}

async function createOnboardingApplicationInternal(session: AuthSession, storeId: string): Promise<{ success: boolean; message: string; id?: string }> {
  if (!parseId(storeId)) return { success: false, message: '门店编号格式不合法' }
  const [store] = await db.select({
    storeId: stores.storeId,
    storeName: stores.storeName,
    lakalaMerchantId: stores.lakalaMerchantId,
  }).from(stores).where(and(eq(stores.storeId, storeId), scopeCondition(session, stores.storeId))).limit(1)
  if (!store) return { success: false, message: '门店不存在或无权访问' }
  if (store.lakalaMerchantId) return { success: false, message: '该门店已绑定收款商户，不能重复发起入网' }

  const id = ksuid('onb_')
  const input = normalizeInput({ ...emptyInput(), shopData: { shopName: store.storeName } })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await db.insert(lakalaOnboardingApplications).values({
        id,
        applicationNo: applicationNo(),
        storeId,
        status: 'DRAFT',
        merchantData: input.merchantData,
        legalPersonData: input.legalPersonData,
        contactData: input.contactData,
        settlementData: input.settlementData,
        shopData: input.shopData,
        terminalData: input.terminalData,
        createdByEmployeeId: session.employeeId,
        createdByName: session.name,
      })
      await logOperation(session, 'merchant.onboarding.create', 'lakala_onboarding_application', id, { storeId })
      revalidateOnboarding(id)
      return { success: true, message: '入网申请已创建', id }
    } catch (error) {
      if (pgErrorCode(error) !== '23505') throw error
      const [active] = await db.select({ id: lakalaOnboardingApplications.id })
        .from(lakalaOnboardingApplications)
        .innerJoin(stores, eq(stores.storeId, lakalaOnboardingApplications.storeId))
        .where(and(
          eq(lakalaOnboardingApplications.storeId, storeId),
          scopeCondition(session, stores.storeId),
          sql`${lakalaOnboardingApplications.status} NOT IN ('SUCCESS', 'FAILED', 'CANCELLED')`,
        ))
        .limit(1)
      if (active) return { success: false, message: '该门店已有进行中的入网申请', id: active.id }
    }
  }
  return { success: false, message: '申请编号生成冲突，请重试' }
}

async function saveOnboardingApplicationInternal(
  session: AuthSession,
  id: string,
  input: unknown,
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string; updatedAt?: string }> {
  if (!parseId(id)) return { success: false, message: '申请不存在' }
  const data = parseInput(input)
  if (!data) return { success: false, message: '资料格式不合法，请检查输入内容' }
  const row = await getScopedApplication(session, id)
  if (!row) return { success: false, message: '申请不存在或无权访问' }
  if (!EDITABLE_STATUSES.has(row.app.status)) {
    return { success: false, message: `当前状态“${statusLabel(row.app.status)}”不允许修改资料` }
  }
  const lockAt = parseExpectedUpdatedAt(expectedUpdatedAt, row.app.updatedAt)
  if (!lockAt || lockAt.getTime() !== row.app.updatedAt.getTime()) {
    return { success: false, message: '数据已被其他人修改，请刷新后重试' }
  }
  const updatedAt = await updateWithOptimisticLock(session, id, lockAt, {
    merchantData: data.merchantData,
    legalPersonData: data.legalPersonData,
    contactData: data.contactData,
    settlementData: data.settlementData,
    shopData: data.shopData,
    terminalData: data.terminalData,
    ...(row.app.status === 'FAILED' ? {} : { lastErrorCode: null, lastErrorMessage: null }),
  })
  if (!updatedAt) return { success: false, message: '数据已被其他人修改，请刷新后重试' }
  await logOperation(session, 'merchant.onboarding.save', 'lakala_onboarding_application', id, { applicationNo: row.app.applicationNo })
  revalidateOnboarding(id)
  return { success: true, message: '草稿已保存', updatedAt: updatedAt.toISOString() }
}

function attachmentRequirement(attachmentType: string, displayName: string) {
  return ATTACHMENT_REQUIREMENTS.find((item) => (
    item.attachmentType === attachmentType && item.displayName === displayName
  )) ?? null
}

function attachmentAllowsPdf(attachmentType: string): boolean {
  return PDF_ATTACHMENT_TYPES.has(attachmentType)
}

function attachmentFileTypeMessage(requirement: NonNullable<ReturnType<typeof attachmentRequirement>>): string {
  return attachmentAllowsPdf(requirement.attachmentType)
    ? `${requirement.displayName}仅支持 JPG、PNG 图片或 PDF`
    : `${requirement.displayName}仅支持 JPG 或 PNG 图片`
}

async function uploadHasPdfSignature(file: UploadFileLike): Promise<boolean> {
  const bytes = Buffer.from(await file.arrayBuffer())
  return bytes.subarray(0, 5).toString('ascii') === '%PDF-'
}

async function markFilesReady(session: AuthSession, applicationId: string): Promise<Date | null> {
  const attachments = await db.select({
    attachmentType: lakalaOnboardingAttachments.attachmentType,
    status: lakalaOnboardingAttachments.status,
  }).from(lakalaOnboardingAttachments).where(scopedAttachmentCondition(session, applicationId))
  const readyTypes = new Set(
    attachments
      .filter((attachment) => ['LOCAL_SAVED', 'UPLOADING', 'UPLOADED'].includes(attachment.status))
      .map((attachment) => attachment.attachmentType),
  )
  const allReady = ATTACHMENT_REQUIREMENTS.every((item) => readyTypes.has(item.attachmentType))
  if (!allReady) return null
  const [current] = await db.select({ updatedAt: lakalaOnboardingApplications.updatedAt })
    .from(lakalaOnboardingApplications)
    .where(scopedApplicationCondition(session, applicationId))
    .limit(1)
  if (!current) return null
  const updatedAt = nextUpdatedAt(current.updatedAt)
  const updated = await db.update(lakalaOnboardingApplications).set({ status: 'FILES_READY', updatedAt })
    .where(and(
      scopedApplicationCondition(session, applicationId),
      eq(lakalaOnboardingApplications.updatedAt, current.updatedAt),
      sql`${lakalaOnboardingApplications.status} IN ('DRAFT', 'FILES_UPLOADING', 'FILES_READY', 'FAILED')`,
    ))
  return rowsAffected(updated) > 0 ? updatedAt : null
}

async function uploadOnboardingAttachmentInternal(
  session: AuthSession,
  applicationId: string,
  file: UploadFileLike,
  attachmentType: string,
  displayName: string,
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string; attachmentId?: string; updatedAt?: string }> {
  if (!parseId(applicationId)) return { success: false, message: '申请不存在' }
  const requirement = attachmentRequirement(attachmentType, displayName)
  if (!requirement) return { success: false, message: '不支持的入网附件类型' }
  if (!file || typeof file.size !== 'number' || typeof file.arrayBuffer !== 'function' || file.size <= 0 || file.size > MAX_ONBOARDING_ATTACHMENT_BYTES) {
    return { success: false, message: '上传文件不能超过 5MB' }
  }
  try {
    if (await uploadHasPdfSignature(file) && !attachmentAllowsPdf(requirement.attachmentType)) {
      return { success: false, message: attachmentFileTypeMessage(requirement) }
    }
  } catch {
    return { success: false, message: '上传文件读取失败，请重试' }
  }
  const row = await getScopedApplication(session, applicationId)
  if (!row) return { success: false, message: '申请不存在或无权访问' }
  if (!EDITABLE_STATUSES.has(row.app.status)) {
    return { success: false, message: `当前状态“${statusLabel(row.app.status)}”不允许上传资料` }
  }
  const lockAt = parseExpectedUpdatedAt(expectedUpdatedAt, row.app.updatedAt)
  if (!lockAt || lockAt.getTime() !== row.app.updatedAt.getTime()) {
    return { success: false, message: '数据已被其他人修改，请刷新后重试' }
  }

  const markedUploadingAt = await updateWithOptimisticLock(session, applicationId, lockAt, {
    status: 'FILES_UPLOADING',
    lastErrorCode: null,
    lastErrorMessage: null,
  })
  if (!markedUploadingAt) return { success: false, message: '数据已被其他人修改，请刷新后重试' }

  let saved: Awaited<ReturnType<typeof savePrivateOnboardingFile>>
  try {
    saved = await savePrivateOnboardingFile(applicationId, file)
  } catch (error) {
    const restoredAt = await updateWithOptimisticLock(session, applicationId, markedUploadingAt, {
      status: row.app.status === 'FAILED' ? 'FAILED' : 'DRAFT',
      lastErrorCode: 'ATTACHMENT_SAVE_FAILED',
      lastErrorMessage: '附件保存失败，请检查文件格式后重试',
    })
    return {
      success: false,
      message: error instanceof Error && error.message.startsWith('INVALID_PARAMS:') ? error.message.slice('INVALID_PARAMS: '.length) : '附件保存失败',
      ...(restoredAt ? { updatedAt: restoredAt.toISOString() } : {}),
    }
  }

  const attachmentId = ksuid('oa_')
  try {
    await db.transaction(async (tx) => {
      // 留存旧资料审计痕迹，不自动删除或复用其物理文件。
      await tx.update(lakalaOnboardingAttachments).set({ status: 'DELETED', updatedAt: new Date() })
        .where(and(
          scopedAttachmentCondition(session, applicationId),
          eq(lakalaOnboardingAttachments.attachmentType, requirement.attachmentType),
          sql`${lakalaOnboardingAttachments.status} <> 'DELETED'`,
        ))
      await tx.insert(lakalaOnboardingAttachments).values({
        id: attachmentId,
        applicationId,
        attachmentType: requirement.attachmentType,
        displayName: requirement.displayName,
        storageKey: saved.storageKey,
        originalFilename: saved.originalFilename,
        fileExt: saved.fileExt,
        fileSizeBytes: saved.fileSizeBytes,
        contentType: saved.contentType,
        contentSha256: saved.contentSha256,
        status: 'LOCAL_SAVED',
      })
    })
  } catch (txError) {
    // 文件已落盘但 DB 事务失败 → 清理孤儿文件，避免 PRIVATE_UPLOAD_DIR 积累无主文件。
    try {
      const orphanPath = path.join(getPrivateUploadRoot(), saved.storageKey)
      await unlink(orphanPath)
    } catch {
      console.error('清理孤儿入网附件文件失败')
    }
    const restoredAt = await updateWithOptimisticLock(session, applicationId, markedUploadingAt, {
      status: row.app.status === 'FAILED' ? 'FAILED' : 'DRAFT',
      lastErrorCode: 'ATTACHMENT_DB_FAILED',
      lastErrorMessage: '附件记录写入失败，请重试',
    })
    return {
      success: false,
      message: '附件记录写入失败，请重试',
      ...(restoredAt ? { updatedAt: restoredAt.toISOString() } : {}),
    }
  }
  const filesReadyAt = await markFilesReady(session, applicationId)
  await logOperation(session, 'merchant.onboarding.attachment.upload', 'lakala_onboarding_attachment', attachmentId, {
    applicationId,
    attachmentType: requirement.attachmentType,
    sizeBytes: saved.fileSizeBytes,
  })
  revalidateOnboarding(applicationId)
  return {
    success: true,
    message: `${requirement.displayName} 已安全保存`,
    attachmentId,
    updatedAt: (filesReadyAt ?? markedUploadingAt).toISOString(),
  }
}

/**
 * Route Handler 专用的附件查询入口。它先执行 merchant:list + 门店 scope，返回的 opaque
 * storageKey 只能用于同一服务端进程调用 readPrivateOnboardingFile，不能拼成公开 URL。
 */
async function getOnboardingAttachmentForDownloadInternal(
  session: AuthSession,
  applicationId: string,
  attachmentId: string,
): Promise<{ storageKey: string; contentType: string; originalFilename: string } | null> {
  if (!parseId(applicationId) || !parseId(attachmentId)) return null
  const application = await getScopedApplication(session, applicationId)
  if (!application) return null
  const [attachment] = await db.select({
    storageKey: lakalaOnboardingAttachments.storageKey,
    contentType: lakalaOnboardingAttachments.contentType,
    originalFilename: lakalaOnboardingAttachments.originalFilename,
  }).from(lakalaOnboardingAttachments).where(and(
    scopedAttachmentCondition(session, applicationId, attachmentId),
    sql`${lakalaOnboardingAttachments.status} <> 'DELETED'`,
  )).limit(1)
  if (!attachment) return null
  return {
    storageKey: attachment.storageKey,
    contentType: attachment.contentType ?? 'application/octet-stream',
    originalFilename: attachment.originalFilename,
  }
}

async function requiredAttachments(session: AuthSession, applicationId: string): Promise<LakalaOnboardingAttachment[]> {
  const rows = await db.select().from(lakalaOnboardingAttachments)
    .where(and(
      scopedAttachmentCondition(session, applicationId),
      sql`${lakalaOnboardingAttachments.status} <> 'DELETED'`,
    ))
    .orderBy(desc(lakalaOnboardingAttachments.createdAt))
  const byType = new Map<string, LakalaOnboardingAttachment>()
  for (const row of rows) {
    if (!byType.has(row.attachmentType)) byType.set(row.attachmentType, row)
  }
  const missing = ATTACHMENT_REQUIREMENTS.filter((item) => !byType.has(item.attachmentType))
  if (missing.length > 0) {
    throw new Error(`INVALID_STATE: 缺少必传附件：${missing.map((item) => item.label).join('、')}`)
  }
  return ATTACHMENT_REQUIREMENTS.map((item) => byType.get(item.attachmentType)!)
}

async function uploadAttachmentToLakala(
  session: AuthSession,
  application: LakalaOnboardingApplication,
  attachment: LakalaOnboardingAttachment,
): Promise<{ type: string; id: string }> {
  if (
    attachment.status === 'UPLOADED' &&
    attachment.lakalaFileId &&
    attachment.expiresAt &&
    attachment.expiresAt.getTime() > Date.now()
  ) {
    return { type: normalizeTkbsAttachmentType(attachment.attachmentType, attachment.displayName), id: attachment.lakalaFileId }
  }
  const buffer = await readPrivateOnboardingFile(attachment.storageKey)
  const digest = createHash('sha256').update(buffer).digest('hex')
  if (digest !== attachment.contentSha256) {
    await db.update(lakalaOnboardingAttachments).set({
      status: 'FAILED',
      lastErrorCode: 'ATTACHMENT_HASH_MISMATCH',
      lastErrorMessage: '附件完整性校验失败，请重新上传',
      updatedAt: new Date(),
    }).where(scopedAttachmentCondition(session, application.id, attachment.id))
    throw new Error(`INVALID_STATE: ${attachment.displayName} 完整性校验失败，请重新上传`)
  }
  await db.update(lakalaOnboardingAttachments).set({
    status: 'UPLOADING',
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: new Date(),
  }).where(scopedAttachmentCondition(session, application.id, attachment.id))

  try {
    const result = await writeRequestLog({
      applicationId: application.id,
      apiName: 'tkbs.customer.file.upload',
      requestPayload: {
        attachmentType: attachment.attachmentType,
        contentType: attachment.contentType,
        contentSha256: attachment.contentSha256,
        contentBase64: '[omitted]',
      },
      invoke: () => lakalaUploadFile({
        attachmentType: attachment.attachmentType,
        contentType: attachment.contentType ?? 'application/octet-stream',
        contentBase64: buffer.toString('base64'),
      }),
    })
    if (!result.success || !result.fileId) {
      throw new Error('INVALID_STATE: 拉卡拉未返回有效附件标识')
    }
    let lakalaOcrStatus = result.ocrStatus ?? null
    let ocrErrorMessage: string | null = null
    if (result.batchNo) {
      try {
        const ocrResult = await writeRequestLog({
          applicationId: application.id,
          apiName: 'tkbs.ocr_result',
          requestPayload: {
            imgType: normalizeTkbsAttachmentType(attachment.attachmentType, attachment.displayName),
            batchNo: result.batchNo,
          },
          invoke: () => lakalaQueryOcrResult({
            imgType: normalizeTkbsAttachmentType(attachment.attachmentType, attachment.displayName),
            batchNo: result.batchNo!,
          }),
        })
        lakalaOcrStatus = ocrResult.ocrStatus ?? lakalaOcrStatus
        ocrErrorMessage = ocrResult.success ? null : ocrResult.errorMessage ?? '拉卡拉附件 OCR 结果查询失败'
      } catch {
        // 文件上传已成功，OCR 结果查询失败不回滚文件，只记录状态供后续排查。
        ocrErrorMessage = '拉卡拉附件 OCR 结果查询失败'
      }
    }
    await db.update(lakalaOnboardingAttachments).set({
      status: 'UPLOADED',
      lakalaFileId: result.fileId,
      lakalaFileReference: result.fileReference ?? null,
      lakalaBatchNo: result.batchNo ?? null,
      lakalaOcrStatus,
      uploadedToLakalaAt: new Date(),
      expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
      lastErrorCode: null,
      lastErrorMessage: ocrErrorMessage,
      updatedAt: new Date(),
    }).where(scopedAttachmentCondition(session, application.id, attachment.id))
    return { type: normalizeTkbsAttachmentType(attachment.attachmentType, attachment.displayName), id: result.fileId }
  } catch (error) {
    await db.update(lakalaOnboardingAttachments).set({
      status: 'FAILED',
      lastErrorCode: 'LAKALA_ATTACHMENT_UPLOAD_FAILED',
      lastErrorMessage: '附件上传拉卡拉失败，请稍后重试',
      updatedAt: new Date(),
    }).where(scopedAttachmentCondition(session, application.id, attachment.id))
    throw error
  }
}

async function uploadRequiredAttachments(session: AuthSession, application: LakalaOnboardingApplication): Promise<Array<{ type: string; id: string }>> {
  const attachments = await requiredAttachments(session, application.id)
  return Promise.all(attachments.map((attachment) => uploadAttachmentToLakala(session, application, attachment)))
}

function safeExternalMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  for (const prefix of ['INVALID_STATE: ', 'CONFLICT: ', 'NOT_FOUND: ']) {
    if (error.message.startsWith(prefix)) return error.message.slice(prefix.length)
  }
  return fallback
}

function normalizeDate(value: string | undefined): string {
  return (value ?? '').replace(/\//g, '-')
}

function requiredConfigValue(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`INVALID_STATE: 缺少${label}配置`)
  return value.trim()
}

function buildRegion(data: OnboardingApplicationInput): { provinceCode: string; cityCode: string; countyCode: string } {
  const merchant = data.merchantData
  const provinceCode = merchant.merRegProvinceCode || merchant.provinceCode || ''
  const cityCode = merchant.merRegCityCode || merchant.cityCode || ''
  const countyCode = merchant.merRegDistCode || merchant.countyCode || ''
  if (!provinceCode || !cityCode || !countyCode) {
    throw new Error('INVALID_STATE: 请完整选择拉卡拉省、市、区县编码后再提交')
  }
  return { provinceCode, cityCode, countyCode }
}

function stripAreaSuffix(value: string): string {
  return value.replace(/(特别行政区|自治州|自治县|自治区|新区|地区|盟|省|市|区|县)$/g, '')
}

function bankAreaKeywords(areaLabel: string): string[] {
  const withoutProvince = areaLabel.replace(/^.+?(?:省|自治区|特别行政区)/, '')
  const cityName = withoutProvince.match(/^(.+?(?:市|自治州|地区|盟))/)?.[1] ?? ''
  const countyName = withoutProvince.replace(cityName, '')
  return [...new Set([countyName, stripAreaSuffix(countyName), cityName, stripAreaSuffix(cityName)].filter(Boolean))]
}

function buildElectronicContractRequest(application: LakalaOnboardingApplication, data: OnboardingApplicationInput): Record<string, unknown> {
  const merchant = data.merchantData
  const legal = data.legalPersonData
  const contact = data.contactData
  const settlement = data.settlementData
  const orderNo = electronicContractOrderNo(application)
  const subjectName = requiredConfigValue(merchant.merRegName, '营业执照主体')
  const callbackUrl = requiredConfigValue(getEContractCallbackUrl(), '电子合同回调地址')
  const businessName = merchant.merBizName || subjectName
  const businessAddress = data.shopData.shopAddr || merchant.merRegAddr
  const statementEmail = process.env.LAKALA_ECONTRACT_STATEMENT_EMAIL?.trim() || contact.email || process.env.LAKALA_ONBOARDING_EMAIL?.trim() || ''
  const businessContent = process.env.LAKALA_ONBOARDING_MER_BUSI_CONTENT?.trim()
    || process.env.LAKALA_ONBOARDING_BUSINESS_CONTENT?.trim()
    || '美容美发服务'
  const now = new Date()
  const fee = '0.38%'
  const unused = '/'
  const ecContent = {
    A1: subjectName,
    A34: fee,
    A35: fee,
    A36: unused,
    A37: unused,
    A38: unused,
    A63: '是',
    A64: fee,
    A65: '是',
    A66: fee,
    A109: unused,
    A110: unused,
    A111: unused,
    A112: unused,
    A113: unused,
    A114: unused,
    A115: unused,
    A116: '自动结算',
    A117: '是',
    A118: unused,
    A119: unused,
    A120: '是',
    A121: merchant.merRegDistCode,
    A122: subjectName,
    A123: process.env.LAKALA_ECONTRACT_PLATFORM_NAME?.trim() || '凤御美业',
    A124: now.getFullYear(),
    A125: now.getMonth() + 1,
    A126: now.getDate(),
    B1: now.getFullYear(),
    B2: now.getMonth() + 1,
    B3: '是',
    B8: subjectName,
    B9: businessContent,
    B10: businessName,
    B13: businessAddress,
    B14: merchant.merBlis,
    B16: settlement.acctName === subjectName ? '是' : unused,
    B17: settlement.acctName === subjectName ? unused : '是',
    B18: settlement.acctName === subjectName ? unused : settlement.acctName,
    B19: settlement.openningBankName,
    B20: settlement.acctNo,
    B21: statementEmail,
    B24: legal.larName,
    B25: `身份证${legal.larIdcard}`,
    B26: contact.merContactMobile,
    B27: contact.merContactName,
    B28: statementEmail,
    B29: `身份证${legal.larIdcard}`,
    B30: contact.merContactMobile,
    B31: businessName,
    B32: contact.merContactName,
    B33: businessAddress,
    B34: contact.merContactMobile,
    B35: businessName,
    B36: '1',
    B43: '是',
    B46: '是',
    B50: '是',
    B56: subjectName,
    D1: settlement.openningBankName,
    D6: subjectName,
    D7: contact.merContactMobile,
  }
  return {
    order_no: orderNo,
    org_id: Number(getEContractOrgId()) || getEContractOrgId(),
    ec_type_code: getEContractType(),
    cert_type: 'RESIDENT_ID',
    cert_name: requiredConfigValue(legal.larName, '法人姓名'),
    cert_no: requiredConfigValue(legal.larIdcard, '法人证件号'),
    mobile: requiredConfigValue(contact.merContactMobile, '联系人手机号'),
    business_license_no: requiredConfigValue(merchant.merBlis, '营业执照号'),
    business_license_name: subjectName,
    openning_bank_code: requiredConfigValue(settlement.openningBankCode, '开户行'),
    openning_bank_name: requiredConfigValue(settlement.openningBankName, '开户行名称'),
    acct_type_code: '57',
    acct_no: requiredConfigValue(settlement.acctNo, '结算账号'),
    acct_name: requiredConfigValue(settlement.acctName, '结算账户名称'),
    ec_content_parameters: JSON.stringify(ecContent),
    agent_tag: 0,
    remark: `门店入网申请 ${application.applicationNo}`,
    ret_url: callbackUrl,
  }
}

function electronicContractOrderNo(application: LakalaOnboardingApplication): string {
  return application.eContractOrderNo || `EC${Date.now()}${application.id.slice(-8)}`.slice(0, 32)
}

function buildMerchantRequest(
  application: LakalaOnboardingApplication,
  data: OnboardingApplicationInput,
  attachments: Array<{ type: string; id: string }>,
): { request: Record<string, unknown>; feePolicyVersion: string } {
  const fees = getServerOnboardingFeePolicy()
  const merchant = data.merchantData
  const legal = data.legalPersonData
  const contact = data.contactData
  const settlement = data.settlementData
  const shop = data.shopData
  const region = buildRegion(data)
  const area = getLakalaMerchantAreaPathByCode(merchant.merRegDistCode)
  const bankArea = getLakalaMerchantAreaPathByCode(settlement.bankDistCode || merchant.merRegDistCode)
  const merchantAddress = normalizeLakalaDetailAddress(merchant.merRegAddr || shop.shopAddr || '', area.label)
  if (!merchantAddress) throw new Error('INVALID_STATE: 请填写详细地址（不含省市区）')
  if (merchantAddress.length > 29) {
    throw new Error(`INVALID_STATE: 商户详细地址需控制在 29 字以内，请去掉省市区并缩短门牌描述；当前 ${merchantAddress.length} 字`)
  }
  const accountIdCard = settlement.accountIdCard || legal.larIdcard
  const accountIdStart = settlement.accountIdDtStart || legal.larIdcardStDt
  const accountIdEnd = settlement.accountIdDtEnd || idCardExpiry(legal)
  const request = {
    org_code: getOnboardingOrgCode(),
    user_no: getOnboardingUserNo(),
    email: contact.email || process.env.LAKALA_ONBOARDING_EMAIL?.trim() || 'lakala-onboarding@fengyu.local',
    busi_code: process.env.LAKALA_ONBOARDING_BUSI_CODE?.trim() || 'WECHAT_PAY',
    mer_reg_name: requiredConfigValue(merchant.merRegName, '营业执照主体'),
    mer_type: process.env.LAKALA_ONBOARDING_MER_TYPE?.trim() || 'TP_MERCHANT',
    mer_name: merchant.merBizName || merchant.merRegName,
    mer_addr: merchantAddress,
    province_code: region.provinceCode,
    city_code: region.cityCode,
    county_code: region.countyCode,
    license_name: merchant.merBlisName || merchant.merRegName,
    license_no: requiredConfigValue(merchant.merBlis, '营业执照号'),
    license_dt_start: normalizeDate(merchant.merBlisStDt),
    license_dt_end: normalizeDate(licenseExpiry(merchant)),
    latitude: process.env.LAKALA_ONBOARDING_DEFAULT_LATITUDE?.trim() || process.env.LAKALA_ONBOARDING_LATITUDE?.trim() || '28.682892',
    longtude: process.env.LAKALA_ONBOARDING_DEFAULT_LONGTUDE?.trim()
      || process.env.LAKALA_ONBOARDING_DEFAULT_LONGITUDE?.trim()
      || process.env.LAKALA_ONBOARDING_LONGITUDE?.trim()
      || '115.858197',
    source: process.env.LAKALA_ONBOARDING_SOURCE?.trim() || 'H5',
    business_content: process.env.LAKALA_ONBOARDING_MER_BUSI_CONTENT?.trim()
      || process.env.LAKALA_ONBOARDING_BUSINESS_CONTENT?.trim()
      || '美容美发服务',
    lar_name: requiredConfigValue(legal.larName, '法人姓名'),
    lar_id_type: '01',
    lar_id_card: requiredConfigValue(legal.larIdcard, '法人证件号'),
    lar_id_card_start: normalizeDate(legal.larIdcardStDt),
    lar_id_card_end: normalizeDate(idCardExpiry(legal)),
    contact_mobile: requiredConfigValue(contact.merContactMobile, '联系人手机号'),
    contact_name: requiredConfigValue(contact.merContactName, '联系人姓名'),
    openning_bank_code: requiredConfigValue(settlement.openningBankCode, '开户行'),
    openning_bank_name: requiredConfigValue(settlement.openningBankName, '开户行名称'),
    clearing_bank_code: requiredConfigValue(settlement.clearingBankCode, '清算行号'),
    settle_province_code: process.env.LAKALA_ONBOARDING_SETTLE_PROVINCE_CODE?.trim()
      || settlement.settleProvinceCode
      || (bankArea.label.includes('江西省') ? '36' : region.provinceCode),
    settle_province_name: process.env.LAKALA_ONBOARDING_SETTLE_PROVINCE_NAME?.trim()
      || settlement.settleProvinceName
      || bankArea.label.match(/^(.+?(?:省|自治区|市|特别行政区))/)?.[1]
      || '',
    settle_city_code: process.env.LAKALA_ONBOARDING_SETTLE_CITY_CODE?.trim()
      || settlement.bankAreaCode
      || settlement.settleCityCode
      || region.cityCode,
    settle_city_name: process.env.LAKALA_ONBOARDING_SETTLE_CITY_NAME?.trim()
      || settlement.settleCityName
      || bankArea.label.replace(/^.+?(?:省|自治区|特别行政区)/, '').match(/^(.+?(?:市|自治州|地区|盟))/)?.[1]
      || '',
    account_no: requiredConfigValue(settlement.acctNo, '结算账号'),
    account_name: requiredConfigValue(settlement.acctName, '结算账户名称'),
    account_type: process.env.LAKALA_ONBOARDING_ACCOUNT_TYPE?.trim() || '57',
    account_id_type: '01',
    account_id_card: requiredConfigValue(accountIdCard, '结算人证件号'),
    account_id_dt_start: normalizeDate(accountIdStart),
    account_id_dt_end: normalizeDate(accountIdEnd),
    external_no: application.applicationNo,
    contract_no: requiredConfigValue(application.eContractNo ?? undefined, '已签约电子合同'),
    biz_content: {
      term_num: process.env.LAKALA_ONBOARDING_TERM_NUM?.trim() || '1',
      fees: fees.feeData,
      mcc: process.env.LAKALA_ONBOARDING_MCC?.trim() || '13002',
      activity_id: getOnboardingActivityId(),
    },
    attchments: attachments,
    settle_type: process.env.LAKALA_ONBOARDING_SETTLE_TYPE?.trim() || 'D1',
    settlement_type: process.env.LAKALA_ONBOARDING_SETTLEMENT_TYPE?.trim() || 'AUTOMATIC',
  }
  return { request, feePolicyVersion: fees.version }
}

async function initiateElectronicContractInternal(
  session: AuthSession,
  applicationId: string,
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string; resultUrl?: string }> {
  if (!parseId(applicationId)) return { success: false, message: '申请不存在' }
  const row = await getScopedApplication(session, applicationId)
  if (!row) return { success: false, message: '申请不存在或无权访问' }
  if (row.app.eContractStatus === 'COMPLETED' && row.app.eContractNo) {
    return { success: true, message: '电子合同已签约完成' }
  }
  if (!EDITABLE_STATUSES.has(row.app.status)) {
    return { success: false, message: `当前状态“${statusLabel(row.app.status)}”不允许发起电子合同` }
  }
  const lockAt = parseExpectedUpdatedAt(expectedUpdatedAt, row.app.updatedAt)
  if (!lockAt || lockAt.getTime() !== row.app.updatedAt.getTime()) {
    return { success: false, message: '数据已被其他人修改，请刷新后重试' }
  }
  const data = dataFromApplication(row.app)
  const missing = missingFields(data)
  if (missing.length) return { success: false, message: `提交前请先补齐：${missing.join('、')}` }

  // 先持久化供应商幂等订单号。即使进程在拉卡拉受理后崩溃，重试仍沿用同一订单而不会重复建合同。
  const orderNo = electronicContractOrderNo(row.app)
  const requestedAt = nextUpdatedAt(lockAt)
  const requesting = await db.update(lakalaOnboardingApplications).set({
    eContractOrderNo: orderNo,
    eContractStatus: 'REQUESTING',
    channelData: markElectronicContractPollingStartedAt(row.app.channelData, requestedAt),
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: requestedAt,
  }).where(and(lockCondition(applicationId, lockAt), applicationScopeCondition(session)))
  if (rowsAffected(requesting) === 0) return { success: false, message: '数据已被其他人修改，请刷新后重试' }

  try {
    const request = buildElectronicContractRequest({ ...row.app, eContractOrderNo: orderNo }, data)
    const result = await writeRequestLog({
      applicationId,
      apiName: 'mms.ec.apply',
      requestPayload: request,
      idempotencyKey: `econtract:${applicationId}:${String(request.order_no)}`,
      invoke: () => lakalaApplyElectronicContract(request),
    })
    if (!result.success || !result.resultUrl) {
      throw new Error('INVALID_STATE: 拉卡拉电子合同未返回签约链接')
    }
    const pendingAt = nextUpdatedAt(requestedAt)
    await db.update(lakalaOnboardingApplications).set({
      eContractOrderNo: result.orderNo ?? String(request.order_no),
      eContractApplyId: result.applyId ?? null,
      eContractStatus: 'PENDING',
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: pendingAt,
    }).where(and(
      scopedApplicationCondition(session, applicationId),
      lockCondition(applicationId, requestedAt),
      eq(lakalaOnboardingApplications.eContractStatus, 'REQUESTING'),
    ))
    await logOperation(session, 'merchant.onboarding.econtract.apply', 'lakala_onboarding_application', applicationId, {
      applicationNo: row.app.applicationNo,
    })
    revalidateOnboarding(applicationId)
    return { success: true, message: '电子合同已发起，请由法人完成签约', resultUrl: result.resultUrl }
  } catch (error) {
    const failedAt = nextUpdatedAt(requestedAt)
    await db.update(lakalaOnboardingApplications).set({
      eContractStatus: 'FAILED',
      lastErrorCode: 'ECONTRACT_APPLY_FAILED',
      lastErrorMessage: '电子合同发起失败，请检查开发环境入网配置后重试',
      updatedAt: failedAt,
    }).where(and(
      scopedApplicationCondition(session, applicationId),
      lockCondition(applicationId, requestedAt),
      eq(lakalaOnboardingApplications.eContractStatus, 'REQUESTING'),
    ))
    return { success: false, message: safeExternalMessage(error, '电子合同发起失败') }
  }
}

function electronicContractCompleted(status: string | undefined): boolean {
  return ['COMPLETED', 'SUCCESS', 'SIGNED', 'FINISHED'].includes((status ?? '').toUpperCase())
}

function electronicContractFailed(status: string | undefined): boolean {
  return ['FAILED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes((status ?? '').toUpperCase())
}

async function cleanupOrphanPrivateFile(storageKey: string): Promise<void> {
  try {
    await unlink(path.join(getPrivateUploadRoot(), storageKey))
  } catch {
    // 清理失败不暴露路径或存储键到日志；后续运维可按私有目录留存策略处理。
    console.error('清理孤儿入网私有附件失败')
  }
}

/**
 * 主动查询电子合同状态，作为供应商回调之外的兜底。合同完成后立刻下载
 * URL-safe Base64 PDF 并写入私有存储，不把签约 URL、PDF 或原始响应放入日志。
 */
async function refreshElectronicContractStatusInternal(
  session: AuthSession,
  applicationId: string,
): Promise<{ success: boolean; message: string; status?: string }> {
  if (!parseId(applicationId)) return { success: false, message: '申请不存在' }
  const row = await getScopedApplication(session, applicationId)
  if (!row) return { success: false, message: '申请不存在或无权访问' }
  if (!row.app.eContractOrderNo) return { success: false, message: '请先发起电子合同' }
  if (row.app.eContractStatus === 'REQUESTING' || row.app.eContractStatus === 'QUERYING') {
    return { success: false, message: '电子合同正在处理中，请稍后重试' }
  }

  const claimedAt = nextUpdatedAt(row.app.updatedAt)
  const claimed = await db.update(lakalaOnboardingApplications).set({
    eContractStatus: 'QUERYING',
    updatedAt: claimedAt,
  }).where(and(
    lockCondition(applicationId, row.app.updatedAt),
    applicationScopeCondition(session),
  ))
  if (rowsAffected(claimed) === 0) return { success: false, message: '数据已被其他人修改，请刷新后重试' }

  try {
    const statusResult = await writeRequestLog({
      applicationId,
      apiName: 'mms.ec.q_status',
      requestPayload: { orderNo: row.app.eContractOrderNo, applyId: row.app.eContractApplyId },
      idempotencyKey: `econtract-status:${applicationId}:${row.app.eContractOrderNo}:${Math.floor(Date.now() / 3_600_000)}`,
      invoke: () => lakalaQueryElectronicContract({
        orderNo: row.app.eContractOrderNo!,
        applyId: row.app.eContractApplyId,
      }),
    })
    if (!statusResult.success) {
      const pendingAt = nextUpdatedAt(claimedAt)
      await db.update(lakalaOnboardingApplications).set({
        eContractStatus: 'PENDING',
        lastErrorCode: statusResult.errorCode ?? 'ECONTRACT_STATUS_QUERY_FAILED',
        lastErrorMessage: '电子合同状态查询失败，请稍后重试',
        updatedAt: pendingAt,
      }).where(and(
        lockCondition(applicationId, claimedAt),
        applicationScopeCondition(session),
        eq(lakalaOnboardingApplications.eContractStatus, 'QUERYING'),
      ))
      return { success: false, message: '电子合同状态查询失败，请稍后重试' }
    }

    const status = statusResult.status?.toUpperCase() || 'PENDING'
    if (!electronicContractCompleted(status)) {
      const nextStatus = electronicContractFailed(status) ? 'FAILED' : status
      const statusUpdatedAt = nextUpdatedAt(claimedAt)
      await db.update(lakalaOnboardingApplications).set({
        eContractStatus: nextStatus,
        ...(electronicContractFailed(status)
          ? { lastErrorCode: 'ECONTRACT_NOT_COMPLETED', lastErrorMessage: '电子合同未完成，请核对拉卡拉签约状态' }
          : { lastErrorCode: null, lastErrorMessage: null }),
        updatedAt: statusUpdatedAt,
      }).where(and(
        lockCondition(applicationId, claimedAt),
        applicationScopeCondition(session),
        eq(lakalaOnboardingApplications.eContractStatus, 'QUERYING'),
      ))
      revalidateOnboarding(applicationId)
      return { success: true, message: electronicContractFailed(status) ? '电子合同未完成，请核对签约状态' : '电子合同尚未完成签约', status }
    }

    const contractNo = statusResult.contractNo ?? row.app.eContractNo
    if (!contractNo) {
      throw new Error('INVALID_STATE: 拉卡拉电子合同已完成但未返回合同号')
    }
    const downloadResult = await writeRequestLog({
      applicationId,
      apiName: 'mms.ec.download',
      requestPayload: { orderNo: row.app.eContractOrderNo, contractNo },
      idempotencyKey: `econtract-download:${applicationId}:${row.app.eContractOrderNo}:${contractNo}`,
      invoke: () => lakalaDownloadElectronicContract({ orderNo: row.app.eContractOrderNo!, contractNo }),
    })
    if (!downloadResult.success || !downloadResult.pdfBytes) {
      throw new Error('INVALID_STATE: 拉卡拉电子合同下载失败')
    }
    const saved = await savePrivateOnboardingFile(
      applicationId,
      bufferToUploadFileLike(downloadResult.pdfBytes, ELECTRONIC_CONTRACT_PDF_ATTACHMENT.displayName, 'application/pdf'),
    )
    const attachmentId = ksuid('oa_')
    try {
      await db.transaction(async (tx) => {
        const completedAt = nextUpdatedAt(claimedAt)
        const applicationUpdate = await tx.update(lakalaOnboardingApplications).set({
          eContractStatus: 'COMPLETED',
          eContractNo: contractNo,
          eContractSignedAt: completedAt,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: completedAt,
        }).where(and(
          lockCondition(applicationId, claimedAt),
          applicationScopeCondition(session),
          eq(lakalaOnboardingApplications.eContractStatus, 'QUERYING'),
        ))
        if (rowsAffected(applicationUpdate) === 0) {
          throw new Error('CONFLICT: 申请已被其他操作修改，请刷新后重试')
        }
        await tx.update(lakalaOnboardingAttachments).set({ status: 'DELETED', updatedAt: new Date() })
          .where(and(
            scopedAttachmentCondition(session, applicationId),
            eq(lakalaOnboardingAttachments.attachmentType, ELECTRONIC_CONTRACT_PDF_ATTACHMENT.attachmentType),
            sql`${lakalaOnboardingAttachments.status} <> 'DELETED'`,
          ))
        await tx.insert(lakalaOnboardingAttachments).values({
          id: attachmentId,
          applicationId,
          attachmentType: ELECTRONIC_CONTRACT_PDF_ATTACHMENT.attachmentType,
          displayName: ELECTRONIC_CONTRACT_PDF_ATTACHMENT.label,
          storageKey: saved.storageKey,
          originalFilename: saved.originalFilename,
          fileExt: saved.fileExt,
          fileSizeBytes: saved.fileSizeBytes,
          contentType: saved.contentType,
          contentSha256: saved.contentSha256,
          status: 'LOCAL_SAVED',
        })
      })
    } catch (error) {
      await cleanupOrphanPrivateFile(saved.storageKey)
      throw error
    }
    await logOperation(session, 'merchant.onboarding.econtract.complete', 'lakala_onboarding_application', applicationId, {
      applicationNo: row.app.applicationNo,
      contractPdfStored: true,
    })
    revalidateOnboarding(applicationId)
    return { success: true, message: '电子合同已完成签约并安全归档', status: 'COMPLETED' }
  } catch (error) {
    const failedAt = nextUpdatedAt(claimedAt)
    await db.update(lakalaOnboardingApplications).set({
      eContractStatus: 'PENDING',
      lastErrorCode: 'ECONTRACT_REFRESH_FAILED',
      lastErrorMessage: '电子合同状态或文件同步失败，请稍后重试',
      updatedAt: failedAt,
    }).where(and(
      lockCondition(applicationId, claimedAt),
      applicationScopeCondition(session),
      eq(lakalaOnboardingApplications.eContractStatus, 'QUERYING'),
    ))
    return { success: false, message: safeExternalMessage(error, '电子合同状态或文件同步失败') }
  }
}

/**
 * 审核通过后的收款商户落库步骤必须与申请状态更新使用同一个事务。
 * 调用方负责先锁定并校验申请行，避免外部审核查询返回后被并发编辑覆盖。
 */
async function bindApprovedMerchantInTransaction(
  tx: AdminTx,
  session: AuthSession,
  application: LakalaOnboardingApplication,
  merchantNo: string,
  terminalNumber: string | undefined,
  enabled: boolean,
): Promise<string> {
  const merchantName = dataFromApplication(application).merchantData.merRegName || application.applicationNo
  const [store] = await tx.select({
    storeId: stores.storeId,
    lakalaMerchantId: stores.lakalaMerchantId,
    orgNodeId: stores.orgNodeId,
  }).from(stores).where(and(
    eq(stores.storeId, application.storeId),
    scopeCondition(session, stores.storeId),
  )).limit(1)
  if (!store) throw new Error('NOT_FOUND: 门店不存在或无权访问')
  const [market] = store.orgNodeId
    ? await tx.select({ marketOrgNodeId: orgNodes.parentId }).from(orgNodes)
      .where(eq(orgNodes.id, store.orgNodeId)).limit(1)
    : []
  let [existing] = await tx.select().from(lakalaMerchants)
    .where(eq(lakalaMerchants.merchantNo, merchantNo)).limit(1)
  if (application.lakalaMerchantId && existing && existing.id !== application.lakalaMerchantId) {
    throw new Error('CONFLICT: 申请已关联的收款商户与拉卡拉商户号不一致')
  }
  if (!existing && application.lakalaMerchantId) {
    ;[existing] = await tx.select().from(lakalaMerchants)
      .where(eq(lakalaMerchants.id, application.lakalaMerchantId)).limit(1)
    if (existing?.merchantNo && existing.merchantNo !== merchantNo) {
      throw new Error('CONFLICT: 申请已关联的收款商户号与审核结果不一致')
    }
  }
  if (store.lakalaMerchantId && store.lakalaMerchantId !== existing?.id) {
    throw new Error('CONFLICT: 门店已绑定其他收款商户，请先核对配置')
  }
  let merchantId: string
  if (existing) {
    if (existing.marketOrgNodeId && market?.marketOrgNodeId && existing.marketOrgNodeId !== market.marketOrgNodeId) {
      throw new Error('CONFLICT: 拉卡拉商户已属于其他市场，不能跨市场绑定')
    }
    merchantId = existing.id
    if (existing.merchantName !== merchantName
      || existing.merchantNo !== merchantNo
      || (terminalNumber && existing.termNo !== terminalNumber)
      || existing.enabled !== enabled
      || (!existing.marketOrgNodeId && market?.marketOrgNodeId)) {
      await tx.update(lakalaMerchants).set({
        ...(existing.merchantName !== merchantName ? { merchantName } : {}),
        ...(existing.merchantNo !== merchantNo ? { merchantNo } : {}),
        ...(terminalNumber && existing.termNo !== terminalNumber ? { termNo: terminalNumber } : {}),
        ...(!existing.marketOrgNodeId && market?.marketOrgNodeId ? { marketOrgNodeId: market.marketOrgNodeId } : {}),
        enabled,
        updatedAt: new Date(),
      }).where(eq(lakalaMerchants.id, existing.id))
    }
  } else {
    merchantId = ksuid('lm_')
    await tx.insert(lakalaMerchants).values({
      id: merchantId,
      merchantName,
      merchantNo,
      termNo: terminalNumber ?? null,
      enabled,
      marketOrgNodeId: market?.marketOrgNodeId ?? null,
    })
  }
  const boundStores = await tx.update(stores).set({ lakalaMerchantId: merchantId, updatedAt: new Date() })
    .where(and(
      eq(stores.storeId, application.storeId),
      scopeCondition(session, stores.storeId),
      or(isNull(stores.lakalaMerchantId), eq(stores.lakalaMerchantId, merchantId)),
    ))
    .returning({ storeId: stores.storeId })
  if (!boundStores.length) {
    throw new Error('CONFLICT: 门店已被并发绑定其他收款商户，请先核对配置')
  }
  return merchantId
}

async function revokeApprovedMerchantInTransaction(
  tx: AdminTx,
  session: AuthSession,
  application: LakalaOnboardingApplication,
): Promise<void> {
  if (!application.lakalaMerchantId) return
  await tx.update(lakalaMerchants).set({
    enabled: false,
    updatedAt: new Date(),
  }).where(eq(lakalaMerchants.id, application.lakalaMerchantId))
  await tx.update(stores).set({
    lakalaMerchantId: null,
    updatedAt: new Date(),
  }).where(and(
    eq(stores.storeId, application.storeId),
    eq(stores.lakalaMerchantId, application.lakalaMerchantId),
    scopeCondition(session, stores.storeId),
  ))
}

async function submitApplicationWithSession(
  session: AuthSession,
  applicationId: string,
  allowFailed: boolean,
): Promise<{ success: boolean; message: string }> {
  const row = await getScopedApplication(session, applicationId)
  if (!row) return { success: false, message: '申请不存在或无权访问' }
  if (row.app.lakalaMerchantId) return { success: true, message: '该申请已绑定收款商户，无需重复提交' }
  if (!allowFailed && row.app.status === 'FAILED') return { success: false, message: '审核已拒绝，请先修正资料后重新提交' }
  if (row.app.status !== 'FILES_READY' && !(allowFailed && row.app.status === 'FAILED')) {
    if (['SUBMITTING', 'SUBMITTED', 'REGISTERING'].includes(row.app.status)) return { success: true, message: '该申请已提交拉卡拉，请查询审核状态' }
    return { success: false, message: `当前状态“${statusLabel(row.app.status)}”不允许提交` }
  }
  if (row.app.eContractStatus !== 'COMPLETED' || !row.app.eContractNo) {
    return { success: false, message: '请先完成拉卡拉电子合同签约' }
  }
  const started = await updateWithOptimisticLock(session, applicationId, row.app.updatedAt, {
    status: 'SUBMITTING',
    lastErrorCode: null,
    lastErrorMessage: null,
  })
  if (!started) return { success: false, message: '数据已被其他人修改，请刷新后重试' }

  try {
    const data = dataFromApplication(row.app)
    const attachmentData = await uploadRequiredAttachments(session, row.app)
    const built = buildMerchantRequest(row.app, data, attachmentData)
    const result = await writeRequestLog({
      applicationId,
      apiName: 'tkbs.merchant_encry',
      requestPayload: built.request,
      idempotencyKey: `merchant:${applicationId}:${row.app.applicationNo}`,
      invoke: () => lakalaAddMerchant(built.request),
    })
    if (!result.success || (!result.merInnerNo && !result.merCupNo)) {
      throw new Error('INVALID_STATE: 拉卡拉进件未返回商户标识')
    }
    const [latest] = await db.select().from(lakalaOnboardingApplications)
      .where(and(scopedApplicationCondition(session, applicationId), eq(lakalaOnboardingApplications.status, 'SUBMITTING')))
      .limit(1)
    if (!latest) return { success: false, message: '申请状态已被其他操作修改，请刷新后重试' }
    const finalizedAt = nextUpdatedAt(latest.updatedAt)
    const finalized = await db.update(lakalaOnboardingApplications).set({
      status: 'REGISTERING',
      feePolicyVersion: built.feePolicyVersion,
      eContractOrderNo: latest.eContractOrderNo,
      contractId: result.contractId ?? null,
      merInnerNo: result.merInnerNo ?? null,
      merCupNo: result.merCupNo ?? null,
      submittedAt: finalizedAt,
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: finalizedAt,
    }).where(and(
      scopedApplicationCondition(session, applicationId),
      lockCondition(applicationId, latest.updatedAt),
      eq(lakalaOnboardingApplications.status, 'SUBMITTING'),
    ))
    if (rowsAffected(finalized) === 0) {
      return { success: false, message: '申请状态已被其他操作修改，请刷新后重试' }
    }
    await logOperation(session, allowFailed ? 'merchant.onboarding.resubmit' : 'merchant.onboarding.submit', 'lakala_onboarding_application', applicationId, {
      applicationNo: row.app.applicationNo,
      status: 'REGISTERING',
    })
    revalidateOnboarding(applicationId)
    return { success: true, message: '已提交拉卡拉，等待审核；审核通过后请继续完成渠道认证' }
  } catch (error) {
    const failedAt = nextUpdatedAt(started)
    await db.update(lakalaOnboardingApplications).set({
      status: 'FILES_READY',
      lastErrorCode: 'LAKALA_SUBMIT_FAILED',
      lastErrorMessage: '拉卡拉进件失败，请检查资料和开发环境配置后重试',
      updatedAt: failedAt,
    }).where(and(
      scopedApplicationCondition(session, applicationId),
      lockCondition(applicationId, started),
      eq(lakalaOnboardingApplications.status, 'SUBMITTING'),
    ))
    return { success: false, message: safeExternalMessage(error, '拉卡拉进件失败') }
  }
}

async function submitOnboardingApplicationInternal(session: AuthSession, applicationId: string): Promise<{ success: boolean; message: string }> {
  if (!parseId(applicationId)) return { success: false, message: '申请不存在' }
  return submitApplicationWithSession(session, applicationId, false)
}

async function reconsiderOnboardingApplicationInternal(session: AuthSession, applicationId: string): Promise<{ success: boolean; message: string }> {
  if (!parseId(applicationId)) return { success: false, message: '申请不存在' }
  const row = await getScopedApplication(session, applicationId)
  if (!row) return { success: false, message: '申请不存在或无权访问' }
  if (row.app.status !== 'FAILED') return { success: false, message: '仅审核拒绝的申请可以重新提交' }
  return submitApplicationWithSession(session, applicationId, true)
}

function serializeChannelResult(result: LakalaCertificationResult): Record<string, unknown> {
  return {
    success: result.success,
    registerType: result.registerType,
    subMchId: result.subMchId,
    merchantNo: result.merchantNo,
    registerState: result.registerState,
    authorizeState: result.authorizeState,
    applymentState: result.applymentState,
    registerCode: result.registerCode,
    registerMsg: result.registerMsg,
    rejectReason: result.rejectReason,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    checkedAt: new Date().toISOString(),
  }
}

async function refreshSubMerchantsInternal(session: AuthSession, applicationId: string): Promise<{
  success: boolean
  wechat: LakalaChannelSubMerchantResult['wechat']
  alipay: LakalaChannelSubMerchantResult['alipay']
  message: string
}> {
  const [application] = await db.select().from(lakalaOnboardingApplications)
    .where(scopedApplicationCondition(session, applicationId)).limit(1)
  if (!application) return { success: false, wechat: [], alipay: [], message: '申请不存在' }
  if (application.status !== 'SUCCESS' || !application.merCupNo) {
    return { success: false, wechat: [], alipay: [], message: '仅审核通过且有银联商户号的申请可查询子商户号' }
  }
  const result = await writeRequestLog({
    applicationId,
    apiName: 'tkbs.open_merchant_submer',
    requestPayload: { merchantNo: application.merCupNo },
    invoke: () => lakalaQueryChannelSubMerchants({ merchantNo: application.merCupNo! }),
  })
  const channelData = (application.channelData as Record<string, unknown>) ?? {}
  const refreshedAt = nextUpdatedAt(application.updatedAt)
  const nextChannelData = {
    ...channelData,
    wechat: result.wechat,
    alipay: result.alipay,
    subMerchantCheckedAt: refreshedAt.toISOString(),
  }
  const updated = await db.update(lakalaOnboardingApplications).set({
    channelData: nextChannelData,
    subMerchantCheckedAt: refreshedAt,
    lastErrorCode: result.success ? null : result.errorCode ?? 'CHANNEL_QUERY_FAILED',
    lastErrorMessage: result.success ? null : '微信/支付宝子商户号查询失败',
    updatedAt: refreshedAt,
  }).where(and(
    scopedApplicationCondition(session, applicationId),
    lockCondition(applicationId, application.updatedAt),
  ))
  if (rowsAffected(updated) === 0) {
    return {
      success: false,
      wechat: [],
      alipay: [],
      message: '数据已被其他人修改，请刷新后重试',
    }
  }
  return {
    success: result.success,
    wechat: result.wechat,
    alipay: result.alipay,
    message: result.success
      ? (result.wechat.length && result.alipay.length ? '微信、支付宝子商户号已更新' : '子商户号尚未全部返回，将继续轮询')
      : '子商户号查询失败，请稍后重试',
  }
}

async function refreshOnboardingSubMerchantsInternalAction(session: AuthSession, applicationId: string): Promise<{ success: boolean; message: string }> {
  if (!parseId(applicationId)) return { success: false, message: '申请不存在' }
  const row = await getScopedApplication(session, applicationId)
  if (!row) return { success: false, message: '申请不存在或无权访问' }
  const result = await refreshSubMerchantsInternal(session, applicationId)
  revalidateOnboarding(applicationId)
  return { success: result.success, message: result.message }
}

async function queryOnboardingApplicationInternal(session: AuthSession, applicationId: string): Promise<{ success: boolean; message: string }> {
  if (!parseId(applicationId)) return { success: false, message: '申请不存在' }
  const row = await getScopedApplication(session, applicationId)
  if (!row) return { success: false, message: '申请不存在或无权访问' }
  if (!['SUBMITTED', 'REGISTERING', 'SUCCESS', 'FAILED'].includes(row.app.status)) {
    return { success: false, message: `当前状态“${statusLabel(row.app.status)}”无需查询审核结果` }
  }
  if (!row.app.merInnerNo && !row.app.merCupNo) {
    return { success: false, message: '申请缺少拉卡拉商户标识，无法查询审核结果' }
  }
  try {
    const result = await writeRequestLog({
      applicationId,
      apiName: 'tkbs.open_merchant_info',
      requestPayload: { merInnerNo: row.app.merInnerNo, merCupNo: row.app.merCupNo },
      invoke: () => lakalaQuerySubMerchant({
        contractId: row.app.contractId,
        merInnerNo: row.app.merInnerNo,
        merCupNo: row.app.merCupNo,
      }),
    })
    const nextTerminalData = result.terminalNo
      ? { ...asStringRecord(row.app.terminalData), termNo: result.terminalNo }
      : row.app.terminalData
    const nextMerchantNo = result.merchantNo ?? row.app.merCupNo
    if (!result.success && result.status === 'REGISTERING') {
      const failedAt = nextUpdatedAt(row.app.updatedAt)
      const updated = await db.update(lakalaOnboardingApplications).set({
        lastErrorCode: result.errorCode ?? 'AUDIT_QUERY_FAILED',
        lastErrorMessage: '拉卡拉审核状态查询失败，请稍后重试',
        updatedAt: failedAt,
      }).where(and(
        scopedApplicationCondition(session, applicationId),
        lockCondition(applicationId, row.app.updatedAt),
      ))
      if (rowsAffected(updated) === 0) return { success: false, message: '数据已被其他人修改，请刷新后重试' }
      return { success: false, message: '拉卡拉审核状态查询失败，请稍后重试' }
    }
    if (result.status === 'SUCCESS' && !nextMerchantNo) {
      return { success: false, message: '拉卡拉审核通过但未返回银联商户号，暂不绑定收款商户' }
    }

    const statusUpdatedAt = nextUpdatedAt(row.app.updatedAt)
    const updated = await db.update(lakalaOnboardingApplications).set({
      status: result.status,
      merInnerNo: result.innerCustomerNo ?? row.app.merInnerNo,
      merCupNo: nextMerchantNo ?? null,
      terminalData: nextTerminalData,
      channelData: result.status === 'SUCCESS'
        ? markSubMerchantPollingStartedAt(row.app.channelData, statusUpdatedAt)
        : row.app.channelData,
      // 审核通过只保存拉卡拉编号；微信认证通过后再自动建档、绑门店并启用。
      lakalaMerchantId: row.app.lakalaMerchantId,
      lastErrorCode: result.status === 'FAILED' ? result.errorCode ?? 'AUDIT_REJECTED' : null,
      lastErrorMessage: result.status === 'FAILED' ? '拉卡拉审核未通过，请修正资料后重新提交' : null,
      updatedAt: statusUpdatedAt,
    }).where(and(
      scopedApplicationCondition(session, applicationId),
      lockCondition(applicationId, row.app.updatedAt),
    ))
    if (rowsAffected(updated) === 0) {
      return { success: false, message: '数据已被其他操作修改，请刷新后重试' }
    }
    if (result.status === 'SUCCESS') {
      await logTransition(session, 'merchant.onboarding.approved', 'lakala_onboarding_application', applicationId, row.app.status, 'SUCCESS', {
        collectionMerchantBound: Boolean(row.app.lakalaMerchantId),
        collectionMerchantEnabled: false,
      })
      await refreshSubMerchantsInternal(session, applicationId)
      revalidateOnboarding(applicationId)
      return { success: true, message: '拉卡拉审核通过；请查询渠道子商户号并完成微信认证' }
    }
    if (result.status === 'FAILED') {
      await logTransition(session, 'merchant.onboarding.rejected', 'lakala_onboarding_application', applicationId, row.app.status, 'FAILED')
      revalidateOnboarding(applicationId)
      return { success: false, message: '拉卡拉审核未通过，请修正资料后重新提交' }
    }
    revalidateOnboarding(applicationId)
    return { success: true, message: '拉卡拉正在审核，请稍后再次查询' }
  } catch (error) {
    // 记录外部查询异常，便于区分"拉卡拉正在审核"和"网络不通/配置错误"。
    const failedAt = nextUpdatedAt(row.app.updatedAt)
    await db.update(lakalaOnboardingApplications).set({
      lastErrorCode: 'REGISTER_STATUS_QUERY_FAILED',
      lastErrorMessage: safeExternalMessage(error, '审核状态查询失败'),
      updatedAt: failedAt,
    }).where(and(
      scopedApplicationCondition(session, applicationId),
      lockCondition(applicationId, row.app.updatedAt),
    ))
    return { success: false, message: safeExternalMessage(error, '审核状态查询失败') }
  }
}

function channelEntries(channelData: Record<string, unknown>, name: 'wechat' | 'alipay'): Array<Record<string, unknown>> {
  const rows = channelData[name]
  return Array.isArray(rows) ? rows.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : []
}

function certificationCompleted(result: LakalaCertificationResult): boolean {
  if (certificationFailed(result)) return false
  const register = result.registerState?.toUpperCase()
  const authorization = result.authorizeState?.toUpperCase()
  const applyment = result.applymentState?.toUpperCase()
  return result.success &&
    (register === 'SUCCESS' || result.registerCode === '000000' || result.registerMsg === '成功') &&
    (!authorization || ['SUCCESS', 'AUTHORIZED', 'AUTHORIZE_STATE_AUTHORIZED', 'AUTHORIZE_STATE_SUCCESS'].includes(authorization)) &&
    (!applyment || ['SUCCESS', 'APPLYMENT_STATE_SUCCESS', 'APPLYMENT_STATE_FINISHED', 'APPLYMENT_STATE_PASSED'].includes(applyment))
}

function certificationFailed(result: Pick<LakalaCertificationResult, 'registerState' | 'authorizeState' | 'applymentState' | 'registerCode' | 'rejectReason' | 'errorMessage'>): boolean {
  if (result.rejectReason || result.errorMessage) return true
  const values = [result.registerState, result.authorizeState, result.applymentState, result.registerCode]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toUpperCase())
  return values.some((value) => ['FAIL', 'REJECT', 'UNAUTHORIZED', 'INVALID', 'ERROR'].some((token) => value.includes(token)))
}

function certificationFailureReason(result: LakalaCertificationResult): string {
  return result.rejectReason
    || result.errorMessage
    || result.registerMsg
    || result.errorCode
    || '微信认证未通过'
}

async function refreshOnboardingCertificationStatusInternal(session: AuthSession, applicationId: string): Promise<{ success: boolean; message: string }> {
  if (!parseId(applicationId)) return { success: false, message: '申请不存在' }
  const row = await getScopedApplication(session, applicationId)
  if (!row) return { success: false, message: '申请不存在或无权访问' }
  if (row.app.status !== 'SUCCESS' || !row.app.merCupNo) {
    return { success: false, message: '仅审核通过的申请可查询外部认证状态' }
  }
  const channelData = (row.app.channelData as Record<string, unknown>) ?? {}
  const wechat = channelEntries(channelData, 'wechat')[0]
  if (!wechat) return { success: false, message: '请先查询微信子商户号' }
  try {
    const [wechatResult, alipayResult] = await Promise.all([
      writeRequestLog({
        applicationId,
        apiName: 'tkbs.open_merchant_register_status_query.WXZF',
        requestPayload: { merchantNo: row.app.merCupNo, registerType: 'WXZF' },
        invoke: () => lakalaQueryRegisterStatus({ merchantNo: row.app.merCupNo!, registerType: 'WXZF' }),
      }),
      writeRequestLog({
        applicationId,
        apiName: 'tkbs.open_merchant_register_status_query.ZFBZF',
        requestPayload: { merchantNo: row.app.merCupNo, registerType: 'ZFBZF' },
        invoke: () => lakalaQueryRegisterStatus({ merchantNo: row.app.merCupNo!, registerType: 'ZFBZF' }),
      }),
    ])
    const checkedAt = new Date().toISOString()
    const wechatPassed = certificationCompleted(wechatResult)
    const wechatFailed = !wechatResult.success || certificationFailed(wechatResult)
    const terminalNumber = terminalNo(row.app.terminalData)
    const previousPolling = channelData.certificationPolling && typeof channelData.certificationPolling === 'object' && !Array.isArray(channelData.certificationPolling)
      ? channelData.certificationPolling as Record<string, unknown>
      : {}
    const reason = wechatPassed
      ? terminalNumber ? '微信认证已通过，办理完成' : '微信认证已通过，等待拉卡拉返回终端号'
      : wechatFailed ? certificationFailureReason(wechatResult) : '微信认证暂未通过，请稍后再次查询'
    const next = {
      ...channelData,
      wechatCertification: serializeChannelResult(wechatResult),
      alipayCertification: serializeChannelResult(alipayResult),
      certificationPolling: {
        ...previousPolling,
        status: wechatPassed ? terminalNumber ? 'DONE' : 'WAIT_TERMINAL' : wechatFailed ? 'FAILED' : 'ACTIVE',
        startedAt: typeof previousPolling.startedAt === 'string' ? previousPolling.startedAt : checkedAt,
        lastCheckedAt: checkedAt,
        stoppedAt: wechatPassed || wechatFailed ? checkedAt : null,
        reason,
      },
    }

    if (wechatPassed && terminalNumber) {
      const merchantId = await db.transaction(async (tx) => {
        const claimedAt = nextUpdatedAt(row.app.updatedAt)
        const claimed = await tx.update(lakalaOnboardingApplications).set({ updatedAt: claimedAt })
          .where(and(
            lockCondition(applicationId, row.app.updatedAt),
            applicationScopeCondition(session),
          ))
        if (rowsAffected(claimed) === 0) throw new Error('CONFLICT: 申请已被其他操作修改，请刷新后重试')
        const linkedId = await bindApprovedMerchantInTransaction(
          tx,
          session,
          row.app,
          row.app.merCupNo!,
          terminalNumber,
          true,
        )
        const finalizedAt = nextUpdatedAt(claimedAt)
        const finalized = await tx.update(lakalaOnboardingApplications).set({
          lakalaMerchantId: linkedId,
          channelData: next,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: finalizedAt,
        }).where(and(
          scopedApplicationCondition(session, applicationId),
          lockCondition(applicationId, claimedAt),
        ))
        if (rowsAffected(finalized) === 0) throw new Error('CONFLICT: 申请已被其他操作修改，请刷新后重试')
        return linkedId
      })
      await logOperation(session, 'merchant.onboarding.certification.complete', 'lakala_onboarding_application', applicationId, {
        applicationNo: row.app.applicationNo,
        collectionMerchantId: merchantId,
        collectionMerchantEnabled: true,
        alipayCertificationCompleted: certificationCompleted(alipayResult),
      })
      revalidateOnboarding(applicationId)
      return { success: true, message: '微信认证已通过，办理完成，收款商户已启用' }
    }

    if (wechatFailed) {
      await db.transaction(async (tx) => {
        const claimedAt = nextUpdatedAt(row.app.updatedAt)
        const claimed = await tx.update(lakalaOnboardingApplications).set({ updatedAt: claimedAt })
          .where(and(
            lockCondition(applicationId, row.app.updatedAt),
            applicationScopeCondition(session),
          ))
        if (rowsAffected(claimed) === 0) throw new Error('CONFLICT: 申请已被其他操作修改，请刷新后重试')
        await revokeApprovedMerchantInTransaction(tx, session, row.app)
        const finalizedAt = nextUpdatedAt(claimedAt)
        const finalized = await tx.update(lakalaOnboardingApplications).set({
          lakalaMerchantId: null,
          channelData: next,
          lastErrorCode: wechatResult.errorCode ?? 'WECHAT_CERTIFICATION_FAILED',
          lastErrorMessage: reason,
          updatedAt: finalizedAt,
        }).where(and(
          scopedApplicationCondition(session, applicationId),
          lockCondition(applicationId, claimedAt),
        ))
        if (rowsAffected(finalized) === 0) throw new Error('CONFLICT: 申请已被其他操作修改，请刷新后重试')
      })
      await logOperation(session, 'merchant.onboarding.certification.failed', 'lakala_onboarding_application', applicationId, {
        applicationNo: row.app.applicationNo,
        revokedCollectionMerchantId: row.app.lakalaMerchantId,
      })
      revalidateOnboarding(applicationId)
      return { success: true, message: `微信认证未通过：${reason}` }
    }

    const refreshedAt = nextUpdatedAt(row.app.updatedAt)
    const updated = await db.update(lakalaOnboardingApplications).set({
      channelData: next,
      lastErrorCode: null,
      lastErrorMessage: wechatPassed ? '微信认证已通过，但尚未获取终端号，请点击查询审核状态' : null,
      updatedAt: refreshedAt,
    }).where(and(
      scopedApplicationCondition(session, applicationId),
      lockCondition(applicationId, row.app.updatedAt),
    ))
    if (rowsAffected(updated) === 0) return { success: false, message: '数据已被其他人修改，请刷新后重试' }
    revalidateOnboarding(applicationId)
    return wechatPassed
      ? { success: true, message: '微信认证已通过，但尚未获取终端号；获取后再刷新认证状态即会自动启用收款' }
      : { success: true, message: '微信认证暂未通过，请稍后再次查询' }
  } catch (error) {
    return { success: false, message: safeExternalMessage(error, '外部认证状态查询失败') }
  }
}

/** 操作员手工确认渠道认证后，创建/复用未启用收款商户并绑定门店。 */
async function confirmOnboardingExternalCertificationInternal(session: AuthSession, applicationId: string): Promise<{ success: boolean; message: string }> {
  if (!parseId(applicationId)) return { success: false, message: '申请不存在' }
  const row = await getScopedApplication(session, applicationId)
  if (!row) return { success: false, message: '申请不存在或无权访问' }
  if (row.app.status !== 'SUCCESS') return { success: false, message: '请先等待拉卡拉入网审核通过' }
  if (row.app.lakalaMerchantId) return { success: true, message: '收款商户已关联门店' }
  const channelData = row.app.channelData && typeof row.app.channelData === 'object'
    ? row.app.channelData as Record<string, unknown>
    : {}
  const terminalNumber = terminalNo(row.app.terminalData)
  const missing = [
    row.app.merCupNo?.startsWith('82') ? null : '银联商户号',
    terminalNumber ? null : '终端号',
    channelEntries(channelData, 'wechat').length ? null : '微信子商户号',
    channelEntries(channelData, 'alipay').length ? null : '支付宝子商户号',
  ].filter((item): item is string => Boolean(item))
  if (missing.length) return { success: false, message: `请先取得：${missing.join('、')}` }

  const merchantId = await db.transaction(async (tx) => {
    const claimedAt = nextUpdatedAt(row.app.updatedAt)
    const claimed = await tx.update(lakalaOnboardingApplications).set({ updatedAt: claimedAt })
      .where(and(
        lockCondition(applicationId, row.app.updatedAt),
        applicationScopeCondition(session),
        isNull(lakalaOnboardingApplications.lakalaMerchantId),
      ))
    if (rowsAffected(claimed) === 0) throw new Error('CONFLICT: 申请已被其他操作修改，请刷新后重试')
    const linkedId = await bindApprovedMerchantInTransaction(
      tx,
      session,
      row.app,
      row.app.merCupNo!,
      terminalNumber ?? undefined,
      false,
    )
    const finalizedAt = nextUpdatedAt(claimedAt)
    const finalized = await tx.update(lakalaOnboardingApplications).set({
      lakalaMerchantId: linkedId,
      channelData: {
        ...channelData,
        externalCertificationConfirmedAt: new Date().toISOString(),
        externalCertificationConfirmedBy: session.name || session.phone || session.employeeId,
      },
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: finalizedAt,
    }).where(and(
      scopedApplicationCondition(session, applicationId),
      lockCondition(applicationId, claimedAt),
    ))
    if (rowsAffected(finalized) === 0) throw new Error('CONFLICT: 申请已被其他操作修改，请刷新后重试')
    return linkedId
  })
  await logOperation(session, 'merchant.onboarding.certification.confirm', 'lakala_onboarding_application', applicationId, {
    applicationNo: row.app.applicationNo,
    collectionMerchantId: merchantId,
    collectionMerchantEnabled: false,
  })
  revalidateOnboarding(applicationId)
  return { success: true, message: '外部认证已完成，收款商户已关联门店并保持未启用，请在收款商户页人工启用' }
}

async function testOnboardingWechatAuthStateInternal(session: AuthSession, applicationId: string): Promise<{ success: boolean; message: string; result?: { checkResult?: string } }> {
  if (!parseId(applicationId)) return { success: false, message: '申请不存在' }
  const row = await getScopedApplication(session, applicationId)
  if (!row) return { success: false, message: '申请不存在或无权访问' }
  const channels = (row.app.channelData as Record<string, unknown>) ?? {}
  const wechat = channelEntries(channels, 'wechat')[0]
  const subMerchantId = typeof wechat?.subMerchantNo === 'string' ? wechat.subMerchantNo : ''
  if (!row.app.merCupNo || !subMerchantId) return { success: false, message: '缺少微信子商户号或银联商户号' }
  try {
    const result = await writeRequestLog({
      applicationId,
      apiName: 'mms.sme.mrchAuthStateQuery.WECHAT',
      requestPayload: { merchantNo: row.app.merCupNo, tradeMode: 'WECHAT', subMerchantId },
      invoke: () => lakalaQueryMerchantAuthState({ merchantNo: row.app.merCupNo!, tradeMode: 'WECHAT', subMerchantId }),
    })
    return {
      success: result.success,
      message: result.success ? '微信开户状态查询成功' : '微信开户状态查询失败',
      result: result.success ? { checkResult: result.checkResult } : undefined,
    }
  } catch (error) {
    return { success: false, message: safeExternalMessage(error, '微信开户状态查询失败') }
  }
}

async function searchOnboardingBanksInternal(
  session: AuthSession,
  applicationId: string,
  bankName: string,
  areaCode?: string,
): Promise<{ success: boolean; message: string; areaCode?: string; banks: OnboardingBankOption[] }> {
  if (!parseId(applicationId)) return { success: false, message: '申请不存在', banks: [] }
  const row = await getScopedApplication(session, applicationId)
  if (!row) return { success: false, message: '申请不存在或无权访问', banks: [] }
  const keyword = bankName.trim()
  if (keyword.length < 2 || keyword.length > 80) return { success: false, message: '请输入 2 到 80 个字符的银行名称', banks: [] }
  const data = dataFromApplication(row.app)
  const selectedDistrictCode = areaCode?.trim() || data.settlementData.bankDistCode || data.merchantData.merRegDistCode
  const selectedArea = getLakalaMerchantAreaPathByCode(selectedDistrictCode)
  if (!selectedArea.countyCode) return { success: false, message: '请先选择开户行所在地区', banks: [] }
  const areaKeywords = bankAreaKeywords(selectedArea.label)
  try {
    const configuredAreaCode = data.settlementData.bankAreaCode
    if (configuredAreaCode) {
      const directLocal = await queryLocalLakalaBanks({ areaCode: configuredAreaCode, bankName: keyword })
      if (directLocal.length) {
        return {
          success: true,
          message: `已从本地拉卡拉银行字典找到 ${directLocal.length} 个匹配支行`,
          areaCode: configuredAreaCode,
          banks: directLocal,
        }
      }
    }
    const localBanks = await queryLocalLakalaBanksByAreaKeywords({ areaKeywords, bankName: keyword })
    if (localBanks.length) {
      return {
        success: true,
        message: `已从本地拉卡拉银行字典找到 ${localBanks.length} 个匹配支行`,
        areaCode: localBanks[0].areaCode,
        banks: localBanks,
      }
    }
    const inferredAreaCodes = await findLocalLakalaBankAreaCodes(areaKeywords)
    const resolvedAreaCode = configuredAreaCode || inferredAreaCodes[0] || data.settlementData.settleCityCode || data.merchantData.merRegCityCode
    if (!resolvedAreaCode) return { success: false, message: '未能匹配开户行城市地区码', banks: [] }
    const result = await writeRequestLog({
      applicationId,
      apiName: 'tkbs.bank',
      requestPayload: { areaCode: resolvedAreaCode, bankName: keyword },
      invoke: () => lakalaQueryBanks({ areaCode: resolvedAreaCode, bankName: keyword }),
    })
    return {
      success: result.success,
      message: result.success
        ? (result.banks.length ? `本地未命中，已在线找到 ${result.banks.length} 个匹配支行` : '未找到匹配支行')
        : '拉卡拉银行列表查询失败',
      areaCode: resolvedAreaCode,
      banks: result.banks,
    }
  } catch (error) {
    return { success: false, message: safeExternalMessage(error, '拉卡拉银行列表查询失败'), banks: [] }
  }
}

async function cancelOnboardingApplicationInternal(
  session: AuthSession,
  applicationId: string,
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  if (!parseId(applicationId)) return { success: false, message: '申请不存在' }
  const row = await getScopedApplication(session, applicationId)
  if (!row) return { success: false, message: '申请不存在或无权访问' }
  if (!['DRAFT', 'FILES_UPLOADING', 'FILES_READY', 'FAILED'].includes(row.app.status)) {
    return { success: false, message: `当前状态“${statusLabel(row.app.status)}”不能取消` }
  }
  if (row.app.eContractOrderNo) {
    return { success: false, message: '电子合同已发起，不能取消，请先联系拉卡拉确认签约状态' }
  }
  const lockAt = parseExpectedUpdatedAt(expectedUpdatedAt, row.app.updatedAt)
  if (!lockAt || lockAt.getTime() !== row.app.updatedAt.getTime()) return { success: false, message: '数据已被其他人修改，请刷新后重试' }
  const updated = await updateWithOptimisticLock(session, applicationId, lockAt, { status: 'CANCELLED' })
  if (!updated) return { success: false, message: '数据已被其他人修改，请刷新后重试' }
  await logTransition(session, 'merchant.onboarding.cancel', 'lakala_onboarding_application', applicationId, row.app.status, 'CANCELLED')
  revalidateOnboarding(applicationId)
  return { success: true, message: '入网申请已取消，私有资料按留存策略保留' }
}

// Server Action 公开入口统一经过权限 HOF；内部函数保留可复用的 session 参数，
// 这样 Route Handler 和页面调用都不会绕过门店 scope 校验。
export const getOnboardingStoreOptions = withPermission(
  'merchant:list',
  async (session) => getOnboardingStoreOptionsInternal(session),
)

export const listOnboardingApplications = withPermission(
  'merchant:list',
  async (session) => listOnboardingApplicationsInternal(session),
)

export const getOnboardingApplication = withPermission(
  'merchant:list',
  async (session, id: string) => getOnboardingApplicationInternal(session, id),
)

export const createOnboardingApplication = withPermission(
  'merchant:create',
  async (session, storeId: string) => createOnboardingApplicationInternal(session, storeId),
)

export const saveOnboardingApplication = withPermission(
  'merchant:update',
  async (session, id: string, input: unknown, expectedUpdatedAt?: string) => (
    saveOnboardingApplicationInternal(session, id, input, expectedUpdatedAt)
  ),
)

export const uploadOnboardingAttachment = withPermission(
  'merchant:update',
  async (
    session,
    applicationId: string,
    file: UploadFileLike,
    attachmentType: string,
    displayName: string,
    expectedUpdatedAt?: string,
  ) => uploadOnboardingAttachmentInternal(session, applicationId, file, attachmentType, displayName, expectedUpdatedAt),
)

export const getOnboardingAttachmentForDownload = withPermission(
  'merchant:list',
  async (session, applicationId: string, attachmentId: string) => (
    getOnboardingAttachmentForDownloadInternal(session, applicationId, attachmentId)
  ),
)

export const initiateElectronicContract = withPermission(
  'merchant:update',
  async (session, applicationId: string, expectedUpdatedAt?: string) => (
    initiateElectronicContractInternal(session, applicationId, expectedUpdatedAt)
  ),
)

export const refreshElectronicContractStatus = withPermission(
  'merchant:update',
  async (session, applicationId: string) => refreshElectronicContractStatusInternal(session, applicationId),
)

export const submitOnboardingApplication = withPermission(
  'merchant:update',
  async (session, applicationId: string) => submitOnboardingApplicationInternal(session, applicationId),
)

export const reconsiderOnboardingApplication = withPermission(
  'merchant:update',
  async (session, applicationId: string) => reconsiderOnboardingApplicationInternal(session, applicationId),
)

export const refreshOnboardingSubMerchants = withPermission(
  'merchant:update',
  async (session, applicationId: string) => refreshOnboardingSubMerchantsInternalAction(session, applicationId),
)

export const queryOnboardingApplication = withPermission(
  'merchant:update',
  async (session, applicationId: string) => queryOnboardingApplicationInternal(session, applicationId),
)

export const refreshOnboardingCertificationStatus = withPermission(
  'merchant:update',
  async (session, applicationId: string) => refreshOnboardingCertificationStatusInternal(session, applicationId),
)

export const confirmOnboardingExternalCertification = withPermission(
  'merchant:update',
  async (session, applicationId: string) => confirmOnboardingExternalCertificationInternal(session, applicationId),
)

export const testOnboardingWechatAuthState = withPermission(
  'merchant:update',
  async (session, applicationId: string) => testOnboardingWechatAuthStateInternal(session, applicationId),
)

export const searchOnboardingBanks = withPermission(
  'merchant:update',
  async (session, applicationId: string, bankName: string, areaCode?: string) => (
    searchOnboardingBanksInternal(session, applicationId, bankName, areaCode)
  ),
)

export const cancelOnboardingApplication = withPermission(
  'merchant:update',
  async (session, applicationId: string, expectedUpdatedAt?: string) => (
    cancelOnboardingApplicationInternal(session, applicationId, expectedUpdatedAt)
  ),
)
