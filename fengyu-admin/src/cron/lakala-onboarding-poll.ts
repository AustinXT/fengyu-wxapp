/**
 * 拉卡拉商户入网回调兜底 cron（plan §7.1）
 *
 * 防御场景：
 *   拉卡拉端进件 / 实名报备状态推进后，本应通过回调通知 admin，但回调可能因
 *   网络抖动 / 中间代理丢包 / IP 白名单临时失效等原因丢失。本 cron 每 5 分钟扫描
 *   "等待回调"的 lakala_merchants，主动调拉卡拉查询接口推进状态，弥补回调缺口。
 *
 * 工作流：
 *   - 扫描 onboarding_status ∈ (submitted, callback_pending, appealing)
 *       → 调 client.queryMerchant 推进 contractStatus
 *   - 扫描 onboarding_status = realname_pending
 *       → 调 client.queryWxRealname + client.queryAlipayRealname 推进实名状态
 *
 * 与 03:00 跑的 cron-worker daily STEPS 不同：
 *   本 cron 节奏是 5 分钟（高频）。集成方式：在 cron/index.ts 加一个
 *   cron.schedule('*\/5 * * * *', ...) 节点（与 daily STEP 并行）；
 *   重新部署 admin 才生效（[monthly-activity-no-cron]）。
 *
 * 与回调路由 /api/lakala/callback/incoming 并发安全：
 *   每行处理前 SELECT FOR UPDATE 锁行；回调路由也锁同一行；
 *   状态推进统一走 nextState()，重复事件由 nextState 自身拒绝。
 *
 * **架构 TODO（Phase 2D 收口）**：
 *   queryMerchant 接口需要拉卡拉返回的 contractId（addMer §6 的 respData.contractId）。
 *   当前 lakala_merchants schema 未定义独立 contract_id 列；本 cron 从 last_req_ids
 *   或预留字段读取。Phase 2D 在实现 submitMerchant action 时，应把 addMer 返回的
 *   contractId 写入 last_req_ids['addMer']（或 Phase 2D 决定加新列）。
 *
 * 单 STEP 失败不阻塞其他 STEP（与 daily STEPS 同款 try/catch 隔离）。
 */

import { sql } from 'drizzle-orm'
import { db } from '@/db'
import * as lakalaClient from '@/lib/lakala-client'
import {
  nextState,
  TransitionError,
  type LakalaOnboardingStatus,
  type LakalaOnboardingEvent,
} from '@/lib/lakala-onboarding-state'
import { redact } from '@/lib/lakala-redact'

type Db = typeof db

interface PollResult {
  scannedMerchant: number
  scannedRealname: number
  advancedMerchant: number
  advancedRealname: number
  errors: number
}

/** tx.execute 鸭子接口（兼容 drizzle 的 PgTransaction） */
type SqlExecutor = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }

/**
 * 启动期读取 LAKALA_ORG_CODE（拉卡拉机构号），所有查询接口必传。
 * 未配置时本 cron 跳过所有查询（视为"接入未上线"），但不抛错。
 */
function getOrgCode(): string | null {
  return process.env.LAKALA_ORG_CODE || null
}

/**
 * 一次 poll 流程的总开关。--once 调试 / 测试链路单独调用此函数。
 */
export async function pollLakalaOnboarding(
  database: Db = db,
): Promise<PollResult> {
  const result: PollResult = {
    scannedMerchant: 0,
    scannedRealname: 0,
    advancedMerchant: 0,
    advancedRealname: 0,
    errors: 0,
  }

  const orgCode = getOrgCode()

  // —— 段 1：进件状态扫描 ——
  try {
    const merchantPending = (await database.execute(sql`
      SELECT id, out_org_code, onboarding_status, merchant_no, term_no, last_req_ids
        FROM lakala_merchants
       WHERE onboarding_status IN ('submitted', 'callback_pending', 'appealing')
       ORDER BY last_callback_at NULLS FIRST, updated_at ASC
       LIMIT 50
    `)) as Array<{
      id: string
      out_org_code: string
      onboarding_status: string
      merchant_no: string | null
      term_no: string | null
      last_req_ids: Record<string, unknown> | null
    }>

    result.scannedMerchant = merchantPending.length

    for (const row of merchantPending) {
      try {
        const advanced = await pollOneMerchant(database, row, orgCode)
        if (advanced) result.advancedMerchant++
      } catch (err) {
        result.errors++
        console.error('[lakala-onboarding-poll] queryMerchant failed:', row.id, err)
      }
    }
  } catch (err) {
    result.errors++
    console.error('[lakala-onboarding-poll] scan merchantPending failed:', err)
  }

  // —— 段 2：实名报备扫描 ——
  try {
    const realnamePending = (await database.execute(sql`
      SELECT id, out_org_code, merchant_no, wx_sub_mchid, alipay_sub_mchid,
             wx_realname_status, alipay_realname_status
        FROM lakala_merchants
       WHERE onboarding_status = 'realname_pending'
       ORDER BY last_callback_at NULLS FIRST, updated_at ASC
       LIMIT 50
    `)) as Array<{
      id: string
      out_org_code: string
      merchant_no: string | null
      wx_sub_mchid: string | null
      alipay_sub_mchid: string | null
      wx_realname_status: string
      alipay_realname_status: string
    }>

    result.scannedRealname = realnamePending.length

    for (const row of realnamePending) {
      try {
        const advanced = await pollOneRealname(database, row, orgCode)
        if (advanced) result.advancedRealname++
      } catch (err) {
        result.errors++
        console.error('[lakala-onboarding-poll] queryRealname failed:', row.id, err)
      }
    }
  } catch (err) {
    result.errors++
    console.error('[lakala-onboarding-poll] scan realnamePending failed:', err)
  }

  return result
}

