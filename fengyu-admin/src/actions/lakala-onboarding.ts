'use server'

/**
 * 拉卡拉商户入网 · Server Actions（Phase 2D）
 *
 * 实现 plan §3 表中 20+ action：列表/详情/草稿/合同/附件/进件/查询/复议/实名/
 * 信息变更/门店关联/取消/删除。
 *
 * 关键约束（来自 plan §0★ + §3 + §9）：
 *   1. **费率全 admin 不可见**：
 *      - submitMerchant / updateLakalaMerchantInfo 的 Zod 入参 schema 绝不含费率字段；
 *      - feeData 仅通过 server 内部 `loadRateConfig()` 注入；
 *      - action 返回值经 `redact()` 兜底后再交给前端（兜底任何意外字段）；
 *      - 测试守护"返回 jsonb 中不含 feeRate / rateCode 等"。
 *   2. **reqId 幂等**：每个外发请求先读 `lakala_merchants.last_req_ids[endpoint]`，
 *      存在则透传到 client 的 `reqIdHint`；成功后清除该 endpoint 条目；失败保留。
 *      避免网络中断重试在拉卡拉端产生两笔进件。
 *   3. **状态机集中**：所有 onboardingStatus 写入都走 `nextState(current, event)` → INSERT/UPDATE；
 *      不裸写 `status='...'`。非法转换抛 INVALID_STATE 友好错误。
 *   4. **stores 4 列分流**：
 *      - merchant_no / sub_appid → 由 lakala_merchant_id 派生的快照（admin UI 不再手填）
 *      - term_no / enabled → store 级独立编辑（linkStore 不动；unlink 强置 enabled=false）
 *      - updateLakalaMerchantInfo 末尾联动刷所有绑该商户的 stores 快照。
 *   5. **审计日志**：所有写 action 都调 `logOperation` 或 `logUpdate` / `logTransition`。
 *   6. **乐观锁**：saveDraft 等编辑入口接受 `expectedUpdatedAt`，date_trunc('milliseconds') 对齐。
 *
 * 与 Phase 2E 的边界：
 *   - 本文件只产出 server action export；不写 page.tsx / 组件 / menu.ts / permissions.ts。
 *   - Phase 2E 添加 `lakala:onboarding:*` 6 项权限到 permission matrix，本文件直接用即可。
 */

import * as crypto from 'node:crypto'
import { db } from '@/db'
import {
  lakalaMerchants,
  lakalaMerchantAttachments,
  lakalaMerchantLogs,
  type LakalaMerchant,
} from '@db/lakala'
import { stores } from '@db/org'
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { withPermission } from '@/lib/with-permission'
import { logOperation, logUpdate, logTransition } from '@/lib/operation-log'
import { redact } from '@/lib/lakala-redact'
import { loadRateConfig } from '@/lib/lakala-rate'
import {
  nextState,
  isTerminalStatus,
  TransitionError,
  type LakalaOnboardingEvent,
  type LakalaOnboardingStatus,
} from '@/lib/lakala-onboarding-state'
import * as lakalaClient from '@/lib/lakala-client'
import { reuploadToFixedPath, deleteByCloudPaths } from '@/lib/cloudbase'
import type { AuthSession } from '@/lib/types'

// ===========================================================================
// 公共常量与辅助
// ===========================================================================

/**
 * 拉卡拉 orgCode（机构号）— 来源 env `LAKALA_ORG_CODE`，测试环境=1，prod 由对接客户经理给。
 * 入网相关接口的 orgCode 入参均取自此 env，无需用户在 UI 输入。
 */
function getOrgCode(): string {
  return process.env.LAKALA_ORG_CODE || '1'
}

/**
 * 进件回调 URL（用于 submitMerchant 的 retUrl 字段）— 来源 env。
 */
function getIncomingNotifyUrl(): string {
  return process.env.LAKALA_INCOMING_NOTIFY_URL || ''
}

/**
 * 生成 KSUID 风格 ID：`{prefix}{8 位时间戳}{12 位随机}`，36 字符以内。
 * 用于 lakala_merchants.id (lm_) / outOrgCode (lm-) / attachments.id (lma_).
 */
function ksuid(prefix: string): string {
  const ts = Math.floor(Date.now() / 1000).toString(36).padStart(8, '0')
  const rand = crypto.randomBytes(6).toString('hex') // 12 hex chars
  return `${prefix}${ts}${rand}`
}

/**
 * 友好错误：用于 server action throw 给 RSC error boundary。
 * digest 字段确保 next 生产构建脱敏后仍能让 error.tsx 区分类别。
 */
class OnboardingError extends Error {
  readonly digest: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'OnboardingError'
    this.digest = code
  }
}

function throwInvalidParams(msg: string): never {
  throw new OnboardingError(`INVALID_PARAMS: ${msg}`, 'INVALID_PARAMS')
}

function throwInvalidState(msg: string): never {
  throw new OnboardingError(`INVALID_STATE: ${msg}`, 'INVALID_STATE')
}

function throwNotFound(msg: string): never {
  throw new OnboardingError(`NOT_FOUND: ${msg}`, 'NOT_FOUND')
}

function throwConflict(msg: string): never {
  throw new OnboardingError(`CONFLICT: ${msg}`, 'CONFLICT')
}

/**
 * 调用 client 方法的封装：
 *   - 自动从 last_req_ids[endpoint] 取 reqId 复用（幂等）
 *   - 调用前后写 `lakala_merchant_logs`（请求/响应 jsonb 经 redact() 脱敏）
 *   - 成功（resp.ok）则清除 last_req_ids[endpoint]；失败保留供下次重试
 *
 * 输入 endpointKey 是 last_req_ids 的 jsonb 键（建议用方法名，如 'applyContract'）。
 * 输入 payload 是 client 方法所需的 input（已经包含 reqIdHint 之外的全部字段）。
 *
 * 返回 client 方法的原始返回（v3: { code, msg, resp_data, ok, ... } / v2 同名结构）。
 */
