/**
 * 兼容旧的套餐 helper 引用。
 * 新开单商品范围统一从 order-market-scope 导入，避免套餐与普通 SKU 语义漂移。
 */
export {
  type CustomerOrderMarketScope as CustomerBundleMarketScope,
  resolveCustomerOrderMarketScope as resolveCustomerBundleMarketScope,
  orderMarketScopeCondition as bundleMarketScopeCondition,
} from './order-market-scope'