/**
 * 推进一个进件商户：调拉卡拉 queryMerchant 拿最新 contractStatus → 推进状态。
 * 全程在事务内 SELECT FOR UPDATE 锁行，避免与 incoming 回调并发推进。
 */
async function pollOneMerchant(
  database: Db,
  row: {
    id: string
    out_org_code: string
    onboarding_status: string
    last_req_ids: Record<string, unknown> | null
  },
  orgCode: string | null,
): Promise<boolean> {
  // contractId 优先从 last_req_ids 读取（Phase 2D submitMerchant action 写入约定位置）。
  // 缺失则跳过查询，仅记日志（视为"流程尚未推进到 addMer 完成"）。
  const contractId = String(row.last_req_ids?.['addMerContractId'] ?? '')
  if (!orgCode || !contractId) {
    return false
  }

  // 调拉卡拉（在事务外，避免持锁等待外部 IO）
  const startedAt = Date.now()
  const resp = await lakalaClient.queryMerchant({
    orderNo: row.out_org_code,
    orgCode,
    contractId,
  })
  const latencyMs = Date.now() - startedAt

  // queryMerchant 返回 RequestResponse；resp_data 包含 contractStatus / merInnerNo / termDatas
  const respData = resp?.resp_data ?? {}
  const respCode = String(resp?.code ?? '')
  const contractStatus = String((respData as Record<string, unknown>).contractStatus ?? '')
  const merInnerNo = ((respData as Record<string, unknown>).merInnerNo as string | undefined) || null
  const termArr = (respData as Record<string, unknown>).termDatas
  const firstTermNo = Array.isArray(termArr) && termArr[0]
    ? ((termArr[0] as Record<string, unknown>).termNo as string | undefined) || null
    : null

  const event = mapMerchantStatusEvent(contractStatus)

  return await database.transaction(async (tx) => {
    const locked = (await tx.execute(sql`
      SELECT id, onboarding_status
        FROM lakala_merchants
       WHERE id = ${row.id}
       FOR UPDATE
    `)) as Array<{ id: string; onboarding_status: string }>
    if (locked.length === 0) return false

    const current = locked[0]
    // 先写日志（即使没事件可推进也保留 query 痕迹）
    await writeOutboundLog(tx, {
      lakalaMerchantId: row.id,
      endpoint: '/api/v2/mms/openApi/queryContract',
      reqBody: { orderNo: row.out_org_code, contractId },
      respBody: resp,
      respCode,
      latencyMs,
    })

    if (!event) {
      // 未知 contractStatus 或仍在 review_ing → 仅刷 last_query_at
      await tx.execute(sql`
        UPDATE lakala_merchants
           SET last_query_at = NOW(),
               updated_at = NOW()
         WHERE id = ${current.id}
      `)
      return false
    }

    let newStatus: LakalaOnboardingStatus
    try {
      newStatus = nextState(current.onboarding_status as LakalaOnboardingStatus, event)
    } catch (err) {
      // 真实 TransitionError 有 name='TransitionError'；测试 mock 用同名 Error 即可
      if (!(err instanceof TransitionError) && (err as Error)?.name !== 'TransitionError') {
        throw err
      }
      console.warn(
        '[lakala-onboarding-poll] state transition rejected:',
        current.onboarding_status,
        '+',
        event,
      )
      await tx.execute(sql`
        UPDATE lakala_merchants
           SET last_query_at = NOW(),
               updated_at = NOW()
         WHERE id = ${current.id}
      `)
      return false
    }

    await tx.execute(sql`
      UPDATE lakala_merchants
         SET onboarding_status = ${newStatus}::lakala_onboarding_status,
             merchant_no = COALESCE(${merInnerNo}, merchant_no),
             term_no    = COALESCE(${firstTermNo}, term_no),
             last_query_at = NOW(),
             updated_at = NOW()
       WHERE id = ${current.id}
    `)
    return true
  })
}

