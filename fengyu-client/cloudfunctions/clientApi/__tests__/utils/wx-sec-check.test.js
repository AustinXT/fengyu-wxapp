/**
 * wx-sec-check 内容安全校验工具单测
 *
 * 通过覆写 sec.__net.httpGetJson / httpPostRaw 注入网络桩（不 mock 内置 https：
 * vitest 默认外部化 Node 内置模块，vi.mock('https') 不生效）。
 * token 走 httpGetJson，sec_check 走 httpPostRaw。
 * wx-server-sdk 由全局 setup.js mock，getWXContext().OPENID = 'test-openid-001' → checkText 走 2.0。
 */

const sec = require('../../utils/wx-sec-check')

let httpGetJson
let httpPostRaw

beforeEach(() => {
  sec._resetTokenCache()
  process.env.SEC_CHECK_ENABLED = 'true'
  process.env.CLIENT_APPSECRET = 'test-appsecret'
  httpGetJson = vi.fn().mockResolvedValue({ access_token: 'tok', expires_in: 7200 })
  httpPostRaw = vi.fn()
  sec.__net.httpGetJson = httpGetJson
  sec.__net.httpPostRaw = httpPostRaw
})

afterEach(() => {
  delete process.env.SEC_CHECK_ENABLED
  delete process.env.CLIENT_APPSECRET
})

describe('isEnabled / 总开关 no-op', () => {
  test('未设 SEC_CHECK_ENABLED → checkText 不发请求直接放行', async () => {
    delete process.env.SEC_CHECK_ENABLED
    expect(sec.isEnabled()).toBe(false)
    await expect(sec.checkText('任意内容')).resolves.toBeUndefined()
    expect(httpGetJson).not.toHaveBeenCalled()
    expect(httpPostRaw).not.toHaveBeenCalled()
  })

  test('未配 CLIENT_APPSECRET → checkImage 不发请求直接放行', async () => {
    delete process.env.CLIENT_APPSECRET
    expect(sec.isEnabled()).toBe(false)
    await expect(sec.checkImage(Buffer.from('img'))).resolves.toBeUndefined()
    expect(httpPostRaw).not.toHaveBeenCalled()
  })
})

