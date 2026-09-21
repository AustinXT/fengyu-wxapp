/**
 * 上传接口的分辨率闸门测试（issue #213）
 *
 * 光测 getImageDimensions 不够：如果有人把 `!dimensions` 的拒绝改成放行、
 * 放宽 exactKey 条件、或调换校验顺序，纯解析器测试全都照样通过。
 * 这里从路由入口验证闸门本身，并断言被拒时**不会**真的上传。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  jwtVerify: vi.fn(),
  uploadFile: vi.fn(),
}))

vi.mock('jose', () => ({ jwtVerify: mocks.jwtVerify }))
vi.mock('@/lib/cloudbase', () => ({ uploadFile: mocks.uploadFile }))
vi.mock('@/lib/jwt-secret', () => ({ JWT_SECRET: new Uint8Array(32) }))

import { POST } from './route'

// ── fixtures ────────────────────────────────────────────────────────────────

/** 8 字节签名 + 完整 IHDR chunk（长度 4 + 类型 4 + 数据 13 + CRC 4） */
function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33)
  buf.writeUInt32BE(0x89504e47, 0)
  buf.writeUInt32BE(0x0d0a1a0a, 4)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  buf.writeUInt8(8, 24)
  buf.writeUInt8(6, 25)
  return buf
}

/**
 * 结构完整的两帧 GIF（每帧含 Image Descriptor + LZW sub-block 链 + trailer）。
 * 用完整块结构而不是裸拼两个 Image Descriptor —— 否则这条测试证明的其实是
 * 「畸形 GIF 被 fail-closed 拒绝」，而不是「合法两帧 GIF 从路由入口被拒」。
 */
function makeAnimatedGif(width: number, height: number): Buffer {
  const lsd = Buffer.alloc(13)
  lsd.write('GIF89a', 0, 'ascii')
  lsd.writeUInt16LE(width, 6)
  lsd.writeUInt16LE(height, 8)

  const frame = Buffer.concat([
    Buffer.from([0x2c]), // Image Separator
    Buffer.from([0, 0, 0, 0]), // left / top
    Buffer.from([width & 0xff, width >> 8, height & 0xff, height >> 8]),
    Buffer.from([0x00]), // packed：无局部颜色表
    Buffer.from([0x08, 0x01, 0x00, 0x00]), // LZW min code size + sub-block 链
  ])

  return Buffer.concat([lsd, frame, frame, Buffer.from([0x3b])])
}

function post(
  body: Buffer,
  { type = 'image/png', path, exactKey } = {} as {
    type?: string
    path?: string
    exactKey?: string
  }
) {
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array(body)], 'a.png', { type }))
  if (path) fd.append('path', path)
  if (exactKey) fd.append('exactKey', exactKey)

  const req = new NextRequest('http://localhost/api/upload', {
    method: 'POST',
    body: fd,
  })
  req.cookies.set('fy-admin-token', 'valid')
  return POST(req)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.jwtVerify.mockResolvedValue({ payload: {} })
  mocks.uploadFile.mockResolvedValue('https://cdn.example.com/a.png')
})

// ── tests ───────────────────────────────────────────────────────────────────

