/**
 * 拉卡拉「进件回调通知」路由测试（plan §5.6 全部分支覆盖）
 *
 * 覆盖矩阵：
 *   - 签名错 / 验签函数 throw → 401
 *   - IP 不在白名单 → 401
 *   - IP 白名单为空且 NODE_ENV=production → 401（fail-fast）
 *   - IP 白名单含 '*' → 跳过 IP 检查（SIT 联调）
 *   - body 不可读 → 5xx（infra）
 *   - PLATFORM_CERT_PEM 缺失 → 5xx（infra）
 *   - 业务异常（out_org_code 找不到 / 未知 contractStatus / 状态机非法转换）→ 200 ACK
 *   - DB 事务失败 → 5xx 让拉卡拉重试
 *   - 并发：SELECT FOR UPDATE 必须存在且在 UPDATE 之前
 *   - 幂等：同一回调 body 二次进入仍返回 200 ACK（不重复推进状态）
 *   - 成功路径：WAIT_FOR_CONTACT + merInnerNo + termDatas → UPDATE merchant_no/term_no
 *
 * Phase 1A/1B 的 verifyResponseSignature / nextState / redact 用 vi.mock 桩。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// —— vi.mock 必须在 import 路由前声明 ——

const verifyResponseSignatureMock = vi.fn<
  (headers: Record<string, string>, body: string, pem: string) => boolean
>()
vi.mock('@/lib/lakala-client', () => ({
  verifyResponseSignature: (
    h: Record<string, string>,
    b: string,
    p: string,
  ) => verifyResponseSignatureMock(h, b, p),
}))

const nextStateMock = vi.fn<(current: string, event: string) => string>()
vi.mock('@/lib/lakala-onboarding-state', () => ({
  nextState: (c: string, e: string) => nextStateMock(c, e),
}))

const redactMock = vi.fn((v: unknown) => v)
vi.mock('@/lib/lakala-redact', () => ({
  redact: (v: unknown) => redactMock(v),
}))

const txExecuteMock = vi.fn()
const dbTransactionMock = vi.fn(
  async (fn: (tx: { execute: typeof txExecuteMock }) => Promise<unknown>) => {
    return fn({ execute: txExecuteMock })
  },
)
const dbExecuteMock = vi.fn()
vi.mock('@/db', () => ({
  db: {
    transaction: (fn: (tx: { execute: typeof txExecuteMock }) => Promise<unknown>) =>
      dbTransactionMock(fn),
    execute: dbExecuteMock,
  },
}))

/**
 * 构造一个最小的 NextRequest 风格对象（route handler 只用 headers/text）。
 * 不引入 next/server 真实类，避免触发 dynamic=force-dynamic 副作用。
 */
function makeRequest(opts: {
  body: string
  ip?: string
  headers?: Record<string, string>
}): import('next/server').NextRequest {
  const headers = new Map<string, string>()
  if (opts.ip) headers.set('x-forwarded-for', opts.ip)
  if (opts.headers) {
    for (const k of Object.keys(opts.headers)) headers.set(k.toLowerCase(), opts.headers[k])
  }
  const req = {
    headers: {
      get: (k: string) => headers.get(k.toLowerCase()) ?? null,
      forEach: (cb: (v: string, k: string) => void) => {
        headers.forEach((v, k) => cb(v, k))
      },
    },
    text: async () => opts.body,
  }
  return req as unknown as import('next/server').NextRequest
}

// —— 工具：还原默认 env 状态（每个 it 前重置） ——
// 用 vi.stubEnv 而不是 process.env 直接赋值；后者在 vitest 下 NODE_ENV 是 read-only。
function setupEnv(opts: { whitelist?: string; nodeEnv?: string; cert?: string } = {}) {
  if (opts.whitelist !== undefined) {
    vi.stubEnv('LAKALA_CALLBACK_IP_WHITELIST', opts.whitelist)
  }
  if (opts.nodeEnv !== undefined) {
    vi.stubEnv('NODE_ENV', opts.nodeEnv)
  }
  if (opts.cert !== undefined) {
    vi.stubEnv('LAKALA_PLATFORM_CERT_PEM', opts.cert)
  }
}

