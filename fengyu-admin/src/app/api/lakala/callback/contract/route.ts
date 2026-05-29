/**
 * 拉卡拉「电子合同人工复核异步通知」回调入口（plan §5 + endpoints §2）
 *
 * 协议：拉卡拉 → 凤御 admin，POST application/json。
 * 通知报文字段（endpoints §2 异步签约结果通知）：
 *   version / orgId / orderNo / ecApplyId / ecNo / ecName /
 *   ecStatus（UNDONE 未完成 / COMPLETED 已完成）
 *
 * 与 /api/lakala/callback/incoming 共用：
 *   - runtime='nodejs' + dynamic='force-dynamic'
 *   - request.text() 拿原始字节（验签依赖原始 body）
 *   - 复用 verifyResponseSignature（Phase 1B export）
 *   - IP 白名单（启动期解析，prod 缺失 fail-fast）
 *   - 异常分级响应（签名错/IP 拒入 401 / 基础设施 5xx / 业务异常 200）
 *   - SELECT FOR UPDATE 锁行 + nextState 推进 contract_status 子状态机
 *
 * 与 incoming 的差异：
 *   - 推进 lakala_merchants.contract_status（合同子状态机）而非 onboarding_status
 *   - COMPLETED → contractNo 回填
 *   - UNDONE → 仅更新 last_callback_at，不推进状态
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
// Phase 1B 在 lakala-client.ts 上 export 了 verifyResponseSignature
import { verifyResponseSignature } from '@/lib/lakala-client'
import {
  nextState,
  TransitionError,
  type LakalaOnboardingStatus,
} from '@/lib/lakala-onboarding-state'
import { redact } from '@/lib/lakala-redact'

/**
 * contract_status 子状态机（plan §1.5）。
 *   draft → applied → pending_manual_review → signed
 *                  ↓ failed
 *                  ↓ cancelled
 *
 * 与 onboarding_status 主状态机解耦：主状态机由 Phase 1A 的 nextState() 集中管理；
 * contract_status 此处独立处理（只有 3 个有意义事件）。
 */
type LakalaContractStatus =
  | 'draft'
  | 'applied'
  | 'pending_manual_review'
  | 'signed'
  | 'failed'
  | 'cancelled'

const CONTRACT_TRANSITIONS: Readonly<Record<LakalaContractStatus, Partial<Record<'sign' | 'manual_review' | 'fail', LakalaContractStatus>>>> = {
  draft: { sign: 'signed', manual_review: 'pending_manual_review', fail: 'failed' },
  applied: { sign: 'signed', manual_review: 'pending_manual_review', fail: 'failed' },
  pending_manual_review: { sign: 'signed', fail: 'failed' },
  signed: {},
  failed: {},
  cancelled: {},
}

function nextContractStatus(
  current: LakalaContractStatus,
  event: 'sign' | 'manual_review' | 'fail',
): LakalaContractStatus {
  const target = CONTRACT_TRANSITIONS[current]?.[event]
  if (!target) {
    throw new Error(`Illegal contract_status transition: ${current} + ${event}`)
  }
  return target
}

interface WhitelistConfig {
  ips: string[]
  fatal: boolean
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

function extractClientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for') || ''
  const real = req.headers.get('x-real-ip') || ''
  return xff.split(',')[0]?.trim() || real.trim()
}

function flattenHeaders(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {}
  req.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v
  })
  return out
}

function safeRedact(value: unknown): unknown {
  try {
    return redact(value)
  } catch {
    return { _redactFailed: true }
  }
}

/** tx.execute 的鸭子接口（兼容 drizzle Transaction.execute） */
type SqlExecutor = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }

