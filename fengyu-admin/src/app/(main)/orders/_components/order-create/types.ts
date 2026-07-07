
import type { ProductSku, Product } from '@/lib/types'
import type { OrderPickerSku, OrderPickerCategory, OrderPickerBundle, OrderPickerNormalGroup } from '@/actions/products'


export interface CartItem {
  sku: ProductSku
  product: Product
  quantity: number
}


export interface ItemPriceOverride {
  saleAmount: string | null
  received: string | null
  receivedTouched: boolean
}


export interface PickerCommonProps {
  cart: CartItem[]
  onAdd: (product: Product, sku: ProductSku) => void
}


export interface NormalGroupPickerProps extends PickerCommonProps {
  groups: OrderPickerNormalGroup[]
  
  kindLabel: string
  
  buyerIsMember?: boolean
}


export interface NormalKindPickerProps extends PickerCommonProps {
  categories: OrderPickerCategory[]
  
  kindLabel: string
  
  buyerIsMember?: boolean
}


export interface BundleAddPayload {
  product: Product
  items: { sku: ProductSku; quantity: number }[]
}


export interface BundlePickerProps extends PickerCommonProps {
  bundles: OrderPickerBundle[]
  
  onBundleAdded?: (payload: BundleAddPayload) => void
}


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
    
    isManagerSpecial: sku.isManagerSpecial,
    
    isExperience: sku.isExperience,
    marketScope: null,
    isEnabled: true,
    createdAt: '',
    updatedAt: '',
    categoryName: sku.categoryName,
  }
}


export function bundleSkuToProductSku(args: {
  skuId: string
  specName: string
  productType: '疗程卡' | '家居产品'
  
  sessionCount: number | null
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
    sessionCount: args.sessionCount,
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
