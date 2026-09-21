/**
 * 从图片二进制 header 解析原始分辨率（无需引入 sharp 等原生依赖）
 *
 * 背景（issue #213）：上传接口原本只校验 file.size，而小程序渲染时的解码内存
 * 只跟「像素数」有关、跟文件体积无关。生产上传过一张 12576×12575 的调色板 PNG，
 * 文件仅 405KB 顺利通过 5MB 体积校验，却让顾客端小程序解码时吃掉约 603MB 内存，
 * 进程被微信杀掉并提示「小程序意外退出」。因此必须在入口按分辨率把关。
 *
 * 支持 ALLOWED_TYPES 覆盖的 4 种格式：PNG / JPEG / WebP / GIF。
 * 解析不出来时返回 null（交给调用方决定放行还是拒绝），绝不抛异常。
 */

export interface ImageDimensions {
  width: number
  height: number
}

/** PNG：8 字节签名 + IHDR，宽高为 big-endian uint32 */
function parsePng(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24) return null
  // \x89PNG\r\n\x1a\n
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** GIF：GIF87a / GIF89a，逻辑屏幕宽高为 little-endian uint16 */
function parseGif(buf: Buffer): ImageDimensions | null {
  if (buf.length < 10) return null
  const sig = buf.toString("ascii", 0, 6)
  if (sig !== "GIF87a" && sig !== "GIF89a") return null
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

/**
 * JPEG：扫描 marker 段找 SOFn（0xC0-0xCF，其中 C4/C8/CC 不是 SOF）
 * SOF 段结构：FF Cn | length(2) | precision(1) | height(2) | width(2)
 */
function parseJpeg(buf: Buffer): ImageDimensions | null {
  if (buf.length < 4) return null
  if (buf.readUInt16BE(0) !== 0xffd8) return null

  let offset = 2
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = buf[offset + 1]

    // 填充字节 / 无参数段，跳过
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }

    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc

    if (isSof) {
      return {
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7),
      }
    }

    const segmentLength = buf.readUInt16BE(offset + 2)
    if (segmentLength < 2) return null
    offset += 2 + segmentLength
  }
  return null
}

/** WebP：RIFF....WEBP 后接 VP8 / VP8L / VP8X 三种 chunk，宽高编码各不相同 */
function parseWebp(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30) return null
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null
  if (buf.toString("ascii", 8, 12) !== "WEBP") return null

  const format = buf.toString("ascii", 12, 16)

  if (format === "VP8 ") {
    // 有损：关键帧头 3 字节 signature 后为 14 位宽/高
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    }
  }

  if (format === "VP8L") {
    // 无损：1 字节 signature(0x2f) 后 14 位宽、14 位高，各自 -1 存储
    const bits = buf.readUInt32LE(21)
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    }
  }

  if (format === "VP8X") {
    // 扩展：24 位宽/高，-1 存储
    const width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1
    const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1
    return { width, height }
  }

  return null
}

/**
 * 解析图片分辨率
 *
 * @returns 解析成功返回宽高；格式不支持或 header 损坏返回 null（不抛异常）
 */
export function getImageDimensions(buffer: Buffer): ImageDimensions | null {
  try {
    const parsed =
      parsePng(buffer) ??
      parseJpeg(buffer) ??
      parseGif(buffer) ??
      parseWebp(buffer)

    if (!parsed) return null
    // 宽高必须是正整数，否则视为解析失败
    if (
      !Number.isInteger(parsed.width) ||
      !Number.isInteger(parsed.height) ||
      parsed.width <= 0 ||
      parsed.height <= 0
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}