async function writeInboundLog(
  tx: SqlExecutor,
  args: {
    lakalaMerchantId: string
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
      (${args.lakalaMerchantId}, 'inbound_callback', '/api/lakala/callback/contract',
       ${redactedReq}::jsonb, ${redactedResp}::jsonb,
       ${args.respCode}, ${args.latencyMs}, NOW())
  `)
}

function ackSuccess(): NextResponse {
  return NextResponse.json({ code: 'SUCCESS', message: '成功' }, { status: 200 })
}

function infraFail(message: string): NextResponse {
  return NextResponse.json({ code: 'FAIL', message }, { status: 503 })
}

/**
 * 拉卡拉电子合同回调 ecStatus → contract_status 子状态机事件映射。
 *
 * COMPLETED → 'sign'  （applied/pending_manual_review → signed）
 * UNDONE / 其他 → null（不推进，仅更新 last_callback_at）
 */
function mapContractEvent(ecStatus: string): 'sign' | 'manual_review' | 'fail' | null {
  if (ecStatus === 'COMPLETED') return 'sign'
  return null
}

/**
 * 通过 orderNo 反查 lakala_merchants（FOR UPDATE 在事务内调用）：
 *   合同 orderNo = applyContract 请求时传的"四方机构自定义订单号"。
 *   建议 applyContract 把 outOrgCode 作为 orderNo 前缀，复用 out_org_code 索引匹配；
 *   兜底：orderNo 直接等于 out_org_code 也匹配。
 */

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now()

  if (WHITELIST_CONFIG.fatal) {
    console.error('[lakala-callback/contract] LAKALA_CALLBACK_IP_WHITELIST missing in production')
    return NextResponse.json({ code: 'FAIL', message: 'IP whitelist not configured' }, { status: 401 })
  }
  if (!WHITELIST_CONFIG.open) {
    const ip = extractClientIp(req)
    if (!ip || !WHITELIST_CONFIG.ips.includes(ip)) {
      console.warn('[lakala-callback/contract] IP rejected:', ip)
      return NextResponse.json({ code: 'FAIL', message: 'IP not allowed' }, { status: 401 })
    }
  }

  let rawBody: string
  try {
    rawBody = await req.text()
  } catch (err) {
    console.error('[lakala-callback/contract] read body failed:', err)
    return infraFail('body unreadable')
  }

  const headers = flattenHeaders(req)
  const platformCertPem = (process.env.LAKALA_PLATFORM_CERT_PEM || '').replace(/\\n/g, '\n')
  if (!platformCertPem) {
    console.error('[lakala-callback/contract] LAKALA_PLATFORM_CERT_PEM missing')
    return infraFail('platform cert not configured')
  }
  let verified = false
  try {
    verified = verifyResponseSignature(headers, rawBody, platformCertPem)
  } catch (err) {
    console.error('[lakala-callback/contract] verify error:', err)
    verified = false
  }
  if (!verified) {
    return NextResponse.json({ code: 'FAIL', message: 'signature mismatch' }, { status: 401 })
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch (err) {
    console.error('[lakala-callback/contract] body not json:', err)
    return ackSuccess()
  }

  // 合同回调字段在 respData 包络下（endpoints §2 异步签约结果通知）
  const dataNode = (payload.respData && typeof payload.respData === 'object'
    ? (payload.respData as Record<string, unknown>)
    : payload) as Record<string, unknown>
  const orderNo = String(dataNode.orderNo ?? payload.orderNo ?? '')
  const ecStatus = String(dataNode.ecStatus ?? '')
  const ecNo = (dataNode.ecNo as string | undefined) || null

  if (!orderNo) {
    console.error('[lakala-callback/contract] missing orderNo in payload')
    return ackSuccess()
  }

  try {
    await db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT id, contract_status, onboarding_status
          FROM lakala_merchants
         WHERE out_org_code = ${orderNo}
            OR ${orderNo} LIKE out_org_code || '%'
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE
      `)) as Array<{ id: string; contract_status: string; onboarding_status: string }>

      if (rows.length === 0) {
        console.error('[lakala-callback/contract] orderNo not found:', orderNo)
        return
      }
      const row = rows[0]

      const event = mapContractEvent(ecStatus)

      // UNDONE / 其他：不推进状态，仅更新时间戳 + 落日志
      if (!event) {
        await tx.execute(sql`
          UPDATE lakala_merchants
             SET last_callback_at = NOW(),
                 updated_at = NOW(),
                 contract_no = COALESCE(${ecNo}, contract_no)
           WHERE id = ${row.id}
        `)
        await writeInboundLog(tx, {
          lakalaMerchantId: row.id,
          reqBody: payload,
          respBody: { ok: true, action: 'noop_status', ecStatus },
          respCode: String((payload as Record<string, unknown>).code ?? '') || null,
          latencyMs: Date.now() - startedAt,
        })
        return
      }

      // COMPLETED：合同子状态机 + 主状态机同步推进
      let newContractStatus: LakalaContractStatus | null = null
      let newOnboardingStatus: LakalaOnboardingStatus | null = null
      try {
        newContractStatus = nextContractStatus(row.contract_status as LakalaContractStatus, event)
      } catch (err) {
        console.error(
          '[lakala-callback/contract] illegal contract_status transition:',
          row.contract_status,
          '+',
          event,
          err,
        )
        await writeInboundLog(tx, {
          lakalaMerchantId: row.id,
          reqBody: payload,
          respBody: {
            error: 'illegal_contract_status_transition',
            currentStatus: row.contract_status,
            event,
          },
          respCode: null,
          latencyMs: Date.now() - startedAt,
        })
        return
      }
      try {
        // 主状态机：contract_signing → contract_signed
        newOnboardingStatus = nextState(
          row.onboarding_status as LakalaOnboardingStatus,
          'contract_signed_callback',
        )
      } catch (err) {
        // 主状态机已超过 contract_signed（例如已 attachments_uploading）则保持不动；
        // 真实 TransitionError 有 name='TransitionError'，测试 mock 用同名 Error 即可
        if (!(err instanceof TransitionError) && (err as Error)?.name !== 'TransitionError') {
          throw err // 未知错误冒泡
        }
        newOnboardingStatus = null
      }

      await tx.execute(sql`
        UPDATE lakala_merchants
           SET contract_status = ${newContractStatus}::lakala_contract_status,
               onboarding_status = COALESCE(${newOnboardingStatus}::lakala_onboarding_status, onboarding_status),
               contract_no = COALESCE(${ecNo}, contract_no),
               last_callback_at = NOW(),
               updated_at = NOW()
         WHERE id = ${row.id}
      `)

      await writeInboundLog(tx, {
        lakalaMerchantId: row.id,
        reqBody: payload,
        respBody: {
          ok: true,
          newContractStatus,
          newOnboardingStatus,
          event,
          ecNo,
        },
        respCode: String((payload as Record<string, unknown>).code ?? '') || null,
        latencyMs: Date.now() - startedAt,
      })
    })
  } catch (err) {
    console.error('[lakala-callback/contract] tx failed:', err)
    return infraFail('infrastructure error')
  }

  return ackSuccess()
}

