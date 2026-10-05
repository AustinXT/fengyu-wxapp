import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { sanitizeFengyuguanStrips } from '../../utils/fengyuguan'
import { getCosBase } from '../../utils/cloud-env'
const require = createRequire(import.meta.url)
const { buildFengyuguanStrips } = require('../../../cloudfunctions/clientApi/utils/image-fengyuguan.js')

describe('凤御馆云端到前端闭环', () => {
  test.each([[100, 40000], [2083, 37403], [300, 200], [1, 45000]])('真实服务端%s×%s分条全部接受', (w, h) => {
    const strips = buildFengyuguanStrips(w, h, 123)
    expect(sanitizeFengyuguanStrips(strips)).toEqual(strips)
    expect(strips[0].url.startsWith(getCosBase())).toBe(true)
  })
  test.each([
    'https://evil.example/images/fengyuguan.jpg?imageMogr2/cut/100x4000x0x0/thumbnail/100x4000&v=1',
    `${getCosBase()}/images/fengyuguan.jpg`,
    `${getCosBase()}/images/fengyuguan.jpg?imageMogr2/cut/100x4000x0x0/thumbnail/750x&v=1`,
    `${getCosBase()}/images/fengyuguan.jpg?imageMogr2/cut/100x4000x0x0/thumbnail/750x4000&v=1`,
    `${getCosBase()}/images/fengyuguan.jpg?imageMogr2/cut/100x4000x0x0/thumbnail/100x4000&v=1&imageView2/1/w/9999`,
  ])('拒绝原图/错误域/单边/放大/额外参数：%s', (url) => {
    expect(sanitizeFengyuguanStrips([{ url, heightRpx: 30000 }])).toEqual([])
  })
  test('错误比例、无界条数和空数据拒绝', () => {
    const valid = buildFengyuguanStrips(100, 40000, 1)
    expect(sanitizeFengyuguanStrips([{ ...valid[0], heightRpx: 1 }])).toEqual([])
    expect(sanitizeFengyuguanStrips(Array(13).fill(valid[0]))).toEqual([])
    expect(sanitizeFengyuguanStrips(null)).toEqual([])
  })
  test('页面不再探测原图、构造缩略或退回历史尺寸', () => {
    const source = readFileSync(new URL('../../pages/cart/cart.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('getImageInfo')
    expect(source).not.toContain('imageMogr2')
    expect(source).not.toContain('FALLBACK_')
    expect(source).toContain('sanitizeFengyuguanStrips(res?.strips)')
  })
})
