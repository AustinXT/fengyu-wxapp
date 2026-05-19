/**
 * 跨路由共享的常量
 *
 * 2026-05-20 充值卡剥离 SKU 化后：
 *   - 充值订单不再用虚拟 SKU 占位（不写 sale_items 行）
 *   - 充值订单由 sale_orders.sale_order_type='充值单' 标识
 *   - 历史虚拟 SKU 'sku-recharge-virtual' / 'prod-recharge-virtual' 已由 migration 0043 清理
 *
 * 当前文件保留为占位；后续若有跨路由常量再行添加。
 */

module.exports = {}
