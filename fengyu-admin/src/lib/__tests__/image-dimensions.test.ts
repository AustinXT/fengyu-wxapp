import { describe, it, expect } from "vitest"
import { getImageDimensions } from "../image-dimensions"

/**
 * 构造 PNG：8 字节签名 + 完整 IHDR chunk
 * （长度 4 + 类型 4 + 数据 13 + CRC 4 = 25，合计 33 字节）
 */
function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33)
  buf.writeUInt32BE(0x89504e47, 0)
  buf.writeUInt32BE(0x0d0a1a0a, 4)
  buf.writeUInt32BE(13, 8)
  buf.write("IHDR", 12, "ascii")
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  buf.writeUInt8(8, 24) // bit depth
  buf.writeUInt8(6, 25) // color type
  return buf
}

/**
 * 构造 GIF89a：完整 Logical Screen Descriptor（13 字节）
 * @param frames 追加的 Image Descriptor(0x2C) 个数，>1 即视为动图
 */
function makeGif(width: number, height: number, frames = 1): Buffer {
  const lsd = Buffer.alloc(13)
  lsd.write("GIF89a", 0, "ascii")
  lsd.writeUInt16LE(width, 6)
  lsd.writeUInt16LE(height, 8)
  lsd[10] = 0x00 // packed: 无全局调色板
  lsd[11] = 0x00 // 背景色索引
  lsd[12] = 0x00 // 像素宽高比

  const blocks: Buffer[] = [lsd]
  for (let i = 0; i < frames; i++) {
    // Image Descriptor(10B，末字节 packed=0 表示无局部调色板)
    const desc = Buffer.alloc(10)
    desc[0] = 0x2c
    blocks.push(desc)
    // LZW min code size + 一个 sub-block + 结束标记
    blocks.push(Buffer.from([0x08, 0x02, 0x4c, 0x2c, 0x00]))
  }
  blocks.push(Buffer.from([0x3b])) // trailer
  return Buffer.concat(blocks)
}

/**
 * 单帧 GIF，但 LZW 数据里含多个 0x2C 字节。
 * 直接扫 0x2C 的实现会把它误判成动图——而真实静态 GIF 几乎必然含这种字节。
 */
function makeStaticGifWithNoisyData(width: number, height: number): Buffer {
  const lsd = Buffer.alloc(13)
  lsd.write("GIF89a", 0, "ascii")
  lsd.writeUInt16LE(width, 6)
  lsd.writeUInt16LE(height, 8)

  const desc = Buffer.alloc(10)
  desc[0] = 0x2c

  // 一个 sub-block，数据里塞满 0x2C
  const payload = Buffer.alloc(32, 0x2c)
  const dataBlocks = Buffer.concat([
    Buffer.from([0x08]), // LZW min code size
    Buffer.from([payload.length]),
    payload,
    Buffer.from([0x00]), // sub-block 结束
  ])

  return Buffer.concat([lsd, desc, dataBlocks, Buffer.from([0x3b])])
}

/** PNG + acTL chunk（APNG）。acTL 必须出现在 IDAT 之前 */
function makeApng(width: number, height: number): Buffer {
  const actl = Buffer.alloc(20)
  actl.writeUInt32BE(8, 0)
  actl.write("acTL", 4, "ascii")
  actl.writeUInt32BE(3, 8) // 帧数
  actl.writeUInt32BE(0, 12) // 循环次数
  return Buffer.concat([makePng(width, height), actl, makeIdat()])
}

/** 最小 IDAT chunk */
function makeIdat(): Buffer {
  const idat = Buffer.alloc(12)
  idat.writeUInt32BE(0, 0)
  idat.write("IDAT", 4, "ascii")
  return idat
}

/** 静态 PNG，但 tEXt 数据里含 "acTL" 四个字节 */
function makePngWithActlBytes(width: number, height: number): Buffer {
  const text = Buffer.alloc(12 + 8)
  text.writeUInt32BE(8, 0)
  text.write("tEXt", 4, "ascii")
  text.write("xxacTLyy", 8, "ascii")
  return Buffer.concat([makePng(width, height), text, makeIdat()])
}

