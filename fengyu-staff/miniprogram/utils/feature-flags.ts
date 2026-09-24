/**
 * 进销存发布开关。
 *
 * 小程序端拿不到 process.env，改用小程序版本判别（同 utils/cloud-env.ts 的既有模式）：
 *   - develop（开发版，连 dev env）→ 开启，不挡开发联调
 *   - release / trial（正式版、体验版，连 prod env）→ 关闭
 *   - 取不到版本信息 → 关闭（fail-closed，宁可少个入口也不放进未就绪的 prod）
 *
 * 注意兜底方向与 cloud-env.ts 相反：那里取不到时退到 dev 是为了避免误连 prod 库，
 * 这里取不到时退到「关闭」是为了避免在未完成期初核验的环境露出库存入口。
 *
 * 开启的前提是目标库已完成 WorkFine 期初库存核验
 * （inventory_cutover_states.workfine_inventory = '已初始化'）。
 *
 * 必须与 clientApi、staffApi、admin 的独立副本保持同步。
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

const INVENTORY_ENABLED = isDevMiniprogram()

/** 菜单入口显隐（工作台、我的页的库存入口）。 */
export const INVENTORY_ENTRY_ENABLED = INVENTORY_ENABLED

/** 提货等业务是否走库存联动。 */
export const INVENTORY_LINKAGE_ENABLED = INVENTORY_ENABLED