async function callLakala<R extends { ok: boolean; code: string; msg: string; resp_data: Record<string, unknown>; reqId?: string }>(
  merchantId: string,
  endpointKey: string,
  endpointPath: string,
  session: AuthSession,
  callImpl: (reqIdHint?: string) => Promise<R>,
  /** 用于 logs 的 reqBody（原始入参；redact 由本函数统一兜底） */
  reqBody: Record<string, unknown>,
): Promise<R> {
  // 1. 取 reqId hint
  const [row] = await db
    .select({ lastReqIds: lakalaMerchants.lastReqIds })
    .from(lakalaMerchants)
    .where(eq(lakalaMerchants.id, merchantId))
    .limit(1)
  const reqIds = (row?.lastReqIds as Record<string, string> | null) || {}
  const reqIdHint = reqIds[endpointKey]

  // 2. 调用 client
  const t0 = Date.now()
  let resp: R
  let raisedError: Error | null = null
  try {
    resp = await callImpl(reqIdHint)
  } catch (err) {
    raisedError = err instanceof Error ? err : new Error(String(err))
    // 写失败日志（resp_body=null，resp_code=null）
    await db.insert(lakalaMerchantLogs).values({
      lakalaMerchantId: merchantId,
      direction: 'outbound',
      endpoint: endpointPath,
      reqBody: redact(reqBody) as Record<string, unknown>,
      respBody: { error: raisedError.message } as Record<string, unknown>,
      respCode: null,
      latencyMs: Date.now() - t0,
      operatorUserId: typeof session.employeeId === 'string' && /^\d+$/.test(session.employeeId)
        ? Number(session.employeeId)
        : null,
    })
    throw raisedError
  }
  const latencyMs = Date.now() - t0

  // 3. 写成功/拉卡拉错误日志
  await db.insert(lakalaMerchantLogs).values({
    lakalaMerchantId: merchantId,
    direction: 'outbound',
    endpoint: endpointPath,
    reqBody: redact(reqBody) as Record<string, unknown>,
    respBody: redact({
      code: resp.code,
      msg: resp.msg,
      resp_data: resp.resp_data,
    }) as Record<string, unknown>,
    respCode: resp.code || null,
    latencyMs,
    operatorUserId: typeof session.employeeId === 'string' && /^\d+$/.test(session.employeeId)
      ? Number(session.employeeId)
      : null,
  })

  // 4. 维护 last_req_ids（成功清；失败保留新 reqId）
  if (resp.ok) {
    if (reqIds[endpointKey]) {
      delete reqIds[endpointKey]
      await db.update(lakalaMerchants)
        .set({ lastReqIds: reqIds })
        .where(eq(lakalaMerchants.id, merchantId))
    }
  } else {
    // v2 envelope 才有 reqId；v3 不会触发此分支
    if (resp.reqId && resp.reqId !== reqIdHint) {
      reqIds[endpointKey] = resp.reqId
      await db.update(lakalaMerchants)
        .set({ lastReqIds: reqIds })
        .where(eq(lakalaMerchants.id, merchantId))
    }
  }

  return resp
}

/**
 * 推进状态机 + 落事务级 logTransition。
 *
 * 调用方在 transaction 外捕获 TransitionError 翻译成友好提示。
 */
async function transitionStatus(
  session: AuthSession,
  merchantId: string,
  current: LakalaOnboardingStatus,
  event: LakalaOnboardingEvent,
  context?: Record<string, unknown>,
): Promise<LakalaOnboardingStatus> {
  const target = nextState(current, event)
  await db.update(lakalaMerchants)
    .set({ onboardingStatus: target })
    .where(eq(lakalaMerchants.id, merchantId))
  await logTransition(session, 'lakala_merchant.transition', 'lakala_merchant', merchantId, current, target, context)
  return target
}

/** 把 LakalaMerchant 行经过 redact 之后导出（费率字段 + PII 兜底脱敏）。 */
function serializeMerchant(m: LakalaMerchant): Record<string, unknown> {
  // formData / lastSubmittedFormData / lastReqIds 都可能藏 PII；redact 递归兜底。
  // 关键：feeData / feeRate 等只要在 jsonb 内出现就 mask 成 '***'，保证返回值绝不漏费率。
  const safe = redact({
    ...m,
    createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
    updatedAt: m.updatedAt instanceof Date ? m.updatedAt.toISOString() : m.updatedAt,
    lastCallbackAt: m.lastCallbackAt instanceof Date ? m.lastCallbackAt.toISOString() : m.lastCallbackAt,
    lastQueryAt: m.lastQueryAt instanceof Date ? m.lastQueryAt.toISOString() : m.lastQueryAt,
  }) as Record<string, unknown>
  return safe
}

// ===========================================================================
// 1. 列表 / 详情 (read)
// ===========================================================================

export interface MerchantListItem {
  id: string
  merchantName: string
  outOrgCode: string
  onboardingStatus: LakalaOnboardingStatus
  contractStatus: string
  merchantNo: string | null
  applicantUserId: number | null
  /** 已绑定本商户的门店数量（N:1，stores.lakala_merchant_id COUNT） */
  linkedStoreCount: number
  createdAt: string
  updatedAt: string
}

export const listLakalaMerchants = withPermission(
  'lakala:onboarding:read',
  async (
    _session,
    filter?: { status?: LakalaOnboardingStatus | 'all'; keyword?: string; applicantUserId?: number },
  ): Promise<MerchantListItem[]> => {
    const conds = []
    if (filter?.status && filter.status !== 'all') conds.push(eq(lakalaMerchants.onboardingStatus, filter.status))
    if (filter?.keyword) {
      const kw = `%${filter.keyword}%`
      conds.push(or(ilike(lakalaMerchants.merchantName, kw), ilike(lakalaMerchants.merchantNo, kw)))
    }
    if (filter?.applicantUserId) conds.push(eq(lakalaMerchants.applicantUserId, filter.applicantUserId))

    const rows = await db
      .select({
        id: lakalaMerchants.id,
        merchantName: lakalaMerchants.merchantName,
        outOrgCode: lakalaMerchants.outOrgCode,
        onboardingStatus: lakalaMerchants.onboardingStatus,
        contractStatus: lakalaMerchants.contractStatus,
        merchantNo: lakalaMerchants.merchantNo,
        applicantUserId: lakalaMerchants.applicantUserId,
        createdAt: lakalaMerchants.createdAt,
        updatedAt: lakalaMerchants.updatedAt,
        linkedStoreCount: sql<number>`(
          SELECT COUNT(*)::int FROM stores WHERE stores.lakala_merchant_id = ${lakalaMerchants.id}
        )`,
      })
      .from(lakalaMerchants)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(lakalaMerchants.updatedAt), desc(lakalaMerchants.createdAt))
      .limit(200)

    return rows.map((r) => ({
      id: r.id,
      merchantName: r.merchantName,
      outOrgCode: r.outOrgCode,
      onboardingStatus: r.onboardingStatus as LakalaOnboardingStatus,
      contractStatus: r.contractStatus,
      merchantNo: r.merchantNo,
      applicantUserId: r.applicantUserId,
      linkedStoreCount: Number(r.linkedStoreCount) || 0,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
    }))
  },
)

export interface MerchantDetail {
  merchant: Record<string, unknown>
  attachments: Array<Record<string, unknown>>
  recentLogs: Array<Record<string, unknown>>
  linkedStores: Array<{ storeId: string; storeName: string }>
}