/**
 * VP8X 声明一个 canvas 尺寸，内嵌 VP8 帧却是另一个（更大的）尺寸。
 * @param extraChunk 在帧之前插入一个奇数长度的 metadata chunk，用于验证 padding 对齐
 */
function makeWebpVp8xWithFrame(
  canvasW: number,
  canvasH: number,
  frameW: number,
  frameH: number,
  extraChunk = false,
  animated = false
): Buffer {
  const head = makeWebpVp8xHeader(canvasW, canvasH, animated)

  const parts: Buffer[] = [head]
  if (extraChunk) {
    // 奇数长度 chunk（3 字节）必须补 1 字节 padding
    const meta = Buffer.alloc(8 + 3 + 1)
    meta.write("EXIF", 0, "ascii")
    meta.writeUInt32LE(3, 4)
    parts.push(meta)
  }

  const chunk = Buffer.alloc(8 + 10)
  chunk.write("VP8 ", 0, "ascii")
  chunk.writeUInt32LE(10, 4)
  chunk[8 + 3] = 0x9d
  chunk[8 + 4] = 0x01
  chunk[8 + 5] = 0x2a
  chunk.writeUInt16LE(frameW, 8 + 6)
  chunk.writeUInt16LE(frameH, 8 + 8)
  parts.push(chunk)

  const out = Buffer.concat(parts)
  // 修正 RIFF 声明长度（= 文件总长 - 8）
  out.writeUInt32LE(out.length - 8, 4)
  return out
}

/** 构造 JPEG：SOI + 一个无关 APP0 段 + SOF0 段 */
function makeJpeg(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(20)
  app0.writeUInt16BE(0xffe0, 0)
  app0.writeUInt16BE(16, 2) // 段长（不含 marker 自身 2 字节）
  app0.write("JFIF\0", 4, "ascii")

  // SOF0：marker(2) + length(2) + precision(1) + height(2) + width(2)
  //        + 组件数(1) + 组件描述(3) = 13 字节，length 字段计为 11
  const sof = Buffer.alloc(13)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(11, 2)
  sof.writeUInt8(8, 4) // precision
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof.writeUInt8(1, 9) // 组件数
  sof.writeUInt8(1, 10) // 组件 id
  sof.writeUInt8(0x11, 11) // 采样因子
  sof.writeUInt8(0, 12) // 量化表 id

  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])
}

/**
 * 只构造 VP8X 头部（30 字节，无图像负载）。
 * 真实的静态 VP8X 文件必须再跟一个 VP8/VP8L chunk，见 makeWebpVp8x。
 * @param animated 置 flags 的 ANIMATION 位
 */
function makeWebpVp8xHeader(
  width: number,
  height: number,
  animated = false
): Buffer {
  const buf = Buffer.alloc(30)
  buf.write("RIFF", 0, "ascii")
  buf.writeUInt32LE(22, 4)
  buf.write("WEBP", 8, "ascii")
  buf.write("VP8X", 12, "ascii")
  buf.writeUInt32LE(10, 16) // VP8X chunk 数据长度固定 10
  buf[20] = animated ? 0x02 : 0x00 // flags: bit1 = ANIMATION
  const w = width - 1
  const h = height - 1
  buf[24] = w & 0xff
  buf[25] = (w >> 8) & 0xff
  buf[26] = (w >> 16) & 0xff
  buf[27] = h & 0xff
  buf[28] = (h >> 8) & 0xff
  buf[29] = (h >> 16) & 0xff
  return buf
}

/** 完整的静态 VP8X 文件：头部 + 与 canvas 同尺寸的 VP8 帧 */
function makeWebpVp8x(
  width: number,
  height: number,
  animated = false
): Buffer {
  // VP8 帧尺寸字段是 14 位，最大 16383
  const frameW = Math.min(width, 16383)
  const frameH = Math.min(height, 16383)
  return makeWebpVp8xWithFrame(width, height, frameW, frameH, false, animated)
}

/** 构造 WebP VP8（有损，含 9d 01 2a start code） */
function makeWebpVp8(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30)
  buf.write("RIFF", 0, "ascii")
  buf.writeUInt32LE(22, 4)
  buf.write("WEBP", 8, "ascii")
  buf.write("VP8 ", 12, "ascii")
  buf.writeUInt32LE(10, 16)
  buf[23] = 0x9d
  buf[24] = 0x01
  buf[25] = 0x2a
  buf.writeUInt16LE(width, 26)
  buf.writeUInt16LE(height, 28)
  return buf
}

