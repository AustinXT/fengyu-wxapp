import { NextRequest, NextResponse } from "next/server"
import { uploadFile } from "@/lib/cloudbase"
import { getSession } from "@/lib/auth"
import { getImageDimensions } from "@/lib/image-dimensions"

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]

/** 对象键扩展名由 MIME 决定，保证与顾客端 safeThumbUrl 的键格式白名单一致 */
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
}
const MAX_SIZE_DEFAULT = 5 * 1024 * 1024 // 5MB
const MAX_SIZE_FENGYUGUAN = 20 * 1024 * 1024 // 20MB（凤御馆超长宣传图专用）
const FENGYUGUAN_KEY = "images/fengyuguan.jpg"

/**
 * 分辨率上限（issue #213）
 *
 * 体积校验拦不住高压缩率的大分辨率图：生产上传过 405KB 的 12576×12575 PNG（约 1.58 亿像素），
 * 顾客端小程序解码时吃掉约 603MB 内存导致进程被杀。解码开销只跟像素数相关，故按像素数把关。
 *
 * 像素积与单边**两个**都要卡：只卡像素积挡不住细长图——一张 500×50000 只有 25MP 能过关，
 * 但它在任何只限宽的缩略规则下高度都不受约束，解码依然是几十 MB 级。
 *
 * 40MP（约 8000×5000）对正常门店/商品照片足够宽松（实测商品图 2083×1333 ≈ 2.8MP）。
 */
const MAX_PIXELS = 40_000_000
const MAX_EDGE = 12_000

/**
 * 凤御馆超长宣传图的独立上限。
 *
 * 它是极端长条图，生产实际为 2083×37403（约 77.9MP、单边 37403），套用通用上限会直接
 * 把现网这张图挡在门外。但**不能因此完全豁免校验**——那等于留一条无上界的上传通道。
 *
 * 阈值贴着现网实际尺寸留一档余量即可，不要放得更宽：`exactKey` 取自请求表单，
 * 任何已登录账号都能声明这个 key 来认领这组阈值，放得越宽被滥用的空间越大。
 * 顾客端 pages/cart 会用 wx.getImageInfo 拿真实宽高后按 imageMogr2 动态切条显示，
 * 不直接解码原图，所以这张图本身另有等效防护。
 */
const MAX_PIXELS_FENGYUGUAN = 90_000_000
const MAX_EDGE_FENGYUGUAN = 45_000

export async function POST(req: NextRequest) {
  /**
   * 认证走 `getSession()`（与 `/api/ocr/*` 两个路由一致），**不要**只 `jwtVerify` 签名（#318）。
   *
   * JWT 是无状态的、有效期 24h：只验签名的话，员工被标离职后凭手里那张旧 token 还能继续往
   * 对象存储写一整天。`getSession()` 会回库按 `is_resigned = false` 查人，离职后立即失效。
   * 这是本仓唯一一个绕开 `getSession()` 的写接口 —— middleware 在 edge 运行时连不了库，
   * 所以「离职即失效」这条只能落在 DB 回查这一层。
   */
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: "未授权" }, { status: 401 })
  }

  try {
    const formData = await req.formData()
    const file = formData.get("file") as File | null

    if (!file) {
      return NextResponse.json({ error: "缺少文件" }, { status: 400 })
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "不支持的文件类型，仅支持 JPG/PNG/WebP/GIF" },
        { status: 400 }
      )
    }

    // exactKey: use as-is; path: generate timestamped name under that path
    const exactKey = formData.get("exactKey") as string | null
    const pathPrefix = formData.get("path") as string | null

    // 凤御馆宣传图是超长品牌图，单独放宽到 20MB；其余维持 5MB
    const maxSize = exactKey === FENGYUGUAN_KEY ? MAX_SIZE_FENGYUGUAN : MAX_SIZE_DEFAULT
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: `文件大小不能超过 ${maxSize / 1024 / 1024}MB` },
        { status: 400 }
      )
    }

    let cloudPath: string
    if (exactKey) {
      cloudPath = exactKey
    } else if (pathPrefix) {
      // 扩展名按 MIME 映射，不照抄原文件名：合法的 image/jpeg 可能叫 .jfif / .jpe，
      // 照抄会生成顾客端 safeThumbUrl 不认的对象键，图片最终显示成占位图
      const ext = EXT_BY_MIME[file.type] ?? "jpg"
      const ts = Date.now()
      const rand = Math.random().toString(36).slice(2, 8)
      cloudPath = `${pathPrefix}/${ts}-${rand}.${ext}`
    } else {
      return NextResponse.json(
        { error: "需要提供 path 或 exactKey 参数" },
        { status: 400 }
      )
    }

    const buffer = Buffer.from(await file.arrayBuffer())

    // 分辨率校验。凤御馆长图走独立的宽松阈值，但同样受校验约束（不是豁免）。
    // banner 走的是 path 模式，适用通用阈值。
    const isFengyuguan = exactKey === FENGYUGUAN_KEY
    const maxPixels = isFengyuguan ? MAX_PIXELS_FENGYUGUAN : MAX_PIXELS
    const maxEdge = isFengyuguan ? MAX_EDGE_FENGYUGUAN : MAX_EDGE

    const dimensions = getImageDimensions(buffer)

    // fail-closed：解析不出尺寸一律拒绝，不能放行。
    // file.type 由客户端提供、可伪造，截断或畸形 header（例如 APPn 段声明长度越界、
    // 导致 SOF 被跳过）都会让解析返回 null；而微信解码器对畸形 header 的容忍度远高于
    // 这个最小解析器，放行等于给「本次要堵的那类图」留了后门。
    if (!dimensions) {
      return NextResponse.json(
        {
          error:
            "无法识别图片尺寸，可能文件已损坏或格式不受支持，请换一张图片或重新导出后上传。",
        },
        { status: 400 }
      )
    }

    // 动图的解码开销是「单帧 × 帧数」，像素积校验完全代表不了它：
    // 一张 1000×1000 的 300 帧 GIF 只有 1MP，却能吃掉百 MB 级内存。封面场景无动图需求。
    if (dimensions.animated) {
      return NextResponse.json(
        { error: "不支持动图（多帧 GIF / 动态 WebP），请上传静态图片。" },
        { status: 400 }
      )
    }

    if (dimensions.width * dimensions.height > maxPixels) {
      return NextResponse.json(
        {
          error:
            `图片分辨率过大（${dimensions.width}×${dimensions.height}），` +
            `请压缩到 ${Math.round(maxPixels / 1_000_000)}MP 以内再上传。` +
            `分辨率过大的图片会导致小程序端加载时闪退。`,
        },
        { status: 400 }
      )
    }

    // 细长图：像素积可能很小但单边极大，缩略后仍会吃掉大量解码内存
    if (dimensions.width > maxEdge || dimensions.height > maxEdge) {
      return NextResponse.json(
        {
          error:
            `图片单边尺寸过大（${dimensions.width}×${dimensions.height}），` +
            `宽和高都需在 ${maxEdge} 像素以内。过长或过宽的图片会导致小程序端加载时闪退。`,
        },
        { status: 400 }
      )
    }

    const url = await uploadFile(buffer, cloudPath)

    return NextResponse.json({ url })
  } catch (err) {
    console.error("Upload error:", err)
    return NextResponse.json({ error: "上传失败" }, { status: 500 })
  }
}