export const getLakalaMerchant = withPermission(
  'lakala:onboarding:read',
  async (_session, merchantId: string): Promise<MerchantDetail> => {
    const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
    if (!m) throwNotFound('商户不存在')

    const atts = await db
      .select()
      .from(lakalaMerchantAttachments)
      .where(eq(lakalaMerchantAttachments.lakalaMerchantId, merchantId))
      .orderBy(asc(lakalaMerchantAttachments.attachmentType), asc(lakalaMerchantAttachments.createdAt))

    const logs = await db
      .select()
      .from(lakalaMerchantLogs)
      .where(eq(lakalaMerchantLogs.lakalaMerchantId, merchantId))
      .orderBy(desc(lakalaMerchantLogs.createdAt))
      .limit(30)

    const linked = await db
      .select({ storeId: stores.storeId, storeName: stores.storeName })
      .from(stores)
      .where(eq(stores.lakalaMerchantId, merchantId))

    return {
      merchant: serializeMerchant(m as LakalaMerchant),
      attachments: atts.map((a) => ({
        ...a,
        createdAt: a.createdAt instanceof Date ? a.createdAt.toISOString() : a.createdAt,
        updatedAt: a.updatedAt instanceof Date ? a.updatedAt.toISOString() : a.updatedAt,
        uploadedToLakalaAt: a.uploadedToLakalaAt instanceof Date
          ? a.uploadedToLakalaAt.toISOString()
          : a.uploadedToLakalaAt,
      })),
      // 日志已在 INSERT 期间 redact 过；这里再过一遍 redact 兜底（防止历史日志在 redact 字段集扩展前入库）。
      recentLogs: logs.map((l) => ({
        ...redact(l) as Record<string, unknown>,
        createdAt: l.createdAt instanceof Date ? l.createdAt.toISOString() : l.createdAt,
      })),
      linkedStores: linked,
    }
  },
)

// ===========================================================================
// 2. 草稿管理 (create / update)
// ===========================================================================

export const createDraft = withPermission(
  'lakala:onboarding:create',
  async (
    session,
    data: { merchantName: string; formData?: Record<string, unknown> },
  ): Promise<{ success: true; id: string }> => {
    if (!data.merchantName?.trim()) throwInvalidParams('merchantName 必填')

    const id = ksuid('lm_')
    const outOrgCode = ksuid('lm-')
    const applicantUserId = typeof session.employeeId === 'string' && /^\d+$/.test(session.employeeId)
      ? Number(session.employeeId)
      : null

    await db.insert(lakalaMerchants).values({
      id,
      outOrgCode,
      merchantName: data.merchantName.trim(),
      applicantUserId,
      formData: data.formData ?? {},
      // 状态机字段全走默认值（draft / draft / not_submitted / not_submitted / {}）。
    })

    await logOperation(session, 'lakala_merchant.create', 'lakala_merchant', id, {
      merchantName: data.merchantName,
      outOrgCode,
    })
    revalidatePath('/lakala-onboarding')
    return { success: true, id }
  },
)

export const saveDraft = withPermission(
  'lakala:onboarding:update',
  async (
    session,
    merchantId: string,
    data: { merchantName?: string; formData?: Record<string, unknown> },
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    const [before] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
    if (!before) return { success: false, message: '商户不存在' }
    if (before.onboardingStatus !== 'draft') {
      return { success: false, message: `仅 draft 状态可编辑表单（当前 ${before.onboardingStatus}）` }
    }

    const whereCond = expectedUpdatedAt
      ? and(
          eq(lakalaMerchants.id, merchantId),
          sql`date_trunc('milliseconds', ${lakalaMerchants.updatedAt}) = ${expectedUpdatedAt}`,
        )
      : eq(lakalaMerchants.id, merchantId)

    const r: any = await db.update(lakalaMerchants)
      .set({
        ...(data.merchantName !== undefined ? { merchantName: data.merchantName } : {}),
        ...(data.formData !== undefined ? { formData: data.formData } : {}),
      })
      .where(whereCond)
    if ((r.count ?? r.rowCount ?? 0) === 0) {
      return {
        success: false,
        message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '商户不存在',
      }
    }
    await logUpdate(session, 'lakala_merchant.saveDraft', 'lakala_merchant', merchantId, before as any, data as any)
    revalidatePath(`/lakala-onboarding/${merchantId}`)
    return { success: true, message: '已保存' }
  },
)

// ===========================================================================
// 3. 电子合同
// ===========================================================================

export const applyContract = withPermission(
  'lakala:onboarding:update',
  async (
    session,
    merchantId: string,
    input: Omit<lakalaClient.ApplyContractInput, 'reqIdHint'>,
  ): Promise<{ success: boolean; contractStatus?: string; ecApplyId?: string; message?: string }> => {
    const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
    if (!m) throwNotFound('商户不存在')

    try {
      const resp = await callLakala(
        merchantId,
        'applyContract',
        '/api/v3/mms/open_api/ec/apply',
        session,
        (hint) => lakalaClient.applyContract({ ...input, reqIdHint: hint }),
        input as unknown as Record<string, unknown>,
      )

      if (!resp.ok) {
        // 失败回退到 draft
        try {
          await transitionStatus(session, merchantId, m.onboardingStatus as LakalaOnboardingStatus, 'contract_apply_fail', {
            errCode: resp.code,
            errMsg: resp.msg,
          })
        } catch {
          // current 不在 contract_signing 时 contract_apply_fail 非法，保持原状即可
        }
        await db.update(lakalaMerchants)
          .set({ lastErrorCode: resp.code, lastErrorMsg: resp.msg })
          .where(eq(lakalaMerchants.id, merchantId))
        return { success: false, message: `拉卡拉返回 ${resp.code} ${resp.msg}` }
      }

      // 成功：状态 → contract_signing；记 ecApplyId 到 form_data 备用
      const ecApplyId = String(resp.resp_data?.ec_apply_id ?? '')
      await transitionStatus(session, merchantId, m.onboardingStatus as LakalaOnboardingStatus, 'apply_contract', {
        ecApplyId,
      })
      // 把 ecApplyId 写到 form_data.contract.ecApplyId 供后续 query/download 使用
      const newFormData = {
        ...((m.formData as Record<string, unknown>) || {}),
        contract: {
          ...(((m.formData as Record<string, unknown>)?.contract as Record<string, unknown>) || {}),
          ecApplyId,
          orderNo: input.orderNo,
        },
      }
      await db.update(lakalaMerchants)
        .set({ formData: newFormData, contractStatus: 'applied' })
        .where(eq(lakalaMerchants.id, merchantId))

      revalidatePath(`/lakala-onboarding/${merchantId}`)
      return { success: true, contractStatus: 'applied', ecApplyId }
    } catch (err) {
      if (err instanceof TransitionError) {
        throwInvalidState(`状态不允许申请合同：${err.message}`)
      }
      throw err
    }
  },
)

export const refreshContractStatus = withPermission(
  'lakala:onboarding:update',
  async (
    session,
    merchantId: string,
  ): Promise<{ success: boolean; ecStatus?: string; contractStatus?: string; message?: string }> => {
    const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
    if (!m) throwNotFound('商户不存在')

    const contractCtx = ((m.formData as Record<string, unknown>)?.contract as Record<string, unknown>) || {}
    const ecApplyId = contractCtx.ecApplyId as string | undefined
    const orderNo = (contractCtx.orderNo as string) || m.outOrgCode
    if (!ecApplyId) return { success: false, message: '未找到 ecApplyId（先 applyContract）' }

    const resp = await callLakala(
      merchantId,
      'queryContract',
      '/api/v3/mms/open_api/ec/q_status',
      session,
      (hint) => lakalaClient.queryContract({
        orderNo,
        orgCode: getOrgCode(),
        ecApplyId,
        reqIdHint: hint,
      }),
      { orderNo, ecApplyId } as Record<string, unknown>,
    )
    if (!resp.ok) return { success: false, message: `拉卡拉 ${resp.code} ${resp.msg}` }

    const ecStatus = String(resp.resp_data?.ec_status ?? '')
    const ecNo = resp.resp_data?.ec_no ? String(resp.resp_data.ec_no) : null

    if (ecStatus === 'COMPLETED') {
      try {
        await transitionStatus(
          session,
          merchantId,
          m.onboardingStatus as LakalaOnboardingStatus,
          'contract_signed_callback',
          { ecNo },
        )
      } catch (e) {
        if (!(e instanceof TransitionError)) throw e
        // 已经在 contract_signed 之后则不重复推进，但仍要写 contractNo
      }
      await db.update(lakalaMerchants)
        .set({ contractStatus: 'signed', contractNo: ecNo })
        .where(eq(lakalaMerchants.id, merchantId))
    }
    revalidatePath(`/lakala-onboarding/${merchantId}`)
    return { success: true, ecStatus, contractStatus: ecStatus === 'COMPLETED' ? 'signed' : 'applied' }
  },
)

