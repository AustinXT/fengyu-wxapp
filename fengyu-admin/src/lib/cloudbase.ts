import cloudbase from "@cloudbase/node-sdk"

export const CDN_BASE =
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
    throw new Error("上传失败")
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
