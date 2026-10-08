import cloudbase from "@cloudbase/node-sdk"
import type fs from "node:fs"
import { ApiError } from "@/lib/api-error"
import { assertExternalAvailable } from '@/lib/demo-runtime'
import { writeDemoFile, demoFileUrl, deleteDemoFile, readDemoFile } from '@/lib/demo-storage'

// dev/prod 共用当前 CloudBase 存储桶；CDN 基址由部署配置注入。
export const CDN_BASE =
  process.env.CDN_BASE ??
  "https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la"

let app: ReturnType<typeof cloudbase.init> | null = null
let staffApp: ReturnType<typeof cloudbase.init> | null = null

function cloudFileId(cloudPath: string): string {
  if (cloudPath.startsWith("cloud://")) return cloudPath

  const envId = process.env.CLOUDBASE_ENV_ID
  if (!envId) throw new ApiError("INVALID_STATE", "CloudBase 环境未配置")

  let bucket: string
  try {
    bucket = new URL(CDN_BASE).hostname.split(".")[0] ?? ""
  } catch {
    throw new ApiError("INVALID_STATE", "CloudBase 存储桶配置无效")
  }
  if (!bucket) throw new ApiError("INVALID_STATE", "CloudBase 存储桶配置无效")

  const normalizedPath = cloudPath.replace(new RegExp("^/+"), "")
  return `cloud://${envId}.${bucket}/${normalizedPath}`
}

function getApp() {
  assertExternalAvailable()
  if (!app) {
    app = cloudbase.init({
      env: process.env.CLOUDBASE_ENV_ID!,
      secretId: process.env.TENCENTCLOUD_SECRETID!,
      secretKey: process.env.TENCENTCLOUD_SECRETKEY!,
    })
  }
  return app
}

function getStaffApp() {
  assertExternalAvailable()
  if (!staffApp) {
    const env = process.env.STAFF_ENV_ID?.trim()
    if (!env) throw new ApiError("INVALID_STATE", "Staff CloudBase 环境未配置")
    const secretId = process.env.STAFF_TENCENTCLOUD_SECRETID?.trim()
    const secretKey = process.env.STAFF_TENCENTCLOUD_SECRETKEY?.trim()
    if (!secretId || !secretKey) {
      throw new ApiError("INVALID_STATE", "Staff CloudBase 独立账号凭据未配置")
    }
    staffApp = cloudbase.init({
      env,
      secretId,
      secretKey,
    })
  }
  return staffApp
}

export async function uploadFile(
  fileContent: Buffer | fs.ReadStream,
  cloudPath: string
): Promise<string> {
  if (process.env.DEMO_MODE === '1') return writeDemoFile(fileContent, cloudPath)
  const app = getApp()
  const result = await app.uploadFile({
    cloudPath,
    fileContent,
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

/** 获取 CloudBase Storage 文件的短期下载地址。调用方应先完成权限校验。 */
export async function getTempFileUrl(cloudPath: string): Promise<string> {
  if (process.env.DEMO_MODE === '1') return demoFileUrl(cloudPath, true)
  const app = getApp()
  const result = await app.getTempFileURL({
    fileList: [cloudFileId(cloudPath)],
  })
  const item = result.fileList?.[0]
  if (!item?.tempFileURL) {
    throw new ApiError("NOT_FOUND", "导出文件不存在或已过期")
  }
  return item.tempFileURL
}

/**
 * 将源 CDN URL 的图片重新上传到固定 cloudPath。
 * 若源 URL 已指向目标路径则跳过。
 */
export async function reuploadToFixedPath(
  sourceUrl: string,
  targetPath: string
): Promise<void> {
  if (process.env.DEMO_MODE === '1') {
    const url = new URL(sourceUrl, process.env.DEMO_PUBLIC_ORIGIN)
    const origin = new URL(process.env.DEMO_PUBLIC_ORIGIN || 'http://101.34.242.103:8094')
    if (url.origin !== origin.origin || !url.pathname.startsWith('/api/demo-files/')) {
      throw new ApiError('INVALID_PARAMS', '演示环境只支持本地上传的图片')
    }
    const key = decodeURIComponent(url.pathname.slice('/api/demo-files/'.length))
    if (key !== targetPath) await writeDemoFile(await readDemoFile(key), targetPath)
    return
  }
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
  if (process.env.DEMO_MODE === '1') {
    for (const key of cloudPaths) await deleteDemoFile(key)
    return
  }
  if (cloudPaths.length === 0) return
  const app = getApp()
  const fileList = cloudPaths.map(cloudFileId)
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
function deploymentFunctionName(name: string): string {
  const profile = process.env.ENV_PROFILE
  if (profile !== "dev" && profile !== "prod") {
    throw new ApiError("INVALID_STATE", "云函数发布通道未配置")
  }
  if (profile === "dev" && ["clientApi", "payNotify", "staffApi"].includes(name)) {
    return `${name}Dev`
  }
  if (profile === "prod" && ["clientApiDev", "payNotifyDev", "staffApiDev"].includes(name)) {
    throw new ApiError("INVALID_STATE", "生产后台不能调用影子云函数")
  }
  return name
}

export async function callClientFunction<T = unknown>(
  name: string,
  data: { action: string; payload?: Record<string, unknown> }
): Promise<T> {
  const app = getApp()
  const res = await app.callFunction({ name: deploymentFunctionName(name), data })
  return res.result as T
}

/** 调用 staff env 下的云函数，仅供服务端内部诊断等场景使用。 */
export async function callStaffFunction<T = unknown>(
  name: string,
  data: { action: string; payload?: Record<string, unknown> },
): Promise<T> {
  const res = await getStaffApp().callFunction({ name: deploymentFunctionName(name), data })
  return res.result as T
}

/** 只进行身份和环境访问校验，不读写任何业务文件。 */
export async function probeCloudbaseStorage(): Promise<void> {
  const result = await getApp().getTempFileURL({
    fileList: [cloudFileId('__system_health_probe_not_a_real_file__')],
  })
  if (!Array.isArray(result.fileList)) throw new Error('CloudBase storage response is invalid')
}
