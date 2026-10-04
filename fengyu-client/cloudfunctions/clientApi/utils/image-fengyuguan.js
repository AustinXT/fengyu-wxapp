/** 凤御馆专属：服务端取小型 imageInfo JSON，前端不探测原图。
 * https://cloud.tencent.com/document/product/460/6927
 */
const { COS_BASE } = require('./image-banner')
const SOURCE = `${COS_BASE}/images/fengyuguan.jpg`
const MAX_EDGE = 45000
const MAX_PIXELS = 90000000
const STRIP_HEIGHT = 4000
const MAX_STRIPS = Math.ceil(MAX_EDGE / STRIP_HEIGHT)
let cache = null

function normalizeVersion(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function buildFengyuguanStrips(width, height, version) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
    throw new Error('INVALID_STATE: 宣传图尺寸不合法')
  }
  const count = Math.ceil(height / STRIP_HEIGHT)
  const stripHeight = Math.ceil(height / count)
  return Array.from({ length: count }, (_, index) => {
    const dy = index * stripHeight
    const sh = Math.min(stripHeight, height - dy)
    // box 两边均不超过裁片原尺寸：窄图不放大，每片最多750*4000像素。
    const boxWidth = Math.min(width, 750)
    const boxHeight = Math.min(sh, 4000)
    return {
      url: `${SOURCE}?imageMogr2/cut/${width}x${sh}x0x${dy}/thumbnail/${boxWidth}x${boxHeight}&v=${normalizeVersion(version)}`,
      heightRpx: Math.ceil(750 * sh / width),
    }
  })
}

async function readImageInfo(version) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    // URL仅来自常量，禁止重定向，忽略DB中可编辑的图源，避免SSRF与原图降级。
    const response = await fetch(`${SOURCE}?imageInfo&v=${version}`, { signal: controller.signal, redirect: 'error' })
    if (!response.ok || !response.body) throw new Error('imageInfo unavailable')
    const reader = response.body.getReader()
    let bytes = 0
    const chunks = []
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 4096) throw new Error('imageInfo response too large')
        chunks.push(Buffer.from(value))
      }
    } finally { await reader.cancel().catch(() => undefined) }
    const info = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (Number(info.frame_count) !== 1) throw new Error('animated image is not supported')
    return buildFengyuguanStrips(Number(info.width), Number(info.height), version)
  } finally { clearTimeout(timer) }
}

async function loadFengyuguanStrips(version) {
  const v = normalizeVersion(version)
  if (!cache || cache.v !== v || cache.expiresAt < Date.now()) {
    const pending = readImageInfo(v).catch((error) => {
      console.warn('[config.fengyuguan] imageInfo unavailable:', error.message)
      return [] // 不回退历史尺寸或原图。短缓存避免上游故障时每次请求重试。
    })
    cache = { v, pending, expiresAt: Date.now() + 30000 }
  }
  return cache.pending
}

module.exports = { loadFengyuguanStrips, buildFengyuguanStrips, SOURCE, MAX_STRIPS }
