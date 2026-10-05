let image
beforeEach(() => {
  vi.restoreAllMocks()
  delete require.cache[require.resolve('../../utils/image-fengyuguan')]
  image = require('../../utils/image-fengyuguan')
})

function jsonInfo(width = 2083, height = 37403) {
  return new Response(JSON.stringify({ width: String(width), height: String(height), frame_count: '1' }))
}

describe('凤御馆服务端分条', () => {
  test.each([[100, 40000], [2083, 37403], [300, 200], [1, 45000]])('尺寸%s×%s：双边封顶且不放大', (width, height) => {
    const strips = image.buildFengyuguanStrips(width, height, 123)
    expect(strips.length).toBeLessThanOrEqual(image.MAX_STRIPS)
    let sum = 0
    for (const strip of strips) {
      const m = /cut\/(\d+)x(\d+)x0x(\d+)\/thumbnail\/(\d+)x(\d+)&v=123$/.exec(strip.url)
      expect(m).not.toBeNull()
      const [, w, sh, dy, bw, bh] = m.map(Number)
      expect(w).toBe(width); expect(dy).toBe(sum)
      expect(bw).toBeLessThanOrEqual(width); expect(bh).toBeLessThanOrEqual(sh)
      expect(bw * bh).toBeLessThanOrEqual(750 * 4000)
      sum += sh
    }
    expect(sum).toBe(height)
  })
  test.each([[null, 100], [2.5, 100], [100, 45001], [45000, 45000], [0, 100]])('非法尺寸拒绝%s/%s', (w, h) => {
    expect(() => image.buildFengyuguanStrips(w, h, 0)).toThrow('INVALID_STATE:')
  })
  test('只获取常量源imageInfo元数据，版本变化刷新，缓存合并并发', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonInfo())
    const [a, b] = await Promise.all([image.loadFengyuguanStrips(10), image.loadFengyuguanStrips(10)])
    expect(a).toEqual(b); expect(a).toHaveLength(10); expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`${image.SOURCE}?imageInfo&v=10`)
    expect(fetchMock.mock.calls[0][1].redirect).toBe('error')
    await image.loadFengyuguanStrips(11)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  test.each(['oversize', 'bad-json', 'animated', 'http-error', 'network-error'])('元数据%s不回退原图/历史尺寸', async (kind) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (kind === 'network-error') throw new Error('network')
      if (kind === 'oversize') return new Response('x'.repeat(4097))
      if (kind === 'bad-json') return new Response('invalid')
      if (kind === 'animated') return new Response(JSON.stringify({ width: 100, height: 100, frame_count: 2 }))
      return new Response('', { status: 500 })
    })
    expect(await image.loadFengyuguanStrips(1)).toEqual([])
  })
})