/**
 * 推进一个实名报备商户：分别调 queryWxRealname / queryAlipayRealname，
 * 任一通道完成都让 wx/alipay_realname_status 翻 success；
 * 双通道全 success 时主状态机 realname_pending → completed。
 */
async function pollOneRealname(
  database: Db,
  row: {
    id: string
    out_org_code: string
    merchant_no: string | null
    wx_sub_mchid: string | null
    alipay_sub_mchid: string | null
    wx_realname_status: string
    alipay_realname_status: string
  },
  orgCode: string | null,
): Promise<boolean> {
  if (!row.merchant_no || !orgCode) {
    // 还没拿到 merInnerNo / 未配 orgCode，跳过
    return false
  }
  // 把窄化结果固化到 const，避免闭包内 TS 类型回退
  const orgCodeStr: string = orgCode
  const merInnerNo: string = row.merchant_no

  interface RealnameQuery {
    channel: 'wx' | 'alipay'
    endpoint: string
    run: () => Promise<{ raw: Record<string, unknown>; respCode: string }>
  }
  const queries: RealnameQuery[] = []

  if (row.wx_realname_status !== 'success') {
    queries.push({
      channel: 'wx',
      endpoint: '/api/v2/mms/openApi/wechatRealNameQuery',
      run: async () => {
        const r = await lakalaClient.queryWxRealname({
          orderNo: row.out_org_code,
          orgCode: orgCodeStr,
          merInnerNo,
          subMchId: row.wx_sub_mchid || undefined,
        })
        return { raw: r.resp_data || {}, respCode: String(r.code ?? '') }
      },
    })
  }
  if (row.alipay_realname_status !== 'success') {
    // 支付宝实名查询必传 subMchId（endpoints §15 字段定义）；缺失时跳过此通道
    const alipaySub = row.alipay_sub_mchid
    if (alipaySub) {
      queries.push({
        channel: 'alipay',
        endpoint: '/api/v2/mms/openApi/alipayRealNameQuery',
        run: async () => {
          const r = await lakalaClient.queryAlipayRealname({
            orderNo: row.out_org_code,
            orgCode: orgCodeStr,
            merInnerNo,
            subMchId: alipaySub,
          })
          return { raw: r.resp_data || {}, respCode: String(r.code ?? '') }
        },
      })
    }
  }
  if (queries.length === 0) return false

  // 并发查询（互不依赖），但更新走串行事务以避免锁竞争
  const results = await Promise.allSettled(
    queries.map(async (q) => {
      const startedAt = Date.now()
      try {
        const data = await q.run()
        return { ...q, data, latencyMs: Date.now() - startedAt, error: null as Error | null }
      } catch (err) {
        return {
          ...q,
          data: null as { raw: Record<string, unknown>; respCode: string } | null,
          latencyMs: Date.now() - startedAt,
          error: err as Error,
        }
      }
    }),
  )

  return await database.transaction(async (tx) => {
    const locked = (await tx.execute(sql`
      SELECT id, onboarding_status, wx_realname_status, alipay_realname_status
        FROM lakala_merchants
       WHERE id = ${row.id}
       FOR UPDATE
    `)) as Array<{
      id: string
      onboarding_status: string
      wx_realname_status: string
      alipay_realname_status: string
    }>
    if (locked.length === 0) return false
    const current = locked[0]

    let wxStatus = current.wx_realname_status
    let alipayStatus = current.alipay_realname_status

    for (const r of results) {
      if (r.status !== 'fulfilled') continue
      const v = r.value
      await writeOutboundLog(tx, {
        lakalaMerchantId: row.id,
        endpoint: v.endpoint,
        reqBody: { orderNo: row.out_org_code, merInnerNo: row.merchant_no },
        respBody: v.error ? { error: v.error.message } : v.data,
        respCode: v.data?.respCode || null,
        latencyMs: v.latencyMs,
      })
      if (v.error || !v.data) continue
      const applymentState = String(v.data.raw.applymentState ?? '')
      const authorizeState = String(v.data.raw.authorizeState ?? '')
      const newRealname = mapRealnameStatus(applymentState, authorizeState)
      if (newRealname) {
        if (v.channel === 'wx') wxStatus = newRealname
        else alipayStatus = newRealname
      }
    }

    let newOnboarding: LakalaOnboardingStatus | null = null
    if (wxStatus === 'success' && alipayStatus === 'success') {
      try {
        newOnboarding = nextState(
          current.onboarding_status as LakalaOnboardingStatus,
          'realname_success',
        )
      } catch (err) {
        // 真实 TransitionError 有 name='TransitionError'；测试 mock 用同名 Error 即可
      if (!(err instanceof TransitionError) && (err as Error)?.name !== 'TransitionError') {
        throw err
      }
        // 主状态机已超期，仅推进子状态
        newOnboarding = null
      }
    }

    await tx.execute(sql`
      UPDATE lakala_merchants
         SET wx_realname_status = ${wxStatus}::lakala_realname_status,
             alipay_realname_status = ${alipayStatus}::lakala_realname_status,
             onboarding_status = COALESCE(${newOnboarding}::lakala_onboarding_status, onboarding_status),
             last_query_at = NOW(),
             updated_at = NOW()
       WHERE id = ${current.id}
    `)
    return wxStatus !== current.wx_realname_status
      || alipayStatus !== current.alipay_realname_status
      || newOnboarding !== null
  })
}

