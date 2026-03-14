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
  return `${CDN_BASE}/${cloudPath}`
}
