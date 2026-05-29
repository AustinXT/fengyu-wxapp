/**
 * 拉卡拉「进件回调通知」入口（plan §5 + endpoints §8）
 *
 * 协议：拉卡拉 → 凤御 admin，POST application/json。
 * 关键约束：
 *   1. runtime='nodejs' + dynamic='force-dynamic' — 验签依赖 node crypto；不能被 RSC 边缘化
 *   2. 用 request.text() 拿原始字节，禁止 request.json() —— SHA256withRSA 签名串
 *      是 `${timeStamp}\n${nonceStr}\n${body}\n`，rawBody 必须是原始字节，先 parse 再
 *      stringify 会丢失字段顺序导致验签失败（payNotify 踩过同样的坑）
 *   3. 签名验证复用 lakala-client.ts 的 verifyResponseSignature（Phase 1B export）
 *   4. IP 白名单：环境变量 LAKALA_CALLBACK_IP_WHITELIST，逗号分隔；
 *      NODE_ENV='production' 且白名单空 → 直接 401 拒入（fail-fast 避免被动安全失守）；
 *      非 prod 允许空（test 联调阶段）
 *   5. 处理前 SELECT FOR UPDATE 锁行，避免与 admin queryStatus 并发推进状态机
 *   6. 异常分级响应（plan §5.6）：
 *        签名错 / IP 拒入 → 401
 *        DB 不可达 / 基础设施异常 → 5xx（让拉卡拉按规则重试，避免数据丢失）
 *        业务异常（out_org_code 找不到 / 状态机非法转换）→ 200 + ACK + ERROR 日志
 *   7. ACK 报文采用拉卡拉「§8 进件回调通知」规定的字面量 `{code:'SUCCESS', message:'成功'}`
 *      （plan §5.6 文字"000000"是早稿口径，实际拉卡拉端要求 SUCCESS/FAIL；以官方契约为准）
 *
 * 参考实现：fengyu-client/cloudfunctions/payNotify/index.js L75-120
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
// Phase 1B 在 lakala-client.ts 上 export 了 verifyResponseSignature
import { verifyResponseSignature } from '@/lib/lakala-client'
import { nextState, type LakalaOnboardingStatus, type LakalaOnboardingEvent } from '@/lib/lakala-onboarding-state'
import { redact } from '@/lib/lakala-redact'

/**
 * 启动期解析 IP 白名单（一次性，避免每次回调重新解析 env）。
 * NODE_ENV=production 且白名单为空 → 标记 fatal，回调进入时统一 401。
 *
 * 注意：模块初始化期不直接 throw —— Next.js 路由模块在 build 期也会被加载，
 * docker build 阶段没有运行时 env 会让构建失败（参考 [admin-build-jwt-secret-placeholder]）。
 * 因此把 fail-fast 推迟到 handler 调用期。
 */
interface WhitelistConfig {
  /** 解析后的白名单（精确匹配） */
  ips: string[]
  /** prod 模式下白名单为空 → fatal=true，handler 直接拒入 */
  fatal: boolean
  /** 是否完全跳过 IP 检查（白名单含 '*'，仅 SIT 联调用） */
  open: boolean
}

const WHITELIST_CONFIG: WhitelistConfig = (() => {
  const raw = process.env.LAKALA_CALLBACK_IP_WHITELIST || ''
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const open = tokens.includes('*')
  const ips = tokens.filter((t) => t !== '*')
  const fatal = process.env.NODE_ENV === 'production' && tokens.length === 0
  return { ips, fatal, open }
})()

/**
 * 从请求头提取 client ip。优先级：x-forwarded-for 第一段 > x-real-ip > 兜底 ''。
 * Next.js 部署在反向代理（nginx / Vercel edge）后，req.ip 不可信，走 forwarded 头。
 */
function extractClientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for') || ''
  const real = req.headers.get('x-real-ip') || ''
  const first = xff.split(',')[0]?.trim() || real.trim()
  return first
}

/** 把 NextRequest.headers 摊平成 Record<string,string>，复用 verifyResponseSignature 签名 */
function flattenHeaders(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {}
  req.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v
  })
  return out
}

/**
 * 把任意 jsonb 入库前先 redact，避免 PII / 费率泄漏（plan §0★ §1.3）。
 * Phase 1A 写的 redact 接受任何 plain object，递归遮蔽敏感字段。
 */