// ===========================================================================
// 4. 附件
// ===========================================================================

export const uploadAttachment = withPermission(
  'lakala:onboarding:update',
  async (
    session,
    merchantId: string,
    data: {
      attachmentType: string
      sourceUrl: string // admin /api/upload 返回的临时 URL
      attExtName: string // jpg/png/pdf
      attContext: string // base64 内容（spring Base64Utils.encodeToString，非 URL Safe）
      metadata?: Record<string, unknown>
    },
  ): Promise<{ success: true; attachmentId: string; attchId: string | null }> => {
    const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
    if (!m) throwNotFound('商户不存在')

    // 1. 重传到固定 cloudPath
    const seq = Date.now()
    const cloudPath = `lakala/${merchantId}/${data.attachmentType}-${seq}.${data.attExtName}`
    await reuploadToFixedPath(data.sourceUrl, cloudPath)

    // 2. 先建 attachment 行（attchId=null，本地可见）
    const attachmentId = ksuid('lma_')
    await db.insert(lakalaMerchantAttachments).values({
      id: attachmentId,
      lakalaMerchantId: merchantId,
      attachmentType: data.attachmentType as any,
      localUrl: data.sourceUrl,
      cloudPath,
      metadata: data.metadata ?? null,
    })

    // 3. 调拉卡拉 uploadFile
    const resp = await callLakala(
      merchantId,
      'uploadAttachment',
      '/api/v2/mms/openApi/uploadFile',
      session,
      (hint) => lakalaClient.uploadAttachment({
        orderNo: m.outOrgCode,
        orgCode: getOrgCode(),
        attType: data.attachmentType,
        attExtName: data.attExtName,
        // attContext 不写入日志（base64 太大）；由 redact 兜底
        attContext: data.attContext,
        reqIdHint: hint,
      }),
      {
        attType: data.attachmentType,
        attExtName: data.attExtName,
        // 显式不带 attContext，避免 base64 入 logs
      },
    )

    if (!resp.ok) {
      // 拉卡拉端失败：保留本地记录（attchId 仍为 null），UI 提示重试
      throwInvalidState(`拉卡拉附件上传失败：${resp.code} ${resp.msg}`)
    }

    const attchId = (resp.resp_data?.attFileId as string | undefined) ?? null
    await db.update(lakalaMerchantAttachments)
      .set({ attchId, uploadedToLakalaAt: new Date() })
      .where(eq(lakalaMerchantAttachments.id, attachmentId))

    // 推进 contract_signed → attachments_uploading（仅第一次上传时切）
    if (m.onboardingStatus === 'contract_signed') {
      try {
        await transitionStatus(session, merchantId, m.onboardingStatus, 'start_attachments')
      } catch (e) {
        if (!(e instanceof TransitionError)) throw e
      }
    }

    await logOperation(session, 'lakala_attachment.upload', 'lakala_merchant', merchantId, {
      attachmentId,
      attachmentType: data.attachmentType,
      attchId,
    })
    revalidatePath(`/lakala-onboarding/${merchantId}/attachments`)
    return { success: true, attachmentId, attchId }
  },
)

export const deleteAttachment = withPermission(
  'lakala:onboarding:update',
  async (
    session,
    merchantId: string,
    attachmentId: string,
  ): Promise<{ success: true }> => {
    const [att] = await db
      .select()
      .from(lakalaMerchantAttachments)
      .where(and(
        eq(lakalaMerchantAttachments.id, attachmentId),
        eq(lakalaMerchantAttachments.lakalaMerchantId, merchantId),
      ))
      .limit(1)
    if (!att) throwNotFound('附件不存在')

    await db.delete(lakalaMerchantAttachments).where(eq(lakalaMerchantAttachments.id, attachmentId))
    try {
      await deleteByCloudPaths([att.cloudPath])
    } catch (e) {
      // 清不掉 CDN 文件不阻塞业务
      console.warn('[lakala-onboarding] deleteByCloudPaths failed:', (e as Error).message)
    }
    await logOperation(session, 'lakala_attachment.delete', 'lakala_merchant', merchantId, { attachmentId })
    revalidatePath(`/lakala-onboarding/${merchantId}/attachments`)
    return { success: true }
  },
)

// ===========================================================================
// 5. 进件 (submit)
// ===========================================================================

/**
 * **关键守护点**（plan §0★）：
 *   - 入参类型 `SubmitMerchantInput` 来自 lakala-client，**不含 feeData**；
 *   - 本 action 内部 `loadRateConfig()` 读 PG，注入到 client 调用 payload；
 *   - 返回值经 redact() 兜底（即便 client 响应里漏字段也会被 mask）。
 */
