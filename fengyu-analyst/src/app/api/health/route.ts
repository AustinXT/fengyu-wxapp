import { createHmac, timingSafeEqual } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db'

export const dynamic = 'force-dynamic'

const WINDOW_MS = 5 * 60 * 1_000

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.JWT_SECRET?.trim()
  if (!secret) return false
  const timestamp = request.headers.get('x-health-timestamp') || ''
  const nonce = request.headers.get('x-health-nonce') || ''
  const signature = request.headers.get('x-health-signature') || ''
  const timestampNumber = Number(timestamp)
  if (
    !timestampNumber
    || Math.abs(Date.now() - timestampNumber) > WINDOW_MS
    || !/^[0-9a-f-]{16,64}$/i.test(nonce)
    || !/^[0-9a-f]{64}$/i.test(signature)
  ) return false
  const expected = createHmac('sha256', secret)
    .update(`analyst\n${timestamp}\n${nonce}`)
    .digest('hex')
  const actualBuffer = Buffer.from(signature, 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

async function probeAiGateway(): Promise<{ status: 'ok' | 'disabled' | 'error'; latencyMs?: number }> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.MINIMAX_API_KEY
  if (!apiKey) return { status: 'disabled' }
  const base = process.env.OPENAI_API_KEY
    ? process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    : process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1'
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await fetch(base, { method: 'HEAD', redirect: 'manual', signal: controller.signal, cache: 'no-store' })
    if (response.status >= 500) return { status: 'error', latencyMs: Date.now() - startedAt }
    return { status: 'ok', latencyMs: Date.now() - startedAt }
  } catch {
    return { status: 'error', latencyMs: Date.now() - startedAt }
  } finally {
    clearTimeout(timeout)
  }
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, errorType: 'UNAUTHORIZED' }, { status: 401 })
  }
  const startedAt = Date.now()
  try {
    await db.execute(sql`SELECT 1`)
    const databaseLatencyMs = Date.now() - startedAt
    const ai = await probeAiGateway()
    return NextResponse.json({
      ok: ai.status !== 'error',
      checkedAt: new Date().toISOString(),
      dependencies: {
        database: { status: 'ok', latencyMs: databaseLatencyMs },
        ai,
      },
    }, { status: ai.status === 'error' ? 503 : 200 })
  } catch {
    return NextResponse.json({ ok: false, checkedAt: new Date().toISOString() }, { status: 503 })
  }
}
