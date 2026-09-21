import { describe, it, expect } from "vitest"
import { getImageDimensions } from "../image-dimensions"

/** 构造 PNG：签名 + IHDR（宽高 big-endian uint32） */
function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  buf.writeUInt32BE(0x89504e47, 0)
  buf.writeUInt32BE(0x0d0a1a0a, 4)
  buf.writeUInt32BE(13, 8)
  buf.write("IHDR", 12, "ascii")
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

/** 构造 GIF89a：逻辑屏幕宽高 little-endian uint16 */
function makeGif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(10)
  buf.write("GIF89a", 0, "ascii")
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return buf
}

/** 构造 JPEG：SOI + 一个无关 APP0 段 + SOF0 段 */
function makeJpeg(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(20)
  app0.writeUInt16BE(0xffe0, 0)
  app0.writeUInt16BE(16, 2) // 段长（不含 marker 自身 2 字节）
  app0.write("JFIF\0", 4, "ascii")

  const sof = Buffer.alloc(11)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(11, 2)
  sof.writeUInt8(8, 4) // precision
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)

  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])
}

/** 构造 WebP VP8X（扩展格式，24 位宽高，-1 存储） */
function makeWebpVp8x(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30)
  buf.write("RIFF", 0, "ascii")
  buf.writeUInt32LE(22, 4)
  buf.write("WEBP", 8, "ascii")
  buf.write("VP8X", 12, "ascii")
  buf.writeUInt32LE(10, 16)
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

describe("getImageDimensions", () => {
  it("解析 PNG", () => {
    expect(getImageDimensions(makePng(800, 600))).toEqual({
      width: 800,
      height: 600,
    })
  })

  it("解析 GIF", () => {
    expect(getImageDimensions(makeGif(320, 240))).toEqual({
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

  it("解析 WebP VP8X", () => {
    expect(getImageDimensions(makeWebpVp8x(1920, 1080))).toEqual({
      width: 1920,
      height: 1080,
    })
  })

  it("还原 issue #213 的肇事图尺寸：12576×12575", () => {
    const dim = getImageDimensions(makePng(12576, 12575))
    expect(dim).toEqual({ width: 12576, height: 12575 })
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
})