export const submitMerchant = withPermission(
  'lakala:onboarding:submit',
  async (
    session,
    merchantId: string,
    input: Omit<lakalaClient.SubmitMerchantInput, 'reqIdHint' | 'orderNo' | 'orgCode' | 'retUrl'>,
  ): Promise<{ success: boolean; contractId?: string; message?: string }> => {
    const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
    if (!m) throwNotFound('商户不存在')
    if (m.contractStatus !== 'signed') {
      return { success: false, message: '电子合同未签署完成，无法提交进件' }
    }

    // 必备附件就位检查（fileData 由本端 attchId 构造，缺失即提示）
    const atts = await db.select().from(lakalaMerchantAttachments)
      .where(eq(lakalaMerchantAttachments.lakalaMerchantId, merchantId))
    const fileData = atts
      .filter((a) => a.attchId)
      .map((a) => ({ attFileId: a.attchId!, attType: a.attachmentType }))
    if (fileData.length === 0) return { success: false, message: '至少需要上传 1 个附件且确认已传到拉卡拉' }

    // **server-only 注入费率**（plan §0★）
    const rate = await loadRateConfig()

    const payload = {
      ...input,
      orderNo: m.outOrgCode,
      orgCode: getOrgCode(),
      retUrl: getIncomingNotifyUrl(),
      fileData,
      contractNo: m.contractNo ?? undefined,
    } as lakalaClient.SubmitMerchantInput

    // 注入 feeData：通过 `as any` 透传到 client 内部 wire spread（client 不暴露在签名上）
    const withFee = Object.assign({}, payload, { feeData: rate.entries })

    try {
      const resp = await callLakala(
        merchantId,
        'submitMerchant',
        '/api/v2/mms/openApi/addMer',
        session,
        // hint 透传；fee 注入对 reqId 无影响
        (hint) => lakalaClient.submitMerchant({ ...withFee, reqIdHint: hint } as lakalaClient.SubmitMerchantInput),
        // logs 中 reqBody 不含 feeData 的明文（redact 会 mask 它，但显式不传也更安全）。
        { ...payload, fileData },
      )

      // 持久化 last_submitted_form_data 快照（不含费率）+ 推进状态
      await db.update(lakalaMerchants)
        .set({
          lastSubmittedFormData: { ...input, fileData } as Record<string, unknown>,
        })
        .where(eq(lakalaMerchants.id, merchantId))

      if (!resp.ok) {
        return { success: false, message: `拉卡拉返回 ${resp.code} ${resp.msg}` }
      }

      // 把 contractId 写到 last_req_ids.addMerContractId（Phase 1C cron 兜底从这里读）
      const contractId = (resp.resp_data?.contractId as string | undefined) ?? null
      if (contractId) {
        const fresh = await db.select({ lastReqIds: lakalaMerchants.lastReqIds })
          .from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
        const map = ((fresh[0]?.lastReqIds as Record<string, string>) || {})
        map.addMerContractId = contractId
        await db.update(lakalaMerchants).set({ lastReqIds: map }).where(eq(lakalaMerchants.id, merchantId))
      }

      await transitionStatus(session, merchantId, m.onboardingStatus as LakalaOnboardingStatus, 'submit_merchant', { contractId })
      revalidatePath(`/lakala-onboarding/${merchantId}`)
      return { success: true, contractId: contractId ?? undefined }
    } catch (err) {
      if (err instanceof TransitionError) {
        throwInvalidState(`状态不允许提交进件：${err.message}`)
      }
      throw err
    }
  },
)

export const queryStatus = withPermission(
  'lakala:onboarding:update',
  async (
    session,
    merchantId: string,
  ): Promise<{ success: boolean; status?: string; message?: string }> => {
    const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
    if (!m) throwNotFound('商户不存在')
    const contractId = ((m.lastReqIds as Record<string, string>) || {}).addMerContractId
    if (!contractId) return { success: false, message: '尚无进件 contractId（请先 submitMerchant）' }

    const resp = await callLakala(
      merchantId,
      'queryMerchant',
      '/api/v2/mms/openApi/queryContract',
      session,
      (hint) => lakalaClient.queryMerchant({
        orderNo: m.outOrgCode,
        orgCode: getOrgCode(),
        contractId,
        reqIdHint: hint,
      }),
      { orderNo: m.outOrgCode, contractId },
    )

    await db.update(lakalaMerchants).set({ lastQueryAt: new Date() }).where(eq(lakalaMerchants.id, merchantId))

    if (!resp.ok) return { success: false, message: `拉卡拉 ${resp.code} ${resp.msg}` }

    // 推进状态机（接口契约里典型字段 contractStatus / merInnerNo / merCupNo / termDatas[].termNo）
    const lakalaStatus = String(resp.resp_data?.contractStatus ?? resp.resp_data?.contract_status ?? '')
    const merInnerNo = (resp.resp_data?.merInnerNo as string | undefined) ?? null
    const merCupNo = (resp.resp_data?.merCupNo as string | undefined) ?? null
    const termDatas = (resp.resp_data?.termDatas as Array<{ termNo?: string }> | undefined) ?? []
    const termNo = termDatas[0]?.termNo ?? null

    const event: LakalaOnboardingEvent | null =
      lakalaStatus === 'WAIT_FOR_CONTACT' || lakalaStatus === 'PASS' ? 'callback_approved'
      : lakalaStatus === 'INNER_CHECK_REJECTED' || lakalaStatus === 'REJECTED' ? 'callback_rejected'
      : lakalaStatus === 'MANUAL_AUDIT' ? 'callback_manual'
      : null

    if (event) {
      try {
        await transitionStatus(session, merchantId, m.onboardingStatus as LakalaOnboardingStatus, event, { lakalaStatus })
      } catch (e) {
        if (!(e instanceof TransitionError)) throw e
      }
    }

    // 通过：回填 merchant_no / term_no
    if (event === 'callback_approved' && (merCupNo || merInnerNo)) {
      await db.update(lakalaMerchants).set({
        merchantNo: merCupNo ?? merInnerNo,
        termNo,
      }).where(eq(lakalaMerchants.id, merchantId))
    }

    revalidatePath(`/lakala-onboarding/${merchantId}`)
    return { success: true, status: lakalaStatus }
  },
)

export const submitAppeal = withPermission(
  'lakala:onboarding:submit',
  async (
    session,
    merchantId: string,
  ): Promise<{ success: boolean; message?: string }> => {
    const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
    if (!m) throwNotFound('商户不存在')
    if (m.onboardingStatus !== 'rejected' && m.onboardingStatus !== 'under_review') {
      return { success: false, message: '仅 rejected / under_review 可复议' }
    }
    const contractId = ((m.lastReqIds as Record<string, string>) || {}).addMerContractId
    if (!contractId) return { success: false, message: '缺 contractId，无法复议' }

    const resp = await callLakala(
      merchantId,
      'submitAppeal',
      '/api/v2/mms/openApi/reconsiderSubmit',
      session,
      (hint) => lakalaClient.submitAppeal({
        orderNo: m.outOrgCode,
        orgCode: getOrgCode(),
        contractId,
        reqIdHint: hint,
      }),
      { orderNo: m.outOrgCode, contractId },
    )

    if (!resp.ok) return { success: false, message: `拉卡拉 ${resp.code} ${resp.msg}` }

    await transitionStatus(session, merchantId, m.onboardingStatus as LakalaOnboardingStatus, 'submit_appeal')
    revalidatePath(`/lakala-onboarding/${merchantId}`)
    return { success: true }
  },
)

// ===========================================================================
// 6. 实名报备
// ===========================================================================

async function ensureRealnamePending(session: AuthSession, m: LakalaMerchant) {
  if (m.onboardingStatus !== 'realname_pending') {
    try {
      await transitionStatus(session, m.id, m.onboardingStatus as LakalaOnboardingStatus, 'start_realname')
    } catch (e) {
      if (!(e instanceof TransitionError)) throw e
      // 不在 approved 时直接拒绝
      throwInvalidState(`仅 approved 可进入实名报备（当前 ${m.onboardingStatus}）`)
    }
  }
}