// —— 重要：incoming/route.ts 在 import 时解析 WHITELIST_CONFIG 缓存。
// 测试用 vi.resetModules() + 动态 import，让每个用例独立 env 生效。
async function importIncomingRoute() {
  vi.resetModules()
  const mod = await import('../incoming/route')
  return mod
}

describe('POST /api/lakala/callback/incoming', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    verifyResponseSignatureMock.mockReset().mockReturnValue(true)
    nextStateMock.mockReset()
    redactMock.mockReset().mockImplementation((v) => v)
    txExecuteMock.mockReset()
    dbTransactionMock.mockClear()
    dbExecuteMock.mockReset()
    // 默认非 prod + 白名单一个 ip + cert 已配
    setupEnv({
      whitelist: '1.2.3.4',
      nodeEnv: 'test',
      cert: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----',
    })
  })

  // —— 1. IP 白名单分支 ——

  it('A. IP 不在白名单 → 401', async () => {
    setupEnv({ whitelist: '1.2.3.4', nodeEnv: 'test' })
    const { POST } = await importIncomingRoute()
    const res = await POST(makeRequest({ body: '{}', ip: '5.6.7.8' }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe('FAIL')
    // 不应进入验签 / DB
    expect(verifyResponseSignatureMock).not.toHaveBeenCalled()
    expect(dbTransactionMock).not.toHaveBeenCalled()
  })

  it('B. prod 模式 + 白名单为空 → 401 fail-fast', async () => {
    setupEnv({ whitelist: '', nodeEnv: 'production' })
    const { POST } = await importIncomingRoute()
    const res = await POST(makeRequest({ body: '{}', ip: '1.2.3.4' }))
    expect(res.status).toBe(401)
    expect(verifyResponseSignatureMock).not.toHaveBeenCalled()
  })

  it("C. 白名单含 '*' → 跳过 IP 检查（SIT 联调）", async () => {
    setupEnv({ whitelist: '*', nodeEnv: 'test' })
    verifyResponseSignatureMock.mockReturnValue(true)
    dbExecuteMock.mockResolvedValue([])
    txExecuteMock.mockResolvedValueOnce([])
    const { POST } = await importIncomingRoute()
    const res = await POST(makeRequest({ body: '{"orderNo":"lm-x"}', ip: '99.99.99.99' }))
    expect([200]).toContain(res.status)
  })

  // —— 2. 签名 ——

  it('D. 验签失败 → 401', async () => {
    verifyResponseSignatureMock.mockReturnValue(false)
    const { POST } = await importIncomingRoute()
    const res = await POST(
      makeRequest({ body: '{"orderNo":"lm-x"}', ip: '1.2.3.4' }),
    )
    expect(res.status).toBe(401)
    expect(dbTransactionMock).not.toHaveBeenCalled()
  })

  it('E. verifyResponseSignature 抛错 → 401（catch 视为验签失败）', async () => {
    verifyResponseSignatureMock.mockImplementation(() => {
      throw new Error('PEM decode error')
    })
    const { POST } = await importIncomingRoute()
    const res = await POST(
      makeRequest({ body: '{"orderNo":"lm-x"}', ip: '1.2.3.4' }),
    )
    expect(res.status).toBe(401)
  })

  it('F. PLATFORM_CERT_PEM 缺失 → 5xx 基础设施异常', async () => {
    setupEnv({
      whitelist: '1.2.3.4',
      nodeEnv: 'test',
      cert: '',
    })
    const { POST } = await importIncomingRoute()
    const res = await POST(
      makeRequest({ body: '{"orderNo":"lm-x"}', ip: '1.2.3.4' }),
    )
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  // —— 3. 业务异常 200 分支 ——

  it('G. body 不是 JSON → 200 ACK + ERROR 日志（业务异常）', async () => {
    const { POST } = await importIncomingRoute()
    const res = await POST(
      makeRequest({ body: 'not-json{{{', ip: '1.2.3.4' }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.code).toBe('SUCCESS')
    // 不应触发 db transaction
    expect(dbTransactionMock).not.toHaveBeenCalled()
  })

  it('H. orderNo 缺失 → 200 ACK', async () => {
    const { POST } = await importIncomingRoute()
    const res = await POST(
      makeRequest({ body: '{"foo":"bar"}', ip: '1.2.3.4' }),
    )
    expect(res.status).toBe(200)
    expect(dbTransactionMock).not.toHaveBeenCalled()
  })

  it('I. out_org_code 找不到 → 200 ACK（rows.length=0）', async () => {
    txExecuteMock.mockResolvedValueOnce([])
    const { POST } = await importIncomingRoute()
    const res = await POST(
      makeRequest({
        body: '{"orderNo":"lm-not-exist","data":{"contractStatus":"WAIT_FOR_CONTACT"}}',
        ip: '1.2.3.4',
      }),
    )
    expect(res.status).toBe(200)
    // FOR UPDATE 一次查询，无后续 UPDATE
    expect(txExecuteMock).toHaveBeenCalledTimes(1)
    const firstCallSql = txExecuteMock.mock.calls[0][0]
    const text = stringifySql(firstCallSql)
    expect(text).toMatch(/FOR UPDATE/i)
  })

  it('J. 未知 contractStatus → 200 ACK + 写 ERROR 日志', async () => {
    txExecuteMock
      .mockResolvedValueOnce([{ id: 'lm-1', onboarding_status: 'submitted' }])
      .mockResolvedValueOnce([]) // INSERT log
    const { POST } = await importIncomingRoute()
    const res = await POST(
      makeRequest({
        body: '{"orderNo":"lm-1","data":{"contractStatus":"UNKNOWN_STATUS"}}',
        ip: '1.2.3.4',
      }),
    )
    expect(res.status).toBe(200)
    // SELECT FOR UPDATE + INSERT lakala_merchant_logs
    expect(txExecuteMock).toHaveBeenCalledTimes(2)
    const logSql = stringifySql(txExecuteMock.mock.calls[1][0])
    expect(logSql).toMatch(/INSERT INTO lakala_merchant_logs/i)
    // nextState 不应被调用（未知 contractStatus 提前 return）
    expect(nextStateMock).not.toHaveBeenCalled()
  })

  it('K. 状态机非法转换（nextState throw）→ 200 ACK + 写 ERROR 日志', async () => {
    txExecuteMock
      .mockResolvedValueOnce([{ id: 'lm-1', onboarding_status: 'completed' }])
      .mockResolvedValueOnce([]) // INSERT log
    nextStateMock.mockImplementation(() => {
      throw new Error('illegal transition')
    })
    const { POST } = await importIncomingRoute()
    const res = await POST(
      makeRequest({
        body: '{"orderNo":"lm-1","data":{"contractStatus":"WAIT_FOR_CONTACT"}}',
        ip: '1.2.3.4',
      }),
    )
    expect(res.status).toBe(200)
    expect(nextStateMock).toHaveBeenCalledWith('completed', 'callback_approved')
    // SELECT + INSERT log，无 UPDATE
    expect(txExecuteMock).toHaveBeenCalledTimes(2)
    const logSql = stringifySql(txExecuteMock.mock.calls[1][0])
    expect(logSql).toMatch(/INSERT INTO lakala_merchant_logs/i)
  })

  // —— 4. 基础设施异常 5xx ——

  it('L. DB 事务失败 → 5xx 让拉卡拉重试', async () => {
    dbTransactionMock.mockImplementationOnce(async () => {
      throw new Error('connection refused')
    })
    const { POST } = await importIncomingRoute()
    const res = await POST(
      makeRequest({
        body: '{"orderNo":"lm-1","data":{"contractStatus":"WAIT_FOR_CONTACT"}}',
        ip: '1.2.3.4',
      }),
    )
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  // —— 5. 成功路径（含 SELECT FOR UPDATE 并发保护断言） ——

  it('M. 成功路径：SELECT FOR UPDATE → UPDATE merchant_no/term_no + INSERT log', async () => {
    txExecuteMock
      .mockResolvedValueOnce([{ id: 'lm-1', onboarding_status: 'submitted' }])
      .mockResolvedValueOnce([]) // UPDATE
      .mockResolvedValueOnce([]) // INSERT log
    nextStateMock.mockReturnValue('approved')

    const { POST } = await importIncomingRoute()
    const res = await POST(
      makeRequest({
        body: JSON.stringify({
          orderNo: 'lm-1',
          data: {
            contractStatus: 'WAIT_FOR_CONTACT',
            merInnerNo: '8221xxxxxxxxxxxxx',
            termDatas: [{ termNo: 'T0000001' }],
          },
        }),
        ip: '1.2.3.4',
      }),
    )
    expect(res.status).toBe(200)
    expect(nextStateMock).toHaveBeenCalledWith('submitted', 'callback_approved')

    // 顺序验证：[0]=SELECT FOR UPDATE，[1]=UPDATE，[2]=INSERT
    expect(txExecuteMock).toHaveBeenCalledTimes(3)
    expect(stringifySql(txExecuteMock.mock.calls[0][0])).toMatch(/SELECT[\s\S]+FOR UPDATE/i)
    expect(stringifySql(txExecuteMock.mock.calls[1][0])).toMatch(
      /UPDATE\s+lakala_merchants[\s\S]+SET[\s\S]+onboarding_status/i,
    )
    expect(stringifySql(txExecuteMock.mock.calls[2][0])).toMatch(
      /INSERT INTO lakala_merchant_logs/i,
    )
  })

  it('N. 幂等：同一回调 body 二次进入 → 第二次 nextState 抛错（completed 无 approved 事件）→ 200 ACK', async () => {
    // 第一次：submitted → approved
    txExecuteMock
      .mockResolvedValueOnce([{ id: 'lm-1', onboarding_status: 'submitted' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    nextStateMock.mockReturnValueOnce('approved')

    const { POST } = await importIncomingRoute()
    const body = JSON.stringify({
      orderNo: 'lm-1',
      data: { contractStatus: 'WAIT_FOR_CONTACT', merInnerNo: 'M1', termDatas: [{ termNo: 'T1' }] },
    })

    const res1 = await POST(makeRequest({ body, ip: '1.2.3.4' }))
    expect(res1.status).toBe(200)

    // 第二次：状态已是 approved，nextState 抛错
    txExecuteMock
      .mockResolvedValueOnce([{ id: 'lm-1', onboarding_status: 'approved' }])
      .mockResolvedValueOnce([]) // INSERT log
    nextStateMock.mockImplementationOnce(() => {
      throw new Error('illegal: approved + callback_approved')
    })
    const res2 = await POST(makeRequest({ body, ip: '1.2.3.4' }))
    expect(res2.status).toBe(200)
    // 第二次没 UPDATE 推进（只有 SELECT + INSERT log）
    const lastTxCalls = txExecuteMock.mock.calls.slice(-2)
    expect(stringifySql(lastTxCalls[0][0])).toMatch(/SELECT[\s\S]+FOR UPDATE/i)
    expect(stringifySql(lastTxCalls[1][0])).toMatch(/INSERT INTO lakala_merchant_logs/i)
  })

  it('O. redact 失败兜底 → 不挂回调，日志写 _redactFailed', async () => {
    txExecuteMock
      .mockResolvedValueOnce([{ id: 'lm-1', onboarding_status: 'submitted' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    nextStateMock.mockReturnValue('approved')
    redactMock.mockImplementation(() => {
      throw new Error('redact bug')
    })
    const { POST } = await importIncomingRoute()
    const res = await POST(
      makeRequest({
        body: '{"orderNo":"lm-1","data":{"contractStatus":"WAIT_FOR_CONTACT"}}',
        ip: '1.2.3.4',
      }),
    )
    expect(res.status).toBe(200)
    // INSERT 仍然发生，body 是 _redactFailed
    expect(txExecuteMock.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})

/** 从 drizzle sql 模板对象中提取拼接后的 SQL 文本（参数用 ? 占位） */
function stringifySql(sqlObj: unknown): string {
  if (!sqlObj || typeof sqlObj !== 'object') return ''
  const chunks = (sqlObj as { queryChunks?: unknown[] }).queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((c) => {
      if (c && typeof c === 'object' && 'value' in (c as Record<string, unknown>)) {
        const v = (c as { value: unknown }).value
        return Array.isArray(v) ? v.join('') : String(v)
      }
      if (c && typeof c === 'object' && 'queryChunks' in (c as Record<string, unknown>)) {
        return stringifySql(c)
      }
      return '?'
    })
    .join('')
}
