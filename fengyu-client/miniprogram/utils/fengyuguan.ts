import { getCosBase } from './cloud-env'

/** 校验云端下发的分条，不在前端拼图源或处理规则。 */
export function sanitizeFengyuguanStrips(value: unknown): { url: string; heightRpx: number }[] {
  if (!Array.isArray(value) || value.length > 12) return []
  const prefix = `${getCosBase()}/images/fengyuguan.jpg?imageMogr2/cut/`
  const result: { url: string; heightRpx: number }[] = []
  for (const strip of value) {
    if (!strip || typeof strip.url !== 'string' || !strip.url.startsWith(prefix)) return []
    const match = /^(\d+)x(\d+)x0x(\d+)\/thumbnail\/(\d+)x(\d+)&v=(\d+)$/.exec(strip.url.slice(prefix.length))
    if (!match) return []
    const [width, height, dy, boxWidth, boxHeight, version] = match.slice(1).map(Number)
    if (![width, height, dy, boxWidth, boxHeight, version].every(Number.isSafeInteger)
      || width < 1 || width > 45000 || height < 1 || height > 4000 || dy < 0 || dy + height > 45000
      || boxWidth !== Math.min(width, 750) || boxHeight !== Math.min(height, 4000)
      || strip.heightRpx !== Math.ceil(750 * height / width)) return []
    result.push({ url: strip.url, heightRpx: strip.heightRpx })
  }
  return result
}
