import cloudbase from "@cloudbase/node-sdk"
import { ApiError } from "@/lib/api-error"



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

  
  const urlResult = await app.getTempFileURL({
    fileList: [result.fileID],
  })
  const fileItem = urlResult.fileList?.[0]
  if (fileItem?.tempFileURL) {
    return fileItem.tempFileURL
  }

  
  return `${CDN_BASE}/${cloudPath}`
}


export async function reuploadToFixedPath(
  sourceUrl: string,
  targetPath: string
): Promise<void> {
  const cleanUrl = sourceUrl.split("?")[0]
  
  
  if (cleanUrl === `${CDN_BASE}/${targetPath}`) return
  const res = await fetch(cleanUrl)
  if (!res.ok) throw new ApiError("INVALID_STATE", `资源下载失败 (HTTP ${res.status})`)
  const buffer = Buffer.from(await res.arrayBuffer())
  await uploadFile(buffer, targetPath)
}


export async function deleteByCloudPaths(
  cloudPaths: string[]
): Promise<void> {
  if (cloudPaths.length === 0) return
  const app = getApp()
  const envId = process.env.CLOUDBASE_ENV_ID!
  const fileList = cloudPaths.map((p) => `cloud://${envId}/${p}`)
  await app.deleteFile({ fileList })
}


export async function callClientFunction<T = unknown>(
  name: string,
  data: { action: string; payload?: Record<string, unknown> }
): Promise<T> {
  const app = getApp()
  const res = await app.callFunction({ name, data })
  return res.result as T
}
