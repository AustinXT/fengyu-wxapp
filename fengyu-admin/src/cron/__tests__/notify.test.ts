/**
 * notifyOps — cron-worker 主动告警通道
 *
 * 关键场景：
 *   A WEBHOOK URL 缺失 → console.warn 退化，不抛异常
 *   B 正常 200 → POST 调用一次，body 含 markdown content
 *   C 非 2xx 状态码 → console.warn，不抛
 *   D fetch reject（网络/超时） → console.warn，不抛
 *   E 多次调用使用最新的 env（无内部缓存）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { notifyOps } from '../lib/notify'

const WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fake-key'

describe('cron-worker — notifyOps (WeChat bot webhook)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let fetchSpy: ReturnType<typeof vi.spyOn>
  const originalEnv = process.env.WECHAT_BOT_WEBHOOK_URL

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    warnSpy.mockRestore()
    fetchSpy.mockRestore()
    if (originalEnv === undefined) delete process.env.WECHAT_BOT_WEBHOOK_URL
    else process.env.WECHAT_BOT_WEBHOOK_URL = originalEnv
  })

  it('A. WEBHOOK URL 缺失 → console.warn 退化，不发起 fetch', async () => {
    delete process.env.WECHAT_BOT_WEBHOOK_URL

    await expect(notifyOps('hello')).resolves.toBeUndefined()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('WECHAT_BOT_WEBHOOK_URL not set'),
    )
  })

  it('B. 正常 200 → POST 一次，body 含 markdown content', async () => {
    process.env.WECHAT_BOT_WEBHOOK_URL = WEBHOOK
    fetchSpy.mockResolvedValueOnce(
      new Response('{"errcode":0}', { status: 200 }),
    )

    await notifyOps('⚠️ test alert')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(calledUrl).toBe(WEBHOOK)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    )
    const body = JSON.parse(init.body as string)
    expect(body.msgtype).toBe('markdown')
    expect(body.markdown.content).toBe('⚠️ test alert')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('C. 非 2xx 状态码 → console.warn，不抛', async () => {
    process.env.WECHAT_BOT_WEBHOOK_URL = WEBHOOK
    fetchSpy.mockResolvedValueOnce(
      new Response('rate limited', {
        status: 429,
        statusText: 'Too Many Requests',
      }),
    )

    await expect(notifyOps('x')).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 429'),
    )
  })

  it('D. fetch reject（网络错误） → console.warn，不抛', async () => {
    process.env.WECHAT_BOT_WEBHOOK_URL = WEBHOOK
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    await expect(notifyOps('x')).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ECONNREFUSED'),
    )
  })

  it('E. 多次调用读取最新 env（无内部缓存）', async () => {
    delete process.env.WECHAT_BOT_WEBHOOK_URL
    await notifyOps('first') // skipped
    expect(fetchSpy).not.toHaveBeenCalled()

    process.env.WECHAT_BOT_WEBHOOK_URL = WEBHOOK
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }))
    await notifyOps('second')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
