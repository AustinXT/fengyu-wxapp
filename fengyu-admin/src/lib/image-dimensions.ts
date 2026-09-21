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
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    // APNG 靠 acTL chunk 声明动画。不查的话，40MP canvas × 数百帧的 APNG
    // 四项检查全过（animated 未置位、像素积压线、单边压线），绕过动图拒绝。
    // 这里用整块搜索做粗上界——方向是误拒而非误放。
    animated: buf.includes("acTL", 8, "ascii"),
  }
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

  const scan = scanGifBlocks(buf)
  // 单帧的 Image Descriptor 矩形可以声明得比逻辑屏幕(LSD)还大
  // （LSD 100×100 而帧 65535×65535，LZW 高压缩下文件很小）。
  // 规范要求解码器裁剪到逻辑屏幕，但这里按 fail-closed 取两者较大值。
  return {
    width: Math.max(buf.readUInt16LE(6), scan.frameWidth),
    height: Math.max(buf.readUInt16LE(8), scan.frameHeight),
    animated: scan.animated,
  }
}

interface GifScan {
  animated: boolean
  /** 各帧 Image Descriptor 声明的最大宽度（可能大于逻辑屏幕） */
  frameWidth: number
  frameHeight: number
}

/**
 * 按块结构遍历 GIF，统计真实帧数并取各帧声明的最大尺寸。
 *
 * 必须按块遍历，不能直接扫 0x2C 字节：0x2C 在调色板和 LZW 压缩数据里会随机出现
 * （约 1/256 每字节），那样任何上千字节的**静态** GIF 都会被误判成动图。
 * 也不能只扫前 N 字节：帧之前可以合法地塞进任意大的 Comment Extension。
 *
 * 结构：LSD(13B) → [全局颜色表] → 循环 { 0x21 扩展块 | 0x2C 图像块 | 0x3B 结束 }
 * 解析不下去（截断/畸形）时判定为动图，方向 fail-closed：宁可误拒也不放过多帧图。
 */
function scanGifBlocks(buf: Buffer): GifScan {
  const bail: GifScan = { animated: true, frameWidth: 0, frameHeight: 0 }
  let offset = 13

  // 全局颜色表：packed 的最高位标记存在，低 3 位决定表大小
  const packed = buf[10]
  if (packed & 0x80) {
    offset += 3 * (1 << ((packed & 0x07) + 1))
  }

  let frames = 0
  let frameWidth = 0
  let frameHeight = 0

  while (offset < buf.length) {
    const block = buf[offset]

    // Trailer：正常结束
    if (block === 0x3b) {
      return { animated: frames > 1, frameWidth, frameHeight }
    }

    if (block === 0x21) {
      // 扩展块：1B 引导 + 1B label + 若干 sub-block
      offset = skipGifSubBlocks(buf, offset + 2)
      if (offset < 0) return bail
      continue
    }

    if (block === 0x2c) {
      frames++
      // Image Descriptor 共 10 字节：left/top/width/height 各 2B + packed 1B
      if (offset + 10 > buf.length) return bail
      frameWidth = Math.max(frameWidth, buf.readUInt16LE(offset + 5))
      frameHeight = Math.max(frameHeight, buf.readUInt16LE(offset + 7))

      const localPacked = buf[offset + 9]
      offset += 10
      if (localPacked & 0x80) {
        offset += 3 * (1 << ((localPacked & 0x07) + 1))
      }
      offset += 1 // LZW minimum code size
      offset = skipGifSubBlocks(buf, offset)
      if (offset < 0) return bail
      continue
    }

    // 遇到无法识别的块，结构已不可信
    return bail
  }

  return { animated: frames > 1, frameWidth, frameHeight }
}

/**
 * 跳过一串 GIF sub-block（每块 1 字节长度 + 数据，0 长度结束）
 * @returns 结束后的 offset；越界/畸形返回 -1
 */
function skipGifSubBlocks(buf: Buffer, start: number): number {
  let offset = start
  while (offset < buf.length) {
    const size = buf[offset]
    if (size === 0) return offset + 1
    offset += size + 1
  }
  return -1
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

    // VP8X 是本组格式里唯一「容器声明与实际负载可分离」的：
    // canvas 可以声明 100×100 而内嵌帧其实是 16000×16000。若解码端按帧尺寸分配位图，
    // 只信 canvas 就会读小放行。故取 canvas 与内嵌帧的较大者。
    const frame = parseWebpFrameAfterVp8x(buf)
    // 结构不可信时必须整体判定失败：若退回 canvas 尺寸，等于用一个小尺寸放行了
    // 一个我们根本没能力确认的容器
    if (frame === "invalid") return null
    return {
      width: Math.max(width, frame?.width ?? 0),
      height: Math.max(height, frame?.height ?? 0),
      animated,
    }
  }

  return null
}

/**
 * 在 VP8X 之后按 chunk 链找首个 VP8 / VP8L 帧，读它自己声明的尺寸。
 *
 * 三种返回值必须区分开：
 * - `ImageDimensions`：找到帧，用它的尺寸
 * - `null`：chunk 链走完但没有帧（合法，交由 canvas 尺寸兜底）
 * - `"invalid"`：结构不可信（声明长度越界、帧头放不下等），调用方必须整体判定失败
 */
function parseWebpFrameAfterVp8x(
  buf: Buffer
): ImageDimensions | "invalid" | null {
  // RIFF(12) + VP8X header(8) + VP8X payload(10) = 30
  let offset = 30

  while (offset + 8 <= buf.length) {
    const chunkType = buf.toString("ascii", offset, offset + 4)
    const chunkSize = buf.readUInt32LE(offset + 4)
    const body = offset + 8

    // payload 必须严格落在 buffer 内，否则结构不可信
    if (body + chunkSize > buf.length) return "invalid"

    if (chunkType === "VP8 ") {
      // 帧头字段必须在本 chunk 声明的长度之内，不能跨界读进下一个 chunk
      if (chunkSize < 10) return "invalid"
      if (buf[body + 3] !== 0x9d || buf[body + 4] !== 0x01 || buf[body + 5] !== 0x2a) {
        return "invalid"
      }
      return {
        width: buf.readUInt16LE(body + 6) & 0x3fff,
        height: buf.readUInt16LE(body + 8) & 0x3fff,
      }
    }

    if (chunkType === "VP8L") {
      if (chunkSize < 5) return "invalid"
      if (buf[body] !== 0x2f) return "invalid"
      const bits = buf.readUInt32LE(body + 1)
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      }
    }

    // chunk 按偶数字节对齐
    const advance = 8 + chunkSize + (chunkSize % 2)
    if (advance <= 8) return "invalid" // 防御：非递增即判定结构不可信
    offset += advance
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