/** 构造 WebP VP8L（无损，signature 0x2f + 位域打包的宽高） */
function makeWebpVp8l(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30)
  buf.write("RIFF", 0, "ascii")
  buf.writeUInt32LE(22, 4)
  buf.write("WEBP", 8, "ascii")
  buf.write("VP8L", 12, "ascii")
  buf.writeUInt32LE(10, 16)
  buf[20] = 0x2f
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  buf.writeUInt32LE(bits >>> 0, 21)
  return buf
}

describe("getImageDimensions", () => {
  it("解析 PNG", () => {
    expect(getImageDimensions(makePng(800, 600))).toMatchObject({
      width: 800,
      height: 600,
    })
  })

  it("解析 GIF", () => {
    expect(getImageDimensions(makeGif(320, 240))).toMatchObject({
      width: 320,
      height: 240,
    })
  })

  it("解析 JPEG（需跳过前置 APP0 段找到 SOF0）", () => {
    expect(getImageDimensions(makeJpeg(2083, 1333))).toEqual({
      width: 2083,
      height: 1333,
    })
  })

  it("解析 WebP 三种子格式", () => {
    expect(getImageDimensions(makeWebpVp8x(1920, 1080))).toMatchObject({
      width: 1920,
      height: 1080,
    })
    expect(getImageDimensions(makeWebpVp8(800, 600))).toMatchObject({
      width: 800,
      height: 600,
    })
    expect(getImageDimensions(makeWebpVp8l(1024, 768))).toMatchObject({
      width: 1024,
      height: 768,
    })
  })

  /**
   * 动图的解码开销是「单帧 × 帧数」，像素积完全代表不了：
   * 1000×1000 的 300 帧 GIF 只有 1MP，却能吃掉百 MB 级内存。
   */
  describe("动图识别（像素积校验覆盖不到的绕过路径）", () => {
    it("多帧 GIF 标记为 animated", () => {
      expect(getImageDimensions(makeGif(1000, 1000, 300))).toMatchObject({
        width: 1000,
        height: 1000,
        animated: true,
      })
    })

    it("单帧 GIF 不标记 animated", () => {
      expect(getImageDimensions(makeGif(1000, 1000, 1))).toMatchObject({
        animated: false,
      })
    })

    /**
     * 0x2C 在调色板和 LZW 数据里会随机出现（约 1/256 每字节）。
     * 若靠裸扫 0x2C 判定，任何上千字节的静态 GIF 都会被误拒。
     */
    it("LZW 数据含大量 0x2C 的静态 GIF 不被误判为动图", () => {
      expect(
        getImageDimensions(makeStaticGifWithNoisyData(800, 600))
      ).toMatchObject({ width: 800, height: 600, animated: false })
    })

    /**
     * codex 第二轮构造：合法的两帧 GIF，但在帧之前塞 2.1MiB 的 Comment Extension。
     * 任何「只扫前 N 字节」的实现都会漏判（ImageMagick 识别为 2 帧）。
     * 按块遍历不受文件大小影响，必须命中。
     */
    it("帧前有 2.1MiB Comment Extension 的两帧 GIF 仍被识别", () => {
      const lsd = Buffer.alloc(13)
      lsd.write("GIF89a", 0, "ascii")
      lsd.writeUInt16LE(1, 6)
      lsd.writeUInt16LE(1, 8)

      // Comment Extension：0x21 0xFE + 若干 255 字节 sub-block + 0x00
      const subBlocks: Buffer[] = [Buffer.from([0x21, 0xfe])]
      const chunk = Buffer.alloc(255, 0x41)
      for (let i = 0; i < 8400; i++) {
        subBlocks.push(Buffer.from([255]), chunk)
      }
      subBlocks.push(Buffer.from([0x00]))
      const comment = Buffer.concat(subBlocks)

      const frame = Buffer.concat([
        Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
        Buffer.from([0x08, 0x01, 0x00, 0x00]),
      ])

      const gif = Buffer.concat([
        lsd,
        comment,
        frame,
        frame,
        Buffer.from([0x3b]),
      ])

      expect(gif.length).toBeGreaterThan(2 * 1024 * 1024)
      expect(getImageDimensions(gif)).toMatchObject({ animated: true })
    })

    /**
     * 反向：单帧 GIF 的 Comment Extension 里含两个 ASCII 逗号（0x2C）。
     * 裸扫字节的实现会误判成动图，按块遍历则不会。
     */
    it("Comment Extension 内含 0x2C 的单帧 GIF 不被误判", () => {
      const lsd = Buffer.alloc(13)
      lsd.write("GIF89a", 0, "ascii")
      lsd.writeUInt16LE(640, 6)
      lsd.writeUInt16LE(480, 8)

      const comment = Buffer.from([0x21, 0xfe, 0x02, 0x2c, 0x2c, 0x00])
      const frame = Buffer.concat([
        Buffer.from([0x2c, 0, 0, 0, 0, 0x80, 0x02, 0xe0, 0x01, 0x00]),
        Buffer.from([0x08, 0x01, 0x00, 0x00]),
      ])

      expect(
        getImageDimensions(
          Buffer.concat([lsd, comment, frame, Buffer.from([0x3b])])
        )
      ).toMatchObject({ width: 640, height: 480, animated: false })
    })

    /**
     * 单帧 GIF 的 Image Descriptor 矩形可以声明得比逻辑屏幕大
     * （LSD 100×100 而帧 65535×65535，LZW 高压缩下文件很小），
     * 只校验 LSD 会让它四道检查全过。
     */
    /**
     * 帧可以带 left/top 偏移。按「帧覆盖区域」分配位图的解码器需要 left+width 那么大，
     * 只取帧自身 width/height 仍会读小。
     */
    it("帧带 left/top 偏移时按覆盖区域判定", () => {
      const lsd = Buffer.alloc(13)
      lsd.write("GIF89a", 0, "ascii")
      lsd.writeUInt16LE(100, 6)
      lsd.writeUInt16LE(100, 8)

      const desc = Buffer.alloc(10)
      desc[0] = 0x2c
      desc.writeUInt16LE(60000, 1) // left
      desc.writeUInt16LE(60000, 3) // top
      desc.writeUInt16LE(5535, 5) // width
      desc.writeUInt16LE(5535, 7) // height

      const gif = Buffer.concat([
        lsd,
        desc,
        Buffer.from([0x08, 0x01, 0x00, 0x00]),
        Buffer.from([0x3b]),
      ])

      expect(getImageDimensions(gif)).toMatchObject({
        width: 65535,
        height: 65535,
      })
    })

    it("帧矩形大于逻辑屏幕时按较大者判定", () => {
      const lsd = Buffer.alloc(13)
      lsd.write("GIF89a", 0, "ascii")
      lsd.writeUInt16LE(100, 6)
      lsd.writeUInt16LE(100, 8)

      const desc = Buffer.alloc(10)
      desc[0] = 0x2c
      desc.writeUInt16LE(65535, 5)
      desc.writeUInt16LE(65535, 7)

      const gif = Buffer.concat([
        lsd,
        desc,
        Buffer.from([0x08, 0x01, 0x00, 0x00]),
        Buffer.from([0x3b]),
      ])

      const dim = getImageDimensions(gif)
      expect(dim).toMatchObject({ width: 65535, height: 65535 })
      expect(dim!.width * dim!.height).toBeGreaterThan(40_000_000)
    })

    it("APNG 被识别为动图（acTL chunk）", () => {
      expect(getImageDimensions(makeApng(4000, 4000))).toMatchObject({
        width: 4000,
        height: 4000,
        animated: true,
      })
    })

    it("普通 PNG 不被误判为 APNG", () => {
      expect(getImageDimensions(makePng(4000, 4000))).toMatchObject({
        animated: false,
      })
    })

    /**
     * 整块搜 "acTL" 字节会把 tEXt/iTXt/IDAT 里碰巧出现这四个字节的合法静态 PNG
     * 误判成动图拒绝，必须按 chunk 结构遍历。
     */
    it("tEXt 数据含 acTL 字节的静态 PNG 不被误判", () => {
      expect(
        getImageDimensions(makePngWithActlBytes(800, 600))
      ).toMatchObject({ width: 800, height: 600, animated: false })
    })

    it("WebP ANIM 标志位被识别", () => {
      expect(getImageDimensions(makeWebpVp8x(800, 600, true))).toMatchObject({
        animated: true,
      })
      expect(getImageDimensions(makeWebpVp8x(800, 600, false))).toMatchObject({
        animated: false,
      })
    })
  })

  /**
   * 只按固定偏移读、不校验容器签名的话，坏图也能读出尺寸并入库。
   */
  describe("容器完整性校验（截断/伪造 header 必须判定失败）", () => {
    it("PNG 缺少完整 8 字节签名", () => {
      const buf = makePng(800, 600)
      buf.writeUInt32BE(0xdeadbeef, 4) // 破坏 \r\n\x1a\n
      expect(getImageDimensions(buf)).toBeNull()
    })

    it("PNG 的 IHDR 声明长度不是 13", () => {
      const buf = makePng(800, 600)
      buf.writeUInt32BE(99, 8)
      expect(getImageDimensions(buf)).toBeNull()
    })

    it("GIF 截断到 10 字节（LSD 不完整）", () => {
      expect(getImageDimensions(makeGif(320, 240).subarray(0, 10))).toBeNull()
    })

    it("WebP VP8 缺少 9d 01 2a start code", () => {
      const buf = makeWebpVp8(800, 600)
      buf[23] = 0x00
      expect(getImageDimensions(buf)).toBeNull()
    })

    it("WebP VP8L 签名不是 0x2f", () => {
      const buf = makeWebpVp8l(1024, 768)
      buf[20] = 0x00
      expect(getImageDimensions(buf)).toBeNull()
    })

    it("WebP VP8X chunk 长度不是 10", () => {
      const buf = makeWebpVp8x(1920, 1080)
      buf.writeUInt32LE(99, 16)
      expect(getImageDimensions(buf)).toBeNull()
    })

    /**
     * 静态 VP8X 必须含一个 VP8/VP8L 图像负载，不存在「只有 canvas 没有帧」的合法静态图。
     * 退回 canvas 尺寸等于用一个小尺寸放行了没能力确认的容器。
     */
    it("VP8X 只有头部没有图像负载时判定失败", () => {
      expect(getImageDimensions(makeWebpVp8xHeader(100, 100))).toBeNull()
    })

    /**
     * VP8X 是唯一「容器声明与实际负载可分离」的格式：canvas 可以声明 100×100
     * 而内嵌帧其实是 16000×16000。只信 canvas 就会读小放行。
     */
    it("VP8X canvas 小于内嵌帧时取较大者，不被读小放行", () => {
      const dim = getImageDimensions(
        makeWebpVp8xWithFrame(100, 100, 16000, 16000)
      )
      expect(dim).toMatchObject({ width: 16000, height: 16000 })
      expect(dim!.width * dim!.height).toBeGreaterThan(40_000_000)
    })

    it("VP8X canvas 大于内嵌帧时仍以 canvas 为准", () => {
      expect(
        getImageDimensions(makeWebpVp8xWithFrame(8000, 8000, 100, 100))
      ).toMatchObject({ width: 8000, height: 8000 })
    })

    it("帧前有奇数长度 metadata chunk 时 padding 对齐仍能找到帧", () => {
      expect(
        getImageDimensions(makeWebpVp8xWithFrame(100, 100, 9000, 9000, true))
      ).toMatchObject({ width: 9000, height: 9000 })
    })

    it("chunk 声明长度越界时判定失败，不退回小 canvas 放行", () => {
      const buf = makeWebpVp8xWithFrame(100, 100, 16000, 16000)
      // 把 VP8 chunk 的声明长度改成远超剩余字节
      buf.writeUInt32LE(99999, 34)
      expect(getImageDimensions(buf)).toBeNull()
    })

    it("VP8 chunk 声明长度不足以容纳帧头时判定失败", () => {
      const buf = makeWebpVp8xWithFrame(100, 100, 16000, 16000)
      buf.writeUInt32LE(4, 34) // < 10，放不下帧头
      expect(getImageDimensions(buf)).toBeNull()
    })
  })

  it("还原 issue #213 的肇事图尺寸：12576×12575", () => {
    const dim = getImageDimensions(makePng(12576, 12575))
    expect(dim).toMatchObject({ width: 12576, height: 12575 })
    // 这张图正是超过 40MP 上限、必须被拒的那一类
    expect(dim!.width * dim!.height).toBeGreaterThan(40_000_000)
  })

  it("正常门店/商品照片在 40MP 上限内，不会误伤", () => {
    const product = getImageDimensions(makeJpeg(2083, 1333))!
    expect(product.width * product.height).toBeLessThan(40_000_000)

    const dslr = getImageDimensions(makeJpeg(6000, 4000))!
    expect(dslr.width * dslr.height).toBeLessThan(40_000_000)
  })

  it("非图片 / 损坏 header 返回 null，不抛异常", () => {
    expect(getImageDimensions(Buffer.from("not an image at all"))).toBeNull()
    expect(getImageDimensions(Buffer.alloc(0))).toBeNull()
    expect(getImageDimensions(Buffer.from([0xff, 0xd8]))).toBeNull()
  })

  it("宽高为 0 的畸形 header 返回 null", () => {
    expect(getImageDimensions(makePng(0, 100))).toBeNull()
    expect(getImageDimensions(makeGif(100, 0))).toBeNull()
  })

  it("JPEG 段长非法时不会死循环", () => {
    const buf = Buffer.alloc(40)
    buf.writeUInt16BE(0xffd8, 0)
    buf.writeUInt16BE(0xffe0, 2)
    buf.writeUInt16BE(0, 4) // 非法段长
    expect(getImageDimensions(buf)).toBeNull()
  })

  /**
   * pr-ready P1：APPn 段声明的长度越界时，若继续扫描可能在垃圾字节里撞上假的 0xFFCn，
   * 读出一个「合法」的错误小尺寸，让真正的超大图通过 40MP 校验。
   * 必须判定失败（返回 null），再由调用侧 fail-closed 拒绝。
   */
  it("JPEG 段长越界时判定失败，不得误读出尺寸", () => {
    const sof = Buffer.alloc(11)
    sof.writeUInt16BE(0xffc0, 0)
    sof.writeUInt16BE(11, 2)
    sof.writeUInt8(8, 4)
    sof.writeUInt16BE(12575, 5)
    sof.writeUInt16BE(12576, 7)

    const app0 = Buffer.alloc(4)
    app0.writeUInt16BE(0xffe0, 0)
    app0.writeUInt16BE(60000, 2) // 声明 60000 字节，实际远不够

    const malformed = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])

    // 真实尺寸是超限的 12576×12575，但 header 畸形 → 必须返回 null 而不是某个小尺寸
    const dim = getImageDimensions(malformed)
    expect(dim).toBeNull()
  })

  it("JPEG 段长恰好贴到 buffer 末尾仍可正常解析", () => {
    const sof = Buffer.alloc(13)
    sof.writeUInt16BE(0xffc0, 0)
    sof.writeUInt16BE(11, 2)
    sof.writeUInt8(8, 4)
    sof.writeUInt16BE(600, 5)
    sof.writeUInt16BE(800, 7)
    sof.writeUInt8(1, 9)

    const app0 = Buffer.alloc(6)
    app0.writeUInt16BE(0xffe0, 0)
    app0.writeUInt16BE(4, 2) // 段长 4 = 2 字节长度字段 + 2 字节载荷，恰好不越界

    const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])
    expect(getImageDimensions(buf)).toEqual({ width: 800, height: 600 })
  })

  /**
   * SOF 自己的段长也要校验：尺寸字节必须落在本段内，否则读到的其实是段外数据。
   */
  it("SOF 段长不足以容纳尺寸字段时判定失败", () => {
    const sof = Buffer.alloc(13)
    sof.writeUInt16BE(0xffc0, 0)
    sof.writeUInt16BE(4, 2) // 段长 4，放不下 precision + height + width
    sof.writeUInt16BE(600, 5)
    sof.writeUInt16BE(800, 7)

    const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), sof])
    expect(getImageDimensions(buf)).toBeNull()
  })
})
