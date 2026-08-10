/**
 * 每小时轮询已成功入网申请的微信 / 支付宝子商户号。
 *
 * 轮询不会创建表或补列；所有结构由 Drizzle migration 管理。外部响应仅转成
 * 计数和状态写入日志，避免商户号、证件或渠道资料进入可检索日志。
 */

import { randomUUID } from 'node:crypto'
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm'
import {
  lakalaOnboardingApplications,
  lakalaOnboardingRequestLogs,
} from '@db/lakala-onboarding'
import { lakalaQueryChannelSubMerchants } from '@/lib/lakala-onboarding'
import { rowsAffected } from '@/lib/pg-rows'
import type { Db } from '../run'

const POLL_TIMEOUT_MS = 72 * 60 * 60 * 1000
const POLL_LIMIT = 100

type JsonRecord = Record<string, unknown>

export interface RefreshLakalaSubMerchantsResult {
  eligible: number
  checked: number
  completed: number
  timedOut: number
  failed: number
  skippedDisabled: boolean
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

function hasSubMerchant(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => {
    const record = asRecord(item)
    return typeof record.subMerchantNo === 'string' && record.subMerchantNo.length > 0
  })
}

function hasAllChannels(channelData: JsonRecord): boolean {
  return hasSubMerchant(channelData.wechat) && hasSubMerchant(channelData.alipay)
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function pollState(
  channelData: JsonRecord,
  state: 'WAITING' | 'DONE' | 'TIMEOUT',
  now: Date,
  startedAt: Date,
): JsonRecord {
  const previous = asRecord(channelData.subMerchantPolling)
  return {
    ...channelData,
    subMerchantPolling: {
      ...previous,
      status: state,
      // 重试时保持首次审核通过/首次轮询的起点不变。
      startedAt: asDate(previous.startedAt)?.toISOString() ?? startedAt.toISOString(),
      lastCheckedAt: now.toISOString(),
      ...(state === 'TIMEOUT' ? { stoppedAt: now.toISOString() } : {}),
    },
  }
}

function pollingStartedAt(
  channelData: JsonRecord,
  application: { createdAt: Date; updatedAt: Date },
): Date {
  const marker = asDate(asRecord(channelData.subMerchantPolling).startedAt)
  // submittedAt 是进件提交时间，可能早于审核通过数日，不能作为轮询超时起点。
  return marker ?? application.updatedAt ?? application.createdAt
}

/**
 * 成功入网后拉卡拉可能延迟返回渠道子商户号。该任务在 72 小时后停止轮询，保留
 * 明确状态供后台人工跟进。关闭入网开关时不读取数据库或调用外部接口。
 */
export async function refreshLakalaSubMerchants(db: Db): Promise<RefreshLakalaSubMerchantsResult> {
  const result: RefreshLakalaSubMerchantsResult = {
    eligible: 0,
    checked: 0,
    completed: 0,
    timedOut: 0,
    failed: 0,
    skippedDisabled: process.env.LAKALA_ONBOARDING_ENABLED !== 'true',
  }
  if (result.skippedDisabled) return result

  const applications = await db
    .select({
      id: lakalaOnboardingApplications.id,
      merCupNo: lakalaOnboardingApplications.merCupNo,
      channelData: lakalaOnboardingApplications.channelData,
      createdAt: lakalaOnboardingApplications.createdAt,
      updatedAt: lakalaOnboardingApplications.updatedAt,
    })
    .from(lakalaOnboardingApplications)
    .where(and(
      eq(lakalaOnboardingApplications.status, 'SUCCESS'),
      isNotNull(lakalaOnboardingApplications.merCupNo),
      // 必须在 LIMIT 前排除已完成/超时的终态轮询记录，避免历史数据占满候选窗口。
      sql`COALESCE(${lakalaOnboardingApplications.channelData}->'subMerchantPolling'->>'status', '') NOT IN ('DONE', 'TIMEOUT')`,
    ))
    .orderBy(
      sql`${lakalaOnboardingApplications.subMerchantCheckedAt} ASC NULLS FIRST`,
      asc(lakalaOnboardingApplications.id),
    )
    .limit(POLL_LIMIT)

  const now = new Date()
  for (const application of applications) {
    const channelData = asRecord(application.channelData)
    if (hasAllChannels(channelData)) continue
    if (!application.merCupNo) continue

    result.eligible += 1
    const startedAt = pollingStartedAt(channelData, application)
    if (now.getTime() - startedAt.getTime() > POLL_TIMEOUT_MS) {
      const timeoutData = pollState(channelData, 'TIMEOUT', now, startedAt)
      const update = await db
        .update(lakalaOnboardingApplications)
        .set({
          channelData: timeoutData,
          subMerchantCheckedAt: now,
          lastErrorCode: 'SUB_MERCHANT_POLL_TIMEOUT',
          lastErrorMessage: '微信或支付宝子商户号在 72 小时内未全部返回，请联系拉卡拉确认渠道报备结果',
          updatedAt: now,
        })
        .where(and(
          eq(lakalaOnboardingApplications.id, application.id),
          eq(lakalaOnboardingApplications.updatedAt, application.updatedAt),
        ))
      if (rowsAffected(update)) result.timedOut += 1
      continue
    }

    const requestId = `losp_${randomUUID()}`
    let apiResult: Awaited<ReturnType<typeof lakalaQueryChannelSubMerchants>>
    try {
      apiResult = await lakalaQueryChannelSubMerchants({ merchantNo: application.merCupNo })
    } catch {
      apiResult = {
        success: false,
        wechat: [],
        alipay: [],
        errorCode: 'REQUEST_FAILED',
        errorMessage: '子商户号查询请求失败',
        raw: {},
      }
    }
    result.checked += 1

    // 不持久化原始 request/response，保留可运维的脱敏摘要即可。
    await db.insert(lakalaOnboardingRequestLogs).values({
      id: `ol_${randomUUID()}`,
      applicationId: application.id,
      apiName: 'tkbs.open_merchant_submer',
      requestId,
      idempotencyKey: `submerchant-poll:${application.id}:${now.getTime()}`,
      requestPayloadMasked: { target: '[redacted]' },
      responsePayloadMasked: {
        success: apiResult.success,
        wechatCount: apiResult.wechat.length,
        alipayCount: apiResult.alipay.length,
        errorCode: apiResult.errorCode ?? null,
      },
      status: apiResult.success ? 'SUCCEEDED' : 'FAILED',
      errorCode: apiResult.errorCode ?? null,
      errorMessage: apiResult.success ? null : '拉卡拉子商户号查询未成功',
      completedAt: now,
    })

    const nextChannelData = pollState({
      ...channelData,
      ...(apiResult.success ? {
        wechat: apiResult.wechat,
        alipay: apiResult.alipay,
      } : {}),
    }, apiResult.success && apiResult.wechat.length > 0 && apiResult.alipay.length > 0 ? 'DONE' : 'WAITING', now, startedAt)
    const update = await db
      .update(lakalaOnboardingApplications)
      .set({
        channelData: nextChannelData,
        subMerchantCheckedAt: now,
        ...(apiResult.success
          ? { lastErrorCode: null, lastErrorMessage: null }
          : {
              lastErrorCode: apiResult.errorCode ?? 'SUB_MERCHANT_QUERY_FAILED',
              lastErrorMessage: '子商户号暂未返回或查询失败，将在下一轮自动重试',
            }),
        updatedAt: now,
      })
      .where(and(
        eq(lakalaOnboardingApplications.id, application.id),
        eq(lakalaOnboardingApplications.updatedAt, application.updatedAt),
      ))
    if (!rowsAffected(update)) continue
    if (apiResult.success && apiResult.wechat.length > 0 && apiResult.alipay.length > 0) result.completed += 1
    if (!apiResult.success) result.failed += 1
  }

  return result
}

