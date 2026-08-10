/**
 * 每小时主动查询拉卡拉电子合同，并在签约完成时下载私有 PDF。
 *
 * 不接收供应商回调，不创建运行时表；所有候选、时间窗与幂等结果均由现有
 * onboarding schema 控制。请求日志只保留脱敏摘要。
 */

import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm'
import {
  lakalaOnboardingApplications,
  lakalaOnboardingAttachments,
  lakalaOnboardingRequestLogs,
} from '@db/lakala-onboarding'
import {
  lakalaDownloadElectronicContract,
  lakalaQueryElectronicContract,
} from '@/lib/lakala-onboarding'
import { ELECTRONIC_CONTRACT_PDF_ATTACHMENT } from '@/lib/lakala-onboarding-constants'
import {
  bufferToUploadFileLike,
  getPrivateUploadRoot,
  savePrivateOnboardingFile,
} from '@/lib/upload-file'
import { rowsAffected } from '@/lib/pg-rows'
import type { Db } from '../run'

const POLL_WINDOW_MS = 72 * 60 * 60 * 1000
const POLL_LIMIT = 25

type JsonRecord = Record<string, unknown>

export interface RefreshLakalaContractsResult {
  eligible: number
  checked: number
  completed: number
  pending: number
  timedOut: number
  failed: number
  skippedDisabled: boolean
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function contractPollingState(
  channelData: JsonRecord,
  state: 'WAITING' | 'DONE' | 'TIMEOUT',
  now: Date,
  startedAt: Date,
): JsonRecord {
  const previous = asRecord(channelData.electronicContractPolling)
  return {
    ...channelData,
    electronicContractPolling: {
      ...previous,
      status: state,
      startedAt: asDate(previous.startedAt)?.toISOString() ?? startedAt.toISOString(),
      lastCheckedAt: now.toISOString(),
      ...(state === 'TIMEOUT' ? { stoppedAt: now.toISOString() } : {}),
    },
  }
}

function contractPollingStartedAt(channelData: JsonRecord, application: { updatedAt: Date; createdAt: Date }): Date {
  return asDate(asRecord(channelData.electronicContractPolling).startedAt)
    ?? application.updatedAt
    ?? application.createdAt
}

function contractCompleted(status: string | undefined): boolean {
  return ['COMPLETED', 'SUCCESS', 'SIGNED', 'FINISHED'].includes((status ?? '').toUpperCase())
}

function contractFailed(status: string | undefined): boolean {
  return ['FAILED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes((status ?? '').toUpperCase())
}

async function writePollLog(
  db: Db,
  input: {
    applicationId: string
    apiName: string
    idempotencyKey: string
    success: boolean
    response: JsonRecord
    errorCode?: string
  },
): Promise<void> {
  try {
    await db.insert(lakalaOnboardingRequestLogs).values({
      id: `ol_${randomUUID()}`,
      applicationId: input.applicationId,
      apiName: input.apiName,
      requestId: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      requestPayloadMasked: { source: 'scheduled-poll' },
      responsePayloadMasked: input.response,
      status: input.success ? 'SUCCEEDED' : 'FAILED',
      errorCode: input.errorCode ?? null,
      errorMessage: input.success ? null : '拉卡拉电子合同轮询未成功',
      completedAt: new Date(),
    })
  } catch {
    // 轮询审计不可用时不丢弃已完成的供应商状态同步，且不输出原始错误。
    console.error('拉卡拉电子合同轮询日志写入失败')
  }
}

async function cleanupOrphanFile(storageKey: string): Promise<void> {
  try {
    await unlink(path.join(getPrivateUploadRoot(), storageKey))
  } catch {
    console.error('拉卡拉电子合同孤儿附件清理失败')
  }
}

/**
 * 将未完成的合同限制在 72 小时主动轮询窗口内。成功、供应商拒绝或超时均写入终态标记，
 * 防止历史申请占满批处理候选窗口。
 */
export async function refreshLakalaContracts(db: Db): Promise<RefreshLakalaContractsResult> {
  const result: RefreshLakalaContractsResult = {
    eligible: 0,
    checked: 0,
    completed: 0,
    pending: 0,
    timedOut: 0,
    failed: 0,
    skippedDisabled: process.env.LAKALA_ONBOARDING_ENABLED !== 'true',
  }
  if (result.skippedDisabled) return result

  const applications = await db.select({
    id: lakalaOnboardingApplications.id,
    eContractOrderNo: lakalaOnboardingApplications.eContractOrderNo,
    eContractApplyId: lakalaOnboardingApplications.eContractApplyId,
    eContractNo: lakalaOnboardingApplications.eContractNo,
    status: lakalaOnboardingApplications.status,
    channelData: lakalaOnboardingApplications.channelData,
    updatedAt: lakalaOnboardingApplications.updatedAt,
    createdAt: lakalaOnboardingApplications.createdAt,
  }).from(lakalaOnboardingApplications).where(and(
    isNotNull(lakalaOnboardingApplications.eContractOrderNo),
    // 已取消的申请不再触达拉卡拉，也不能被轮询任务推进合同状态。
    ne(lakalaOnboardingApplications.status, 'CANCELLED'),
    sql`COALESCE(${lakalaOnboardingApplications.channelData}->'electronicContractPolling'->>'status', '') NOT IN ('DONE', 'TIMEOUT')`,
  )).orderBy(
    asc(lakalaOnboardingApplications.updatedAt),
    asc(lakalaOnboardingApplications.id),
  ).limit(POLL_LIMIT)

  const now = new Date()
  for (const application of applications) {
    // SQL 是主防线；运行时检查保障旧数据、测试替身或未来查询重构不会绕过取消终态。
    if (!application.eContractOrderNo || application.status === 'CANCELLED') continue
    const channelData = asRecord(application.channelData)
    const startedAt = contractPollingStartedAt(channelData, application)
    result.eligible += 1

    if (now.getTime() - startedAt.getTime() > POLL_WINDOW_MS) {
      const timeoutUpdate = await db.update(lakalaOnboardingApplications).set({
        channelData: contractPollingState(channelData, 'TIMEOUT', now, startedAt),
        lastErrorCode: 'ECONTRACT_POLL_TIMEOUT',
        lastErrorMessage: '电子合同在 72 小时内未完成，请联系拉卡拉确认签约状态',
        updatedAt: now,
      }).where(and(
        eq(lakalaOnboardingApplications.id, application.id),
        eq(lakalaOnboardingApplications.updatedAt, application.updatedAt),
        ne(lakalaOnboardingApplications.status, 'CANCELLED'),
      ))
      if (rowsAffected(timeoutUpdate)) result.timedOut += 1
      continue
    }

    let statusResult: Awaited<ReturnType<typeof lakalaQueryElectronicContract>>
    try {
      statusResult = await lakalaQueryElectronicContract({
        orderNo: application.eContractOrderNo,
        applyId: application.eContractApplyId,
      })
    } catch {
      statusResult = { success: false, errorCode: 'REQUEST_FAILED', errorMessage: '电子合同状态查询请求失败', raw: {} }
    }
    result.checked += 1
    const status = statusResult.status?.toUpperCase() || 'PENDING'
    await writePollLog(db, {
      applicationId: application.id,
      apiName: 'mms.ec.q_status',
      idempotencyKey: `econtract-status:${application.id}:${Math.floor(now.getTime() / 3_600_000)}`,
      success: statusResult.success,
      response: { success: statusResult.success, status, errorCode: statusResult.errorCode ?? null },
      errorCode: statusResult.errorCode,
    })

    if (!statusResult.success) {
      const update = await db.update(lakalaOnboardingApplications).set({
        channelData: contractPollingState(channelData, 'WAITING', now, startedAt),
        lastErrorCode: statusResult.errorCode ?? 'ECONTRACT_STATUS_QUERY_FAILED',
        lastErrorMessage: '电子合同状态查询失败，将在下一轮自动重试',
        updatedAt: now,
      }).where(and(
        eq(lakalaOnboardingApplications.id, application.id),
        eq(lakalaOnboardingApplications.updatedAt, application.updatedAt),
        ne(lakalaOnboardingApplications.status, 'CANCELLED'),
      ))
      if (rowsAffected(update)) result.failed += 1
      continue
    }

    if (!contractCompleted(status)) {
      const terminal = contractFailed(status)
      const update = await db.update(lakalaOnboardingApplications).set({
        eContractStatus: status,
        channelData: contractPollingState(channelData, terminal ? 'DONE' : 'WAITING', now, startedAt),
        ...(terminal
          ? { lastErrorCode: 'ECONTRACT_NOT_COMPLETED', lastErrorMessage: '拉卡拉电子合同未完成，请人工核对签约结果' }
          : { lastErrorCode: null, lastErrorMessage: null }),
        updatedAt: now,
      }).where(and(
        eq(lakalaOnboardingApplications.id, application.id),
        eq(lakalaOnboardingApplications.updatedAt, application.updatedAt),
        ne(lakalaOnboardingApplications.status, 'CANCELLED'),
      ))
      if (rowsAffected(update)) {
        if (terminal) result.failed += 1
        else result.pending += 1
      }
      continue
    }

    const contractNo = statusResult.contractNo ?? application.eContractNo
    if (!contractNo) {
      const update = await db.update(lakalaOnboardingApplications).set({
        channelData: contractPollingState(channelData, 'WAITING', now, startedAt),
        lastErrorCode: 'ECONTRACT_NUMBER_MISSING',
        lastErrorMessage: '电子合同已完成但拉卡拉未返回合同号，将在下一轮重试',
        updatedAt: now,
      }).where(and(
        eq(lakalaOnboardingApplications.id, application.id),
        eq(lakalaOnboardingApplications.updatedAt, application.updatedAt),
        ne(lakalaOnboardingApplications.status, 'CANCELLED'),
      ))
      if (rowsAffected(update)) result.failed += 1
      continue
    }

    let downloadResult: Awaited<ReturnType<typeof lakalaDownloadElectronicContract>>
    try {
      downloadResult = await lakalaDownloadElectronicContract({ orderNo: application.eContractOrderNo, contractNo })
    } catch {
      downloadResult = { success: false, errorCode: 'REQUEST_FAILED', errorMessage: '电子合同下载请求失败', raw: {} }
    }
    await writePollLog(db, {
      applicationId: application.id,
      apiName: 'mms.ec.download',
      idempotencyKey: `econtract-download:${application.id}`,
      success: downloadResult.success,
      response: { success: downloadResult.success, pdfStored: Boolean(downloadResult.pdfBytes), errorCode: downloadResult.errorCode ?? null },
      errorCode: downloadResult.errorCode,
    })
    if (!downloadResult.success || !downloadResult.pdfBytes) {
      const update = await db.update(lakalaOnboardingApplications).set({
        channelData: contractPollingState(channelData, 'WAITING', now, startedAt),
        lastErrorCode: downloadResult.errorCode ?? 'ECONTRACT_DOWNLOAD_FAILED',
        lastErrorMessage: '电子合同下载失败，将在下一轮自动重试',
        updatedAt: now,
      }).where(and(
        eq(lakalaOnboardingApplications.id, application.id),
        eq(lakalaOnboardingApplications.updatedAt, application.updatedAt),
        ne(lakalaOnboardingApplications.status, 'CANCELLED'),
      ))
      if (rowsAffected(update)) result.failed += 1
      continue
    }

    let saved: Awaited<ReturnType<typeof savePrivateOnboardingFile>>
    try {
      saved = await savePrivateOnboardingFile(
        application.id,
        bufferToUploadFileLike(downloadResult.pdfBytes, ELECTRONIC_CONTRACT_PDF_ATTACHMENT.displayName, 'application/pdf'),
      )
    } catch {
      const update = await db.update(lakalaOnboardingApplications).set({
        channelData: contractPollingState(channelData, 'WAITING', now, startedAt),
        lastErrorCode: 'ECONTRACT_PRIVATE_SAVE_FAILED',
        lastErrorMessage: '电子合同私有归档失败，将在下一轮自动重试',
        updatedAt: now,
      }).where(and(
        eq(lakalaOnboardingApplications.id, application.id),
        eq(lakalaOnboardingApplications.updatedAt, application.updatedAt),
        ne(lakalaOnboardingApplications.status, 'CANCELLED'),
      ))
      if (rowsAffected(update)) result.failed += 1
      continue
    }

    try {
      await db.transaction(async (tx) => {
        const updated = await tx.update(lakalaOnboardingApplications).set({
          eContractStatus: 'COMPLETED',
          eContractNo: contractNo,
          eContractSignedAt: now,
          channelData: contractPollingState(channelData, 'DONE', now, startedAt),
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: now,
        }).where(and(
          eq(lakalaOnboardingApplications.id, application.id),
          eq(lakalaOnboardingApplications.updatedAt, application.updatedAt),
          ne(lakalaOnboardingApplications.status, 'CANCELLED'),
        ))
        if (rowsAffected(updated) === 0) throw new Error('optimistic-lock')
        await tx.update(lakalaOnboardingAttachments).set({ status: 'DELETED', updatedAt: now })
          .where(and(
            eq(lakalaOnboardingAttachments.applicationId, application.id),
            eq(lakalaOnboardingAttachments.attachmentType, ELECTRONIC_CONTRACT_PDF_ATTACHMENT.attachmentType),
            sql`${lakalaOnboardingAttachments.status} <> 'DELETED'`,
          ))
        await tx.insert(lakalaOnboardingAttachments).values({
          id: `oa_${randomUUID()}`,
          applicationId: application.id,
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
      result.completed += 1
    } catch {
      await cleanupOrphanFile(saved.storageKey)
      result.failed += 1
    }
  }

  return result
}
