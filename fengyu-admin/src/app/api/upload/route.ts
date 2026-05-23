import { NextRequest, NextResponse } from "next/server"
import { jwtVerify } from "jose"
import { uploadFile } from "@/lib/cloudbase"
import { JWT_SECRET } from "@/lib/jwt-secret"

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]
const MAX_SIZE_DEFAULT = 5 * 1024 * 1024 // 5MB
const MAX_SIZE_FENGYUGUAN = 20 * 1024 * 1024 // 20MB（凤御馆超长宣传图专用）
const FENGYUGUAN_KEY = "images/fengyuguan.jpg"

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
    const url = await uploadFile(buffer, cloudPath)

    return NextResponse.json({ url })
  } catch (err) {
    console.error("Upload error:", err)
    return NextResponse.json({ error: "上传失败" }, { status: 500 })
  }
}
