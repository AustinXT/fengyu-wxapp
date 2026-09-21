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
  /** 动图（多帧 GIF / WebP ANIM）。帧数会成倍放大解码开销，调用方应拒绝 */
  animated?: boolean
}

/**
 * PNG：8 字节签名 + IHDR，宽高为 big-endian uint32
 *
 * 签名校验完整 8 字节（含 \r\n\x1a\n），并核对 IHDR 声明长度必须为 13：
 * 只比对前 4 字节的话，`\x89PNG` + 乱码 + 伪造的 IHDR 布局也能读出尺寸，
 * 让无法解码的坏图入库。
 */
function parsePng(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24) return null
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  if (buf.readUInt32BE(4) !== 0x0d0a1a0a) return null
  if (buf.readUInt32BE(8) !== 13) return null // IHDR chunk 数据长度固定 13
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * GIF：GIF87a / GIF89a，逻辑屏幕宽高为 little-endian uint16
 *
 * 只有 10 字节的截断 GIF 也能读出宽高，故要求至少含完整 LSD(13 字节)。
 * 同时扫描 Image Descriptor(0x2C) 计数判断是否多帧动图。
 */
function parseGif(buf: Buffer): ImageDimensions | null {
  if (buf.length < 13) return null
  const sig = buf.toString("ascii", 0, 6)
  if (sig !== "GIF87a" && sig !== "GIF89a") return null
  return {
    width: buf.readUInt16LE(6),
    height: buf.readUInt16LE(8),
    animated: isAnimatedGif(buf),
  }
}

/**
 * 粗判 GIF 是否多帧：数 Image Descriptor(0x2C) 出现次数。
 * 这里只做保守的上界估计——宁可把单帧误判成动图被拒，也不放过数百帧的动图
 * （1000×1000 的 300 帧 GIF 只有 1MP，按像素积校验会放行，但解码开销是百 MB 级）。
 */
function isAnimatedGif(buf: Buffer): boolean {
  let frames = 0
  // 从 LSD 之后开始扫；上限防止超大文件拖慢上传
  const limit = Math.min(buf.length, 2 * 1024 * 1024)
  for (let i = 13; i < limit; i++) {
    if (buf[i] === 0x2c) {
      frames++
      if (frames > 1) return true
    }
  }
  return false
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
    // 段长越界（截断上传、或第三方工具写坏 APPn 长度）时直接判定失败。
    // 不能继续扫描：跳进垃圾字节后可能恰好撞上 0xFFCn 字节序列，读出一个「合法」的错误小尺寸，
    // 那会让真正的超大图通过校验——比返回 null 更危险。
    if (offset + 2 + segmentLength > buf.length) return null
    offset += 2 + segmentLength
  }
  return null
}

/**
 * WebP：RIFF....WEBP 后接 VP8 / VP8L / VP8X 三种 chunk，宽高编码各不相同。
 * 三个分支都校验各自的签名/长度，避免只按固定偏移读就接受坏图。
 */
function parseWebp(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30) return null
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null
  if (buf.toString("ascii", 8, 12) !== "WEBP") return null

  const format = buf.toString("ascii", 12, 16)

  if (format === "VP8 ") {
    // 有损：关键帧 start code 必须是 9d 01 2a
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    }
  }

  if (format === "VP8L") {
    // 无损：1 字节 signature 必须是 0x2f
    if (buf[20] !== 0x2f) return null
    const bits = buf.readUInt32LE(21)
    // bits 可能 ≥ 2^31，`>>` 经 ToInt32 会变负数做算术右移，
    // 但随后的 & 0x3fff 按补码恰好取回低 14 位真值，故结果正确。
    // 勿「修复」成 >>>：当前写法与 libwebp 行为一致。
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    }
  }

  if (format === "VP8X") {
    // 扩展：chunk 数据长度固定 10；flags 的 bit1 为 ANIMATION
    if (buf.readUInt32LE(16) !== 10) return null
    const animated = (buf[20] & 0x02) !== 0
    // 24 位宽/高，-1 存储
    const width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1
    const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1
    return { width, height, animated }
  }

  return null
}

/**
 * 解析图片分辨率
 *
 * @returns 解析成功返回宽高；格式不支持或 header 损坏返回 null（不抛异常）
 */
export function getImageDimensions(buffer: Buffer): ImageDimensions | null {
  // try/catch 是纯兜底：四个 parser 各自已在开头做长度校验，当前没有已知的抛出路径。
  // 留着是因为调用方（上传接口）宁可判定「解析失败 → 拒绝」，也不该因解析器异常整个 500。
  try {
    const parsed =
      parsePng(buffer) ??
      parseJpeg(buffer) ??
      parseGif(buffer) ??
      parseWebp(buffer)

    if (!parsed) return null
    // 宽高为 0 的畸形 header（readUIntXX 恒返回非负整数，无需再判整数性）
    if (parsed.width <= 0 || parsed.height <= 0) return null
    return parsed
  } catch {
    return null
  }
}
