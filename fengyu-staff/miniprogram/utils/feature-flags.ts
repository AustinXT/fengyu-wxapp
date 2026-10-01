/**
 * 提货登记入口独立开放（开发版/体验版/正式版均可用）。
 * 库存入口与提货库存联动仍仅开发版开启；版本信息缺失时联动关闭。
 * 小程序开关在代码中，修改后须重新上传。后端独立控制 record-only / 联动。
 */
function isDevMiniprogram(): boolean {
  try {
    const info = wx.getAccountInfoSync()
    const envVersion = info?.miniProgram?.envVersion
    return envVersion === 'develop'
  } catch {
    return false
  }
}

/** 只控制提货核销入口，不控制库存管理。 */
export const INVENTORY_ENTRY_ENABLED = true

/** 库存入口与扣批次/生成 GCK，保持现有 dev-only 判据。 */
export const INVENTORY_LINKAGE_ENABLED = isDevMiniprogram()