describe('checkText（msg_sec_check）', () => {
  test('suggest=pass 放行，且先取 token 再校验', async () => {
    httpPostRaw.mockResolvedValueOnce({ errcode: 0, result: { suggest: 'pass' } })
    await expect(sec.checkText('你好世界')).resolves.toBeUndefined()
    expect(httpGetJson).toHaveBeenCalledTimes(1)
    expect(httpPostRaw).toHaveBeenCalledTimes(1)
  })

  test('空 / 纯空白 / null 直接放行，不发请求', async () => {
    await expect(sec.checkText('   ')).resolves.toBeUndefined()
    await expect(sec.checkText('')).resolves.toBeUndefined()
    await expect(sec.checkText(null)).resolves.toBeUndefined()
    expect(httpPostRaw).not.toHaveBeenCalled()
  })

  test('携带 openid 走 2.0（version=2 + scene + openid），打到 msg_sec_check', async () => {
    httpPostRaw.mockResolvedValueOnce({ errcode: 0, result: { suggest: 'pass' } })
    await sec.checkText('hi', { scene: 2 })
    const [url, bodyBuf, contentType] = httpPostRaw.mock.calls[0]
    expect(url).toContain('/wxa/msg_sec_check')
    expect(contentType).toBe('application/json')
    expect(JSON.parse(bodyBuf.toString())).toMatchObject({
      content: 'hi', version: 2, scene: 2, openid: 'test-openid-001',
    })
  })

  test('suggest=risky → 抛 INVALID_PARAMS + CONTENT_RISKY', async () => {
    httpPostRaw.mockResolvedValueOnce({ errcode: 0, result: { suggest: 'risky', label: 20001 } })
    await expect(sec.checkText('违规内容')).rejects.toThrow(/INVALID_PARAMS: CONTENT_RISKY/)
  })

  test('suggest=review 默认放行', async () => {
    httpPostRaw.mockResolvedValueOnce({ errcode: 0, result: { suggest: 'review' } })
    await expect(sec.checkText('疑似内容')).resolves.toBeUndefined()
  })

  test('1.0 errcode 87014 → 抛 CONTENT_RISKY', async () => {
    httpPostRaw.mockResolvedValueOnce({ errcode: 87014, errmsg: 'risky content' })
    await expect(sec.checkText('违规')).rejects.toThrow(/CONTENT_RISKY/)
  })

  test('token 过期 40001 → 强刷重试一次后通过（两次取 token）', async () => {
    httpPostRaw
      .mockResolvedValueOnce({ errcode: 40001, errmsg: 'access_token expired' })
      .mockResolvedValueOnce({ errcode: 0, result: { suggest: 'pass' } })
    await expect(sec.checkText('你好')).resolves.toBeUndefined()
    expect(httpGetJson).toHaveBeenCalledTimes(2) // 第二次为 forceRefresh
    expect(httpPostRaw).toHaveBeenCalledTimes(2)
  })

  test('非违规 errcode（如 -1 系统错）→ fail-closed 抛 SEC_CHECK_UNAVAILABLE', async () => {
    httpPostRaw.mockResolvedValueOnce({ errcode: -1, errmsg: 'system error' })
    await expect(sec.checkText('你好')).rejects.toThrow(/SEC_CHECK_UNAVAILABLE/)
  })

  test('网络异常（httpPostRaw reject）→ fail-closed', async () => {
    httpPostRaw.mockRejectedValueOnce(new Error('socket hang up'))
    await expect(sec.checkText('你好')).rejects.toThrow(/SEC_CHECK_UNAVAILABLE/)
  })

  test('取 token 失败 → fail-closed', async () => {
    httpGetJson.mockResolvedValueOnce({ errcode: 40013, errmsg: 'invalid appid' })
    await expect(sec.checkText('你好')).rejects.toThrow(/SEC_CHECK_UNAVAILABLE/)
    expect(httpPostRaw).not.toHaveBeenCalled()
  })
})

describe('checkImage（img_sec_check）', () => {
  test('errcode 0 放行', async () => {
    httpPostRaw.mockResolvedValueOnce({ errcode: 0, errmsg: 'ok' })
    await expect(sec.checkImage(Buffer.from('PNGDATA'))).resolves.toBeUndefined()
    expect(httpGetJson).toHaveBeenCalledTimes(1)
    expect(httpPostRaw).toHaveBeenCalledTimes(1)
  })

  test('空 buffer 直接放行，不发请求', async () => {
    await expect(sec.checkImage(Buffer.alloc(0))).resolves.toBeUndefined()
    expect(httpPostRaw).not.toHaveBeenCalled()
  })

  test('multipart 请求体含 media 字段与图片数据，打到 img_sec_check', async () => {
    httpPostRaw.mockResolvedValueOnce({ errcode: 0 })
    await sec.checkImage(Buffer.from('PNGDATA'))
    const [url, bodyBuf, contentType] = httpPostRaw.mock.calls[0]
    expect(url).toContain('/wxa/img_sec_check')
    expect(contentType).toContain('multipart/form-data')
    const body = bodyBuf.toString()
    expect(body).toContain('name="media"')
    expect(body).toContain('PNGDATA')
  })

  test('87014 → 抛 CONTENT_RISKY', async () => {
    httpPostRaw.mockResolvedValueOnce({ errcode: 87014, errmsg: 'risky content' })
    await expect(sec.checkImage(Buffer.from('img'))).rejects.toThrow(/CONTENT_RISKY/)
  })

  test('超限 / 其它 errcode → fail-closed SEC_CHECK_UNAVAILABLE', async () => {
    httpPostRaw.mockResolvedValueOnce({ errcode: 40005, errmsg: 'invalid media size' })
    await expect(sec.checkImage(Buffer.from('img'))).rejects.toThrow(/SEC_CHECK_UNAVAILABLE/)
  })
})
