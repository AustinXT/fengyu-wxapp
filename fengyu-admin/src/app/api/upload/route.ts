import { NextRequest, NextResponse } from "next/server"
import { jwtVerify } from "jose"
import { uploadFile } from "@/lib/cloudbase"
import { JWT_SECRET } from "@/lib/jwt-secret"
import { getImageDimensions } from "@/lib/image-dimensions"

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]
const MAX_SIZE_DEFAULT = 5 * 1024 * 1024 // 5MB
const MAX_SIZE_FENGYUGUAN = 20 * 1024 * 1024 // 20MB（凤御馆超长宣传图专用）
const FENGYUGUAN_KEY = "images/fengyuguan.jpg"

/**
 * 像素总数上限（issue #213）
 *
 * 体积校验拦不住高压缩率的大分辨率图：生产上传过 405KB 的 12576×12575 PNG（约 1.58 亿像素），
 * 顾客端小程序解码时吃掉约 603MB 内存导致进程被杀。小程序端的解码开销只跟像素数相关，
 * 所以这里按像素数把关。
 *
 * 40MP（约 8000×5000）对正常门店/商品照片足够宽松（实测商品图 2083×1333 ≈ 2.8MP），
 * 又能拦住上面那种异常图。
 */
const MAX_PIXELS = 40_000_000

const COOKIE_NAME = 'fy-admin-token'

export async function POST(req: NextRequest) {
  // 认证校验
  const token = req.cookies.get(COOKIE_NAME)?.value
  if (!token) {
    return NextResponse.json({ error: "未授权" }, { status: 401 })
  }
  try {
    await jwtVerify(token, JWT_SECRET)
  } catch {
    return NextResponse.json({ error: "令牌无效或已过期" }, { status: 401 })
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
      const ext = file.name.split(".").pop() || "jpg"
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

    // 分辨率校验：仅对 path 模式（门店/商品封面等）生效。
    // exactKey 模式是 banner 与凤御馆超长宣传图，形态特殊且有独立体积上限，不在此设限。
    if (!exactKey) {
      const dimensions = getImageDimensions(buffer)
      if (dimensions && dimensions.width * dimensions.height > MAX_PIXELS) {
        return NextResponse.json(
          {
            error:
              `图片分辨率过大（${dimensions.width}×${dimensions.height}），` +
              `请压缩到 ${MAX_PIXELS / 1_000_000}MP 以内再上传。` +
              `分辨率过大的图片会导致小程序端加载时闪退。`,
          },
          { status: 400 }
        )
      }
    }

    const url = await uploadFile(buffer, cloudPath)

    return NextResponse.json({ url })
  } catch (err) {
    console.error("Upload error:", err)
    return NextResponse.json({ error: "上传失败" }, { status: 500 })
  }
}
