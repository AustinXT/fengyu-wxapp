/**
 * 开单 Step 2 共享类型（PR-C C1）
 *
 * 4 个 Picker 子组件共享同一份 cart state + priceOverrides，通过 props 传递。
 * 这里收敛纯类型定义；ProductKindChoice 与 PrefetchedKindData 仍由 page 主组件持有。
 */
import type { ProductSku, Product } from '@/lib/types'
import type { OrderPickerSku, OrderPickerCategory, OrderPickerBundle } from '@/actions/products'

/** 购物车中的一项（统一 sku + product 引用） */
export interface CartItem {
  sku: ProductSku
  product: Product
  quantity: number
}

/** Step 3 的逐项手动改价记录 */
export interface ItemPriceOverride {
  saleAmount: string | null
  received: string | null
  receivedTouched: boolean
}

/**
 * 4 个 Picker 共用 props：addToCart 由父级注入，避免 cart state 下放。
 *
 * 用 `unknown` 作 product 形参的兜底通道：体验卡/充值卡/普通 SKU 不需要完整 Product
 * 元数据（开单后只用到 product.name），picker 内部根据自身数据源构造一个最小 Product。
 */
export interface PickerCommonProps {
  cart: CartItem[]
  onAdd: (product: Product, sku: ProductSku) => void
}

/** 普通商品 / 体验卡 / 充值卡 复用同一组数据形状（OrderPickerCategory[]） */
export interface NormalKindPickerProps extends PickerCommonProps {
  categories: OrderPickerCategory[]
  /** UI 文案：当前 kind 名称（用于"暂无商品"占位） */
  kindLabel: string
}

/** 套餐 picker 数据形状 */
export interface BundlePickerProps extends PickerCommonProps {
  bundles: OrderPickerBundle[]
}

/**
 * 把 OrderPickerSku 适配回旧 ProductSku 形状的辅助函数（仅 picker 内部用）。
 * 保留 sku.specialPrice / sku.price，让购物车小计计算复用 getItemAmounts 逻辑。
 */
export function pickerSkuToProductSku(sku: OrderPickerSku): ProductSku {
  return {
    skuId: sku.skuId,
    categoryId: sku.categoryId,
    productType: sku.productType,
    specName: sku.specName,
    price: sku.price,
    specialPrice: sku.specialPrice,
    sessionCount: sku.sessionCount,
    sortOrder: sku.sortOrder,
    serviceFee: sku.serviceFee,
    isShengmei: null,
    marketScope: null,
    isEnabled: true,
    createdAt: '',
    updatedAt: '',
    categoryName: sku.categoryName,
  }
}

/**
 * 套餐内 SKU → ProductSku；套餐价（bundlePrice）写入 specialPrice 字段，
 * 让购物车走原有"specialPrice 优先"分支。
 */
export function bundleSkuToProductSku(args: {
  skuId: string
  specName: string
  productType: '疗程卡' | '单品' | '院装产品'
  price: string
  bundlePrice: string | null
  bundleGroupId: number | null
  sortOrder: number
}): ProductSku {
  return {
    skuId: args.skuId,
    categoryId: '',
    productType: args.productType,
    specName: args.specName,
    price: args.price,
    specialPrice: args.bundlePrice,
    sessionCount: null,
    sortOrder: args.sortOrder,
    serviceFee: '0',
    isShengmei: null,
    marketScope: null,
    isEnabled: true,
    createdAt: '',
    updatedAt: '',
    bundlePrice: args.bundlePrice,
    bundleGroupId: args.bundleGroupId,
  }
}