/**
 * 写 outbound 流水（poll 主动查询痕迹）。
 * jsonb 入库前必经 redact 脱敏（plan §0★ §1.3）。
 */
async function writeOutboundLog(
  tx: SqlExecutor,
  args: {
    lakalaMerchantId: string
    endpoint: string
    reqBody: unknown
    respBody: unknown
    respCode: string | null
    latencyMs: number
  },
): Promise<void> {
  const redactedReq = JSON.stringify(safeRedact(args.reqBody) ?? null)
  const redactedResp = JSON.stringify(safeRedact(args.respBody) ?? null)
  await tx.execute(sql`
    INSERT INTO lakala_merchant_logs
      (lakala_merchant_id, direction, endpoint, req_body, resp_body, resp_code, latency_ms, created_at)
    VALUES
      (${args.lakalaMerchantId}, 'outbound', ${args.endpoint},
       ${redactedReq}::jsonb, ${redactedResp}::jsonb,
       ${args.respCode}, ${args.latencyMs}, NOW())
  `)
}

function safeRedact(value: unknown): unknown {
  try {
    return redact(value)
  } catch {
    return { _redactFailed: true }
  }
}

/**
 * 拉卡拉 contractStatus → 主状态机事件映射（与 incoming 路由共享语义）。
 */
function mapMerchantStatusEvent(contractStatus: string): LakalaOnboardingEvent | null {
  switch (contractStatus) {
    case 'WAIT_FOR_CONTACT':
      return 'callback_approved'
    case 'INNER_CHECK_REJECTED':
      return 'callback_rejected'
    case 'MANUAL_AUDIT':
      return 'callback_manual'
    default:
      // REVIEW_ING / COMMIT / COMMIT_FAIL / NO_COMMIT：不推进
      return null
  }
}

/**
 * 拉卡拉 applymentState + authorizeState → 实名子状态（lakala_realname_status 枚举）。
 *   APPLYMENT_STATE_PASSED + AUTHORIZE_STATE_AUTHORIZED → success
 *   AUDIT_PASS + AUTHORIZED → success（支付宝口径）
 *   *_REJECTED / AUDIT_REJECT / APPLYMENT_STATE_FAIL → fail
 *   等待中各态 → submitted
 *   其他 → null（保持不变）
 */
function mapRealnameStatus(
  applymentState: string,
  authorizeState: string,
): string | null {
  if (
    applymentState === 'APPLYMENT_STATE_PASSED' &&
    authorizeState === 'AUTHORIZE_STATE_AUTHORIZED'
  ) {
    return 'success'
  }
  if (applymentState === 'AUDIT_PASS' && authorizeState === 'AUTHORIZED') {
    return 'success'
  }
  if (
    applymentState === 'APPLYMENT_STATE_REJECTED' ||
    applymentState === 'AUDIT_REJECT' ||
    applymentState === 'APPLYMENT_STATE_FAIL'
  ) {
    return 'fail'
  }
  if (
    applymentState === 'APPLYMENT_STATE_COMMIT' ||
    applymentState === 'APPLYMENT_STATE_WAITTING_FOR_AUDIT' ||
    applymentState === 'APPLYMENT_STATE_WAITTING_FOR_CONFIRM_CONTACT' ||
    applymentState === 'APPLYMENT_STATE_WAITTING_FOR_CONFIRM_LEGALPERSON' ||
    applymentState === 'AUDITING' ||
    applymentState === 'CONTACT_CONFIRM' ||
    applymentState === 'LEGAL_CONFIRM'
  ) {
    return 'submitted'
  }
  return null
}