export const submitWxRealname = withPermission(
  'lakala:onboarding:realname',
  async (
    session,
    merchantId: string,
    data: { receOrgNo: string; subMchId: string; channelId: string },
  ): Promise<{ success: boolean; qrcodeUrl?: string | null; message?: string }> => {
    const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
    if (!m) throwNotFound('商户不存在')
    if (!m.merchantNo) return { success: false, message: '未拿到 merchantNo，无法发起实名' }
    await ensureRealnamePending(session, m as LakalaMerchant)

    const resp = await callLakala(
      merchantId,
      'submitWxRealname',
      '/api/v2/mms/openApi/wechatRealName/modifyCommit',
      session,
      (hint) => lakalaClient.submitWxRealname({
        orderNo: m.outOrgCode,
        orgCode: getOrgCode(),
        merInnerNo: m.merchantNo!,
        receOrgNo: data.receOrgNo,
        subMchId: data.subMchId,
        channelId: data.channelId,
        reqIdHint: hint,
      }),
      { orderNo: m.outOrgCode, merInnerNo: m.merchantNo, ...data },
    )
    if (!resp.ok) return { success: false, message: `拉卡拉 ${resp.code} ${resp.msg}` }

    const qrcodeUrl = (resp.resp_data?.qrcodeData as string | undefined) ?? null
    await db.update(lakalaMerchants).set({
      wxRealnameStatus: 'submitted',
      wxRealnameQrcodeUrl: qrcodeUrl,
      wxSubMchid: data.subMchId,
      wxSubAppid: data.channelId,
    }).where(eq(lakalaMerchants.id, merchantId))
    await logOperation(session, 'lakala_merchant.submitWxRealname', 'lakala_merchant', merchantId, {
      subMchId: data.subMchId,
    })

    // 同步 stores 快照
    await syncStoreSnapshots(merchantId)

    revalidatePath(`/lakala-onboarding/${merchantId}/realname`)
    return { success: true, qrcodeUrl }
  },
)

export const modifyWxRealname = withPermission(
  'lakala:onboarding:realname',
  async (
    session,
    merchantId: string,
    data: { receOrgNo: string; subMchId: string; channelId: string; applymentId: string },
  ): Promise<{ success: boolean; message?: string }> => {
    const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
    if (!m) throwNotFound('商户不存在')
    if (!m.merchantNo) return { success: false, message: '未拿到 merchantNo' }
    const resp = await callLakala(
      merchantId,
      'modifyWxRealname',
      '/api/v2/mms/openApi/wechatRealName/modifyCommit',
      session,
      (hint) => lakalaClient.modifyWxRealname({
        orderNo: m.outOrgCode,
        orgCode: getOrgCode(),
        merInnerNo: m.merchantNo!,
        ...data,
        reqIdHint: hint,
      }),
      { orderNo: m.outOrgCode, merInnerNo: m.merchantNo, ...data },
    )
    if (!resp.ok) return { success: false, message: `拉卡拉 ${resp.code} ${resp.msg}` }
    await db.update(lakalaMerchants).set({ wxRealnameStatus: 'modifying' }).where(eq(lakalaMerchants.id, merchantId))
    await logOperation(session, 'lakala_merchant.modifyWxRealname', 'lakala_merchant', merchantId, { ...data })
    revalidatePath(`/lakala-onboarding/${merchantId}/realname`)
    return { success: true }
  },
)

export const submitAlipayRealname = withPermission(
  'lakala:onboarding:realname',
  async (
    session,
    merchantId: string,
    data: { receOrgNo: string; subMchId: string; channelId: string },
  ): Promise<{ success: boolean; qrcodeUrl?: string | null; message?: string }> => {
    const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
    if (!m) throwNotFound('商户不存在')
    if (!m.merchantNo) return { success: false, message: '未拿到 merchantNo' }
    await ensureRealnamePending(session, m as LakalaMerchant)

    const resp = await callLakala(
      merchantId,
      'submitAlipayRealname',
      '/api/v2/mms/openApi/alipayRealName/modifyCommit',
      session,
      (hint) => lakalaClient.submitAlipayRealname({
        orderNo: m.outOrgCode,
        orgCode: getOrgCode(),
        merInnerNo: m.merchantNo!,
        receOrgNo: data.receOrgNo,
        subMchId: data.subMchId,
        channelId: data.channelId,
        reqIdHint: hint,
      }),
      { orderNo: m.outOrgCode, merInnerNo: m.merchantNo, ...data },
    )
    if (!resp.ok) return { success: false, message: `拉卡拉 ${resp.code} ${resp.msg}` }
    const qrcodeUrl = (resp.resp_data?.qrcodeData as string | undefined) ?? null
    await db.update(lakalaMerchants).set({
      alipayRealnameStatus: 'submitted',
      alipayRealnameQrcodeUrl: qrcodeUrl,
      alipaySubMchid: data.subMchId,
    }).where(eq(lakalaMerchants.id, merchantId))
    await logOperation(session, 'lakala_merchant.submitAlipayRealname', 'lakala_merchant', merchantId, {
      subMchId: data.subMchId,
    })
    revalidatePath(`/lakala-onboarding/${merchantId}/realname`)
    return { success: true, qrcodeUrl }
  },
)

export const modifyAlipayRealname = withPermission(
  'lakala:onboarding:realname',
  async (
    session,
    merchantId: string,
    data: { receOrgNo: string; subMchId: string; channelId: string; applymentId: string },
  ): Promise<{ success: boolean; message?: string }> => {
    const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
    if (!m) throwNotFound('商户不存在')
    if (!m.merchantNo) return { success: false, message: '未拿到 merchantNo' }
    const resp = await callLakala(
      merchantId,
      'modifyAlipayRealname',
      '/api/v2/mms/openApi/alipayRealName/modifyCommit',
      session,
      (hint) => lakalaClient.modifyAlipayRealname({
        orderNo: m.outOrgCode,
        orgCode: getOrgCode(),
        merInnerNo: m.merchantNo!,
        ...data,
        reqIdHint: hint,
      }),
      { orderNo: m.outOrgCode, merInnerNo: m.merchantNo, ...data },
    )
    if (!resp.ok) return { success: false, message: `拉卡拉 ${resp.code} ${resp.msg}` }
    await db.update(lakalaMerchants).set({ alipayRealnameStatus: 'modifying' }).where(eq(lakalaMerchants.id, merchantId))
    await logOperation(session, 'lakala_merchant.modifyAlipayRealname', 'lakala_merchant', merchantId, { ...data })
    revalidatePath(`/lakala-onboarding/${merchantId}/realname`)
    return { success: true }
  },
)

// ===========================================================================
// 7. 商户信息变更
// ===========================================================================

