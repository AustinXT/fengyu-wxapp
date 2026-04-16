/**
 * 跨路由共享的常量
 *
 * 这里定义的 ID 由 db/scripts/seed-recharge-virtual-product.js 一次性 seed 到双库。
 * 修改此处常量前，先确认 5433 + 5434 两库都有对应行（详见 seed 脚本）。
 */

// 充值卡虚拟商品 — 顾客端「充值卡充值」走 sale_orders + sale_items 模型，
// 用此虚拟 SPU/SKU 占位。products.is_visible=false / is_enabled=false 双重隐藏，
// 在 product.shopInit / spuList / spuDetail / 搜索 中均不会暴露。
const RECHARGE_VIRTUAL_PRODUCT_ID = 'prod-recharge-virtual'
const RECHARGE_VIRTUAL_SKU_ID = 'sku-recharge-virtual'

module.exports = {
  RECHARGE_VIRTUAL_PRODUCT_ID,
  RECHARGE_VIRTUAL_SKU_ID,
}