describe('POST /api/upload 分辨率闸门', () => {
  it('正常门店照片放行并上传', async () => {
    const res = await post(makePng(2083, 1333), { path: 'store-covers' })
    expect(res.status).toBe(200)
    expect(mocks.uploadFile).toHaveBeenCalledOnce()
  })

  it('issue #213 肇事图（12576×12575）被拒且不上传', async () => {
    const res = await post(makePng(12576, 12575), { path: 'store-covers' })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('分辨率过大'),
    })
    expect(mocks.uploadFile).not.toHaveBeenCalled()
  })

  it('解析不出尺寸时 fail-closed：拒绝且不上传', async () => {
    // 自称 image/png，实际是随机字节（file.type 由客户端提供，可伪造）
    const res = await post(Buffer.from('definitely not an image'), {
      path: 'store-covers',
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('无法识别图片尺寸'),
    })
    expect(mocks.uploadFile).not.toHaveBeenCalled()
  })

  it('细长图被单边上限拦下（像素积远低于 40MP）', async () => {
    // 500×50000 = 25MP，能过像素积上限，但缩略后解码仍是几十 MB
    const res = await post(makePng(500, 50000), { path: 'store-covers' })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('单边尺寸过大'),
    })
    expect(mocks.uploadFile).not.toHaveBeenCalled()
  })

  it('动图被拒（帧数放大解码开销，像素积校验看不到）', async () => {
    const res = await post(makeAnimatedGif(1000, 1000), {
      type: 'image/gif',
      path: 'store-covers',
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('不支持动图'),
    })
    expect(mocks.uploadFile).not.toHaveBeenCalled()
  })

  describe('凤御馆长图走独立阈值，但不是豁免', () => {
    const FENGYUGUAN_KEY = 'images/fengyuguan.jpg'

    it('生产现有尺寸 2083×37403 必须能传（否则是回归）', async () => {
      const res = await post(makePng(2083, 37403), {
        exactKey: FENGYUGUAN_KEY,
      })
      expect(res.status).toBe(200)
      expect(mocks.uploadFile).toHaveBeenCalledOnce()
    })

    it('同一张图走普通 path 模式则被拒', async () => {
      const res = await post(makePng(2083, 37403), { path: 'store-covers' })
      expect(res.status).toBe(400)
      expect(mocks.uploadFile).not.toHaveBeenCalled()
    })

    // 下面两条刻意各自只触发一个守卫：若用同时超两个阈值的尺寸，
    // 删掉任一守卫测试都仍会通过，等于证明不了什么。
    it('超出独立阈值的像素积仍被拒（单边未超）', async () => {
      const res = await post(makePng(30000, 5000), {
        exactKey: FENGYUGUAN_KEY,
      })
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringContaining('分辨率过大'),
      })
      expect(mocks.uploadFile).not.toHaveBeenCalled()
    })

    it('超出独立阈值的单边仍被拒（像素积未超）', async () => {
      const res = await post(makePng(46000, 1000), {
        exactKey: FENGYUGUAN_KEY,
      })
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringContaining('单边尺寸过大'),
      })
      expect(mocks.uploadFile).not.toHaveBeenCalled()
    })

    /**
     * 用 64MP：超通用 40MP 但低于凤御馆 90MP，单边 8000 也低于通用上限 12000。
     * 于是只有「其它 exactKey 错误地继承了凤御馆阈值」时才会放行——
     * 若改用 158MP 那种两边都超的尺寸，把实现改坏成 isFengyuguan = !!exactKey 测试照样通过。
     */
    it('其它 exactKey 不继承豁免，适用通用阈值', async () => {
      const res = await post(makePng(8000, 8000), {
        exactKey: 'images/other-fixed.jpg',
      })
      expect(res.status).toBe(400)
      expect(mocks.uploadFile).not.toHaveBeenCalled()
    })

    it('同一 64MP 图走凤御馆 key 则放行（证明两套阈值确实不同）', async () => {
      const res = await post(makePng(8000, 8000), {
        exactKey: FENGYUGUAN_KEY,
      })
      expect(res.status).toBe(200)
      expect(mocks.uploadFile).toHaveBeenCalledOnce()
    })
  })

  it('未携带 token 时直接 401，不触碰文件', async () => {
    const fd = new FormData()
    fd.append('file', new File([new Uint8Array(makePng(100, 100))], 'a.png'))
    fd.append('path', 'store-covers')
    const res = await POST(
      new NextRequest('http://localhost/api/upload', {
        method: 'POST',
        body: fd,
      })
    )
    expect(res.status).toBe(401)
    expect(mocks.uploadFile).not.toHaveBeenCalled()
  })
})