export const updateLakalaMerchantInfo = withPermission(
  'lakala:onboarding:update',
  async (
    session,
    merchantId: string,
    input: Omit<lakalaClient.UpdateLakalaMerchantInfoInput, 'reqIdHint' | 'orderNo' | 'orgCode' | 'merInnerNo' | 'merCupNo' | 'retUrl'>,
  ): Promise<{ success: boolean; message?: string }> => {
    const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
    if (!m) throwNotFound('商户不存在')
    if (m.onboardingStatus !== 'approved' && m.onboardingStatus !== 'completed' && m.onboardingStatus !== 'realname_pending') {
      return { success: false, message: '仅 approved/completed/realname_pending 状态可变更商户信息' }
    }
    if (!m.merchantNo) return { success: false, message: '未拿到 merchantNo，无法变更' }

    const rate = await loadRateConfig() // server-only 注入费率
    const payload: lakalaClient.UpdateLakalaMerchantInfoInput = {
      ...input,
      orderNo: m.outOrgCode,
      orgCode: getOrgCode(),
      merInnerNo: m.merchantNo,
      merCupNo: m.merchantNo, // 二选一，与 staff/client 端 resolveLakalaMerchant 保持兼容
      retUrl: getIncomingNotifyUrl(),
    }
    const withFee = Object.assign({}, payload, { feeData: rate.entries })

    const resp = await callLakala(
      merchantId,
      'updateLakalaMerchantInfo',
      '/api/v2/mms/openApi/changeMer',
      session,
      (hint) => lakalaClient.updateLakalaMerchantInfo({ ...withFee, reqIdHint: hint } as lakalaClient.UpdateLakalaMerchantInfoInput),
      payload as unknown as Record<string, unknown>,
    )
    if (!resp.ok) return { success: false, message: `拉卡拉 ${resp.code} ${resp.msg}` }

    // 持久化非费率字段到 form_data.lastChange（供 UI 显示历史变更）+ 日志
    await db.update(lakalaMerchants)
      .set({
        formData: {
          ...((m.formData as Record<string, unknown>) || {}),
          lastChange: input as Record<string, unknown>,
        },
      })
      .where(eq(lakalaMerchants.id, merchantId))

    await logOperation(session, 'lakala_merchant.updateInfo', 'lakala_merchant', merchantId, {
      // 不含 feeData
      changedFields: Object.keys(input),
    })

    // 联动刷店：N:1 绑该商户的所有 stores 同步快照 2 列
    await syncStoreSnapshots(merchantId)

    revalidatePath(`/lakala-onboarding/${merchantId}`)
    return { success: true }
  },
)

// ===========================================================================
// 8. 门店 ↔ 商户 关联
// ===========================================================================

/**
 * 把 lakala_merchants.merchant_no 同步到所有绑该商户的 stores 行。
 * - admin UI 不再手填 stores 上 merchantNo，由本函数派生；
 * - term_no / enabled 是 store 级独立字段，本函数不动；
 * - sub_appid 走 env LAKALA_SUB_APPID 全局共享，不入表；
 * - 在 linkStoreToMerchant / updateLakalaMerchantInfo 等位置调用。
 */
async function syncStoreSnapshots(merchantId: string): Promise<void> {
  const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
  if (!m) return
  await db.update(stores)
    .set({
      lakalaMerchantNo: m.merchantNo,
    })
    .where(eq(stores.lakalaMerchantId, merchantId))
}

export const linkStoreToMerchant = withPermission(
  'lakala:onboarding:update',
  async (
    session,
    data: { storeId: string; lakalaMerchantId: string },
  ): Promise<{ success: boolean; message?: string }> => {
    const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, data.lakalaMerchantId)).limit(1)
    if (!m) return { success: false, message: '商户不存在' }
    if (m.onboardingStatus !== 'approved' && m.onboardingStatus !== 'completed') {
      return { success: false, message: '仅 approved/completed 商户可被门店关联' }
    }

    const [s] = await db.select().from(stores).where(eq(stores.storeId, data.storeId)).limit(1)
    if (!s) return { success: false, message: '门店不存在' }

    // 事务：覆盖 lakala_merchant_id + 刷快照 merchantNo；不动 term_no / enabled
    await db.transaction(async (tx) => {
      await tx.update(stores).set({
        lakalaMerchantId: data.lakalaMerchantId,
        lakalaMerchantNo: m.merchantNo,
      }).where(eq(stores.storeId, data.storeId))
    })

    await logOperation(session, 'store.linkLakalaMerchant', 'store', data.storeId, {
      lakalaMerchantId: data.lakalaMerchantId,
      merchantNo: m.merchantNo,
    })
    revalidatePath('/stores')
    revalidatePath(`/lakala-onboarding/${data.lakalaMerchantId}`)
    return { success: true }
  },
)

export const unlinkStoreFromMerchant = withPermission(
  'lakala:onboarding:update',
  async (
    session,
    data: { storeId: string },
  ): Promise<{ success: boolean; message?: string }> => {
    const [s] = await db.select().from(stores).where(eq(stores.storeId, data.storeId)).limit(1)
    if (!s) return { success: false, message: '门店不存在' }
    const oldMid = s.lakalaMerchantId

    await db.transaction(async (tx) => {
      // SET NULL + 清快照 merchantNo + 强置 enabled=false（plan §3 deltable）
      await tx.update(stores).set({
        lakalaMerchantId: null,
        lakalaMerchantNo: null,
        lakalaEnabled: false,
      }).where(eq(stores.storeId, data.storeId))
    })

    await logOperation(session, 'store.unlinkLakalaMerchant', 'store', data.storeId, {
      previousMerchantId: oldMid,
    })
    revalidatePath('/stores')
    if (oldMid) revalidatePath(`/lakala-onboarding/${oldMid}`)
    return { success: true }
  },
)

// ===========================================================================
// 8.5 反查开户状态（legacy 行也能跑）
// ===========================================================================

/**
 * 调拉卡拉 queryWxConfig (`/api/v2/mms/sme/mrchAuthStateQuery`) 反查微信 + 支付宝开户状态，
 * 回写 lakala_merchants.wx_realname_status / alipay_realname_status。
 *
 * 适用场景：
 *   - legacy 行（applicant_user_id=NULL，out_org_code 是占位符）无 contractId，但仍能调本接口
 *     因为 queryWxConfig 只要 merchantNo + subMerchantId + tradeMode，不依赖进件上下文。
 *   - 上线前确认 3 个商户的开户状态，避免因未实名导致支付失败。
 *
 * subMerchantId 取自 form_data.merInnerNo（手抄商户后台 "内部商户号"），fallback merchantNo。
 *
 * **状态字段映射注意**（IP 白名单通后实测确认）：
 *   拉卡拉响应字段名 + 取值需要 SIT/prod 反查实测，本函数当前用宽容多键匹配：
 *     resp_data.authStatus / status / openStatus 中任一非空即取
 *   映射到 lakala_realname_status 枚举（5 值）：
 *     AUTHED / SUCCESS / OPEN → 'success'
 *     FAIL / REJECTED / CLOSED → 'fail'
 *     PENDING / MODIFYING → 'modifying'
 *     SUBMITTED → 'submitted'
 *     其他/未识别 → 不动 DB（保守）
 *   TODO(IP 白名单通后)：跑 sit-lakala-query-3-merchants.mjs 实测响应字段，回来修映射表。
 */