function safeRedact(value: unknown): unknown {
  try {
    return redact(value)
  } catch {
    // redact 失败兜底为空对象，宁可少日志也不能让回调因日志写挂
    return { _redactFailed: true }
  }
}

/** tx.execute 的鸭子接口（兼容 drizzle Transaction.execute） */
type SqlExecutor = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }

/**
 * 写入回调流水（inbound_callback）。logs 表的 jsonb 必须先脱敏。
 * 必须在事务内调用（接受 tx 而非 db），与状态推进同事务避免半成品。
 */
async function writeInboundLog(
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
      (${args.lakalaMerchantId}, 'inbound_callback', ${args.endpoint},
       ${redactedReq}::jsonb, ${redactedResp}::jsonb,
       ${args.respCode}, ${args.latencyMs}, NOW())
  `)
}

/**
 * 业务异常 ACK：仍返回 200 + SUCCESS，但落 ERROR 日志（plan §5.6）。
 * 这避免拉卡拉无效重试风暴；同时通过 console.error + lakala_merchant_logs 保留告警痕迹。
 */
function ackSuccess(): NextResponse {
  return NextResponse.json({ code: 'SUCCESS', message: '成功' }, { status: 200 })
}

/**
 * 基础设施异常响应：返回 5xx 触发拉卡拉重试（plan §5.6）。
 * body 仍按拉卡拉 ACK 约定字段（code/message），让对端解析不报错。
 */
function infraFail(message: string): NextResponse {
  return NextResponse.json({ code: 'FAIL', message }, { status: 503 })
}

/**
 * 拉卡拉进件回调 contractStatus → 14 步主状态机事件映射（与 Phase 1A nextState 对齐）。
 *
 * 拉卡拉 contractStatus 枚举（endpoints §7 §8）：
 *   NO_COMMIT / COMMIT / COMMIT_FAIL / MANUAL_AUDIT / REVIEW_ING / WAIT_FOR_CONTACT
 *   / INNER_CHECK_REJECTED
 *
 * 不存在的事件 → 返回 null，handler 视为业务异常落 ERROR 日志。
 *
 * REVIEW_ING / COMMIT / COMMIT_FAIL / NO_COMMIT 都不推进主状态机（仍在 callback 等待中
 * 或属于失败态由 last_error_msg 单独记录）。
 */
function mapIncomingEvent(contractStatus: string): LakalaOnboardingEvent | null {
  switch (contractStatus) {
    case 'WAIT_FOR_CONTACT':
      return 'callback_approved'
    case 'INNER_CHECK_REJECTED':
      return 'callback_rejected'
    case 'MANUAL_AUDIT':
      return 'callback_manual'
    default:
      // REVIEW_ING / COMMIT / COMMIT_FAIL / NO_COMMIT 等：不推进
      return null
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now()

  // —— 1. IP 白名单（在签名之前，节省 CPU + 减少日志噪声）——
  if (WHITELIST_CONFIG.fatal) {
    // prod 模式下白名单为空 = 安全配置缺失，拒入但不暴露内部原因
    console.error('[lakala-callback/incoming] LAKALA_CALLBACK_IP_WHITELIST missing in production')
    return NextResponse.json({ code: 'FAIL', message: 'IP whitelist not configured' }, { status: 401 })
  }
  if (!WHITELIST_CONFIG.open) {
    const ip = extractClientIp(req)
    if (!ip || !WHITELIST_CONFIG.ips.includes(ip)) {
      console.warn('[lakala-callback/incoming] IP rejected:', ip)
      return NextResponse.json({ code: 'FAIL', message: 'IP not allowed' }, { status: 401 })
    }
  }

  // —— 2. 取原始 body（验签必须用原始字节）——
  let rawBody: string
  try {
    rawBody = await req.text()
  } catch (err) {
    console.error('[lakala-callback/incoming] read body failed:', err)
    return infraFail('body unreadable')
  }

  // —— 3. 验签（复用 lakala-client.verifyResponseSignature）——
  const headers = flattenHeaders(req)
  const platformCertPem = (process.env.LAKALA_PLATFORM_CERT_PEM || '').replace(/\\n/g, '\n')
  if (!platformCertPem) {
    console.error('[lakala-callback/incoming] LAKALA_PLATFORM_CERT_PEM missing')
    return infraFail('platform cert not configured')
  }
  let verified = false
  try {
    verified = verifyResponseSignature(headers, rawBody, platformCertPem)
  } catch (err) {
    console.error('[lakala-callback/incoming] verify error:', err)
    verified = false
  }
  if (!verified) {
    return NextResponse.json({ code: 'FAIL', message: 'signature mismatch' }, { status: 401 })
  }

  // —— 4. 解析 body（验签后才解析，避免被恶意 body 干扰）——
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch (err) {
    console.error('[lakala-callback/incoming] body not json:', err)
    // body 不合法 → 业务异常 200，避免无效重试（拉卡拉端 body 本就不该坏）
    return ackSuccess()
  }

  // 拉卡拉进件回调结构：data 包裹业务字段（endpoints §8 dataPacket.data）
  const dataNode = (payload.data && typeof payload.data === 'object'
    ? (payload.data as Record<string, unknown>)
    : payload) as Record<string, unknown>
  const outOrgCode = String((payload as Record<string, unknown>).orderNo ?? dataNode.orderNo ?? '')
  const contractStatus = String(dataNode.contractStatus ?? '')
  const merInnerNo = (dataNode.merInnerNo as string | undefined) || null
  const termDatas = Array.isArray(dataNode.termDatas)
    ? (dataNode.termDatas as Array<Record<string, unknown>>)
    : []
  const firstTermNo = termDatas[0]?.termNo as string | undefined

  if (!outOrgCode) {
    console.error('[lakala-callback/incoming] missing orderNo in payload')
    return ackSuccess()
  }

  // —— 5. 事务内 FOR UPDATE 锁行 + 推进状态机 + 写日志 ——
  try {
    await db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT id, onboarding_status
          FROM lakala_merchants
         WHERE out_org_code = ${outOrgCode}
         FOR UPDATE
      `)) as Array<{ id: string; onboarding_status: string }>

      if (rows.length === 0) {
        // 业务异常：out_org_code 找不到（plan §5.6）→ 200 + ERROR 日志
        console.error(
          '[lakala-callback/incoming] out_org_code not found:',
          outOrgCode,
        )
        // 没有 lakala_merchant_id，无法写 lakala_merchant_logs；console.error 已留痕
        return
      }

      const row = rows[0]
      const event = mapIncomingEvent(contractStatus)
      if (!event) {
        // 未知 contractStatus → 业务异常落 ERROR 日志
        console.error(
          '[lakala-callback/incoming] unknown contractStatus:',
          contractStatus,
          'merchantId=',
          row.id,
        )
        await writeInboundLog(tx, {
          lakalaMerchantId: row.id,
          endpoint: '/api/lakala/callback/incoming',
          reqBody: payload,
          respBody: { error: 'unknown_contract_status', contractStatus },
          respCode: null,
          latencyMs: Date.now() - startedAt,
        })
        return
      }

      let newStatus: string | null = null
      try {
        newStatus = nextState(row.onboarding_status as LakalaOnboardingStatus, event)
      } catch (err) {
        // 状态机非法转换 → 业务异常落 ERROR 日志
        console.error(
          '[lakala-callback/incoming] illegal state transition:',
          row.onboarding_status,
          '+',
          event,
          err,
        )
        await writeInboundLog(tx, {
          lakalaMerchantId: row.id,
          endpoint: '/api/lakala/callback/incoming',
          reqBody: payload,
          respBody: {
            error: 'illegal_state_transition',
            currentStatus: row.onboarding_status,
            event,
          },
          respCode: null,
          latencyMs: Date.now() - startedAt,
        })
        return
      }

      // 推进状态 + 回填核心交付物
      await tx.execute(sql`
        UPDATE lakala_merchants
           SET onboarding_status = ${newStatus}::lakala_onboarding_status,
               merchant_no = COALESCE(${merInnerNo}, merchant_no),
               term_no    = COALESCE(${firstTermNo ?? null}, term_no),
               last_callback_at = NOW(),
               updated_at = NOW()
         WHERE id = ${row.id}
      `)

      await writeInboundLog(tx, {
        lakalaMerchantId: row.id,
        endpoint: '/api/lakala/callback/incoming',
        reqBody: payload,
        respBody: { ok: true, newStatus, event },
        respCode: String((payload as Record<string, unknown>).code ?? '') || null,
        latencyMs: Date.now() - startedAt,
      })
    })
  } catch (err) {
    // 基础设施异常（DB 不可达 / 事务失败）→ 5xx 让拉卡拉重试
    console.error('[lakala-callback/incoming] tx failed:', err)
    return infraFail('infrastructure error')
  }

  return ackSuccess()
}
