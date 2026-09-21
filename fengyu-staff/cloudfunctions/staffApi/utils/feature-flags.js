/**
 * 进销存发布开关。
 *
 * 由环境变量驱动，**默认关闭**（fail-closed）：只有显式设置 INVENTORY_LINKAGE_ENABLED=true
 * 才启用。这样 dev 与 prod 共用同一份代码，分支合并不会把 dev 的启用状态带进 prod。
 *
 * 开启的前提是目标库已完成 WorkFine 期初库存核验
 * （inventory_cutover_states.workfine_inventory = '已初始化'），否则提货会在
 * assertWorkfineInventoryInitialized 处直接抛 INVALID_STATE。
 *
 * 必须与 clientApi、admin、staff 小程序的独立副本保持同步。
 */
const INVENTORY_LINKAGE_ENABLED = process.env.INVENTORY_LINKAGE_ENABLED === 'true'

module.exports = { INVENTORY_LINKAGE_ENABLED }