export const refreshMerchantStatusFromLakala = withPermission(
  'lakala:onboarding:update',
  async (
    session,
    merchantId: string,
  ): Promise<{
    success: boolean
    message?: string
    wx?: { code: string; msg: string; raw?: string | null; mapped?: string }
    alipay?: { code: string; msg: string; raw?: string | null; mapped?: string }
  }> => {
    const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
    if (!m) return { success: false, message: '商户不存在' }
    if (!m.merchantNo) return { success: false, message: 'merchant_no 缺失，无法反查' }

    // subMerchantId 取 form_data.merInnerNo（手抄回填），fallback merchantNo
    const formData = (m.formData as Record<string, unknown> | null) || {}
    const subId = (typeof formData.merInnerNo === 'string' && formData.merInnerNo)
                  || m.merchantNo

    const updates: Partial<typeof lakalaMerchants.$inferInsert> = {}

    async function queryOne(tradeMode: 'WECHAT' | 'ALIPAY') {
      const resp = await callLakala(
        merchantId,
        tradeMode === 'WECHAT' ? 'queryWxConfig' : 'queryAlipayConfig',
        '/api/v2/mms/sme/mrchAuthStateQuery',
        session,
        (hint) => lakalaClient.queryWxConfig({
          tradeMode,
          merchantNo: m.merchantNo!,
          subMerchantId: subId,
          reqIdHint: hint,
        }),
        { tradeMode, merchantNo: m.merchantNo, subMerchantId: subId },
      )
      const raw = resp.ok
        ? String(
            (resp.resp_data?.authStatus as string | undefined)
            ?? (resp.resp_data?.status as string | undefined)
            ?? (resp.resp_data?.openStatus as string | undefined)
            ?? '',
          ) || null
        : null
      const mapped: typeof lakalaRealnameStatusEnumValues[number] | undefined =
        raw === 'AUTHED' || raw === 'SUCCESS' || raw === 'OPEN' ? 'success' :
        raw === 'FAIL' || raw === 'REJECTED' || raw === 'CLOSED' ? 'fail' :
        raw === 'PENDING' || raw === 'MODIFYING' ? 'modifying' :
        raw === 'SUBMITTED' ? 'submitted' :
        undefined
      return { code: resp.code, msg: resp.msg, raw, mapped }
    }

    const wx = await queryOne('WECHAT')
    if (wx.mapped) updates.wxRealnameStatus = wx.mapped

    const alipay = await queryOne('ALIPAY')
    if (alipay.mapped) updates.alipayRealnameStatus = alipay.mapped

    if (Object.keys(updates).length > 0) {
      Object.assign(updates, { lastQueryAt: new Date() })
      await db.update(lakalaMerchants).set(updates).where(eq(lakalaMerchants.id, merchantId))
    }

    await logOperation(session, 'lakala_merchant.refreshStatus', 'lakala_merchant', merchantId, {
      wxCode: wx.code, wxRaw: wx.raw, wxMapped: wx.mapped,
      alipayCode: alipay.code, alipayRaw: alipay.raw, alipayMapped: alipay.mapped,
    })
    revalidatePath(`/lakala-onboarding/${merchantId}`)
    return { success: true, wx, alipay }
  },
)

// 字面量枚举校验数组（与 db/schema/enums.ts 的 lakalaRealnameStatusEnum 严格同步）
const lakalaRealnameStatusEnumValues = ['not_submitted', 'submitted', 'success', 'fail', 'modifying'] as const

// ===========================================================================
// 9. 取消 / 删除
// ===========================================================================

export const cancelOnboarding = withPermission(
  'lakala:onboarding:delete',
  async (
    session,
    merchantId: string,
  ): Promise<{ success: boolean; message?: string }> => {
    const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
    if (!m) return { success: false, message: '商户不存在' }
    if (m.onboardingStatus === 'cancelled') return { success: false, message: '已是取消态' }

    try {
      const next = nextState(m.onboardingStatus as LakalaOnboardingStatus, 'cancel')
      // 批处理解绑所有 stores（同 unlink 逻辑）
      const linked = await db.select({ storeId: stores.storeId })
        .from(stores).where(eq(stores.lakalaMerchantId, merchantId))
      await db.transaction(async (tx) => {
        await tx.update(stores).set({
          lakalaMerchantId: null,
          lakalaMerchantNo: null,
          lakalaEnabled: false,
        }).where(eq(stores.lakalaMerchantId, merchantId))
        await tx.update(lakalaMerchants).set({ onboardingStatus: next })
          .where(eq(lakalaMerchants.id, merchantId))
      })

      await logTransition(session, 'lakala_merchant.cancel', 'lakala_merchant', merchantId,
        m.onboardingStatus as string, next, {
          alert: 'AUTO_UNLINKED_STORES',
          unlinkedStoreIds: linked.map((x) => x.storeId),
        })
      revalidatePath('/lakala-onboarding')
      revalidatePath('/stores')
      return { success: true }
    } catch (err) {
      if (err instanceof TransitionError) throwInvalidState(err.message)
      throw err
    }
  },
)

export const deleteLakalaMerchant = withPermission(
  'lakala:onboarding:delete',
  async (
    session,
    merchantId: string,
  ): Promise<{ success: boolean; message?: string }> => {
    const [m] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId)).limit(1)
    if (!m) return { success: false, message: '商户不存在' }
    if (m.onboardingStatus !== 'cancelled') return { success: false, message: '仅 cancelled 可硬删' }
    if (m.applicantUserId === null) return { success: false, message: 'legacy 迁入行不可硬删' }

    // FK ON DELETE CASCADE：lakala_merchant_attachments / logs 自动清；stores.lakala_merchant_id 由 schema SET NULL
    await db.delete(lakalaMerchants).where(eq(lakalaMerchants.id, merchantId))
    await logOperation(session, 'lakala_merchant.delete', 'lakala_merchant', merchantId, { merchantName: m.merchantName })
    revalidatePath('/lakala-onboarding')
    return { success: true }
  },
)

// ===========================================================================
// 10. 内部导出（供 stores.ts updateStore 调用）
// ===========================================================================

/**
 * 把 link/unlink 业务核心封装为内部 helper，供 actions/stores.ts updateStore 调用：
 *   - admin 在 /stores/[id]/edit 页改"关联商户"下拉时，updateStore 收到 lakalaMerchantId 字段，
 *     若与原值不同则调本函数；
 *   - 与 server action 区别：不再单独写 operation_log（updateStore 已有自己的 logUpdate），
 *     但仍执行事务级快照同步 / enabled 强置规则。
 *
 * 仅供 server-side import；不通过 withPermission 包装（调用方 updateStore 已经 require store:update）。
 */
export async function _internalApplyLakalaLink(
  tx: any,
  storeId: string,
  lakalaMerchantId: string | null,
): Promise<void> {
  if (lakalaMerchantId === null) {
    await tx.update(stores).set({
      lakalaMerchantId: null,
      lakalaMerchantNo: null,
      lakalaEnabled: false,
    }).where(eq(stores.storeId, storeId))
    return
  }
  const [m] = await tx.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, lakalaMerchantId)).limit(1)
  if (!m) throwNotFound('商户不存在')
  if (m.onboardingStatus !== 'approved' && m.onboardingStatus !== 'completed') {
    throwInvalidState('仅 approved/completed 商户可被门店关联')
  }
  await tx.update(stores).set({
    lakalaMerchantId,
    lakalaMerchantNo: m.merchantNo,
  }).where(eq(stores.storeId, storeId))
}

// 静音 unused 报警（保留导入供后续 finalize / cron 使用）
// `'use server'` 文件不允许导出非 async 函数；用 void 引用而非 export 让 lint/tsc 通过。
void isTerminalStatus
void throwConflict
