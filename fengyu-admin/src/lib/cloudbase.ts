import cloudbase from "@cloudbase/node-sdk"
import { ApiError } from "@/lib/api-error"

// CDN 基址随环境切换（dev/prod 桶前缀不同，建桶时分配，不能从 envId 推算）。
// 由 env 注入：prod → 6665-fengyu-client-prod-…，dev → 636c-cloud1-…；缺省兜底 dev 保本地行为。
export const CDN_BASE =
  process.env.CDN_BASE ??
  "https://636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la"

let app: ReturnType<typeof cloudbase.init> | null = null

function getApp() {
  if (!app) {
    app = cloudbase.init({
      env: process.env.CLOUDBASE_ENV_ID!,
      secretId: process.env.TENCENTCLOUD_SECRETID!,
      secretKey: process.env.TENCENTCLOUD_SECRETKEY!,
    })
  }
  return app
}

export async function uploadFile(
  buffer: Buffer,
  cloudPath: string
): Promise<string> {
  const app = getApp()
  const result = await app.uploadFile({
    cloudPath,
    fileContent: buffer,
  })
  if (!result.fileID) {
    throw new ApiError("INVALID_STATE", "文件上传失败，请重试")
  }

  // 获取实际可访问的临时下载 URL（CDN 签名链接）
  const urlResult = await app.getTempFileURL({
    fileList: [result.fileID],
  })
  const fileItem = urlResult.fileList?.[0]
  if (fileItem?.tempFileURL) {
    return fileItem.tempFileURL
  }

  // fallback: 拼接 CDN 基础 URL
  return `${CDN_BASE}/${cloudPath}`
}

/**
 * 将源 CDN URL 的图片重新上传到固定 cloudPath。
 * 若源 URL 已指向目标路径则跳过。
 */
export async function reuploadToFixedPath(
  sourceUrl: string,
  targetPath: string
): Promise<void> {
  const cleanUrl = sourceUrl.split("?")[0]
  // 整 URL 比对当前环境桶：仅当源已是「本环境桶 + 目标路径」才跳过。
  // 只比路径后缀会漏判跨桶（如 dev→prod）场景，导致 prod 桶永远拿不到文件。
  if (cleanUrl === `${CDN_BASE}/${targetPath}`) return
  const res = await fetch(cleanUrl)
  if (!res.ok) throw new ApiError("INVALID_STATE", `资源下载失败 (HTTP ${res.status})`)
  const buffer = Buffer.from(await res.arrayBuffer())
  await uploadFile(buffer, targetPath)
}

/**
 * 按 cloudPath 列表删除 CloudBase 存储文件。
 */
export async function deleteByCloudPaths(
  cloudPaths: string[]
): Promise<void> {
  if (cloudPaths.length === 0) return
  const app = getApp()
  const envId = process.env.CLOUDBASE_ENV_ID!
  const fileList = cloudPaths.map((p) => `cloud://${envId}/${p}`)
  await app.deleteFile({ fileList })
}

/**
 * 调用 clientApi / payNotify 等 client envId 下的云函数（action 路由模式）。
 *
 * 仅用于 admin → client envId 的内部广播调用（如 saveSettings 清理 utils/config 缓存）。
 * 跨 envId 调用（如 staffApi）不支持 —— 需要另配 STAFF_CLOUDBASE_ENV_ID + 第二个 app 实例。
 *
 * 失败时抛出；调用方负责用 Promise.allSettled 做容错（云函数缓存失效不是关键路径）。
 */
export async function callClientFunction<T = unknown>(
  name: string,
  data: { action: string; payload?: Record<string, unknown> }
): Promise<T> {
  const app = getApp()
  const res = await app.callFunction({ name, data })
  return res.result as T
}
