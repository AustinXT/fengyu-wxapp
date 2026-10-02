/**
 * 组件测试用的 `InventorySkuSearchSelect` 替身（#339）。
 *
 * 真组件是「点开 → 防抖检索 → 服务端分页」，它自己的行为由
 * `inventory-sku-search-select.test.tsx` 覆盖。表单级测试关心的是**选中某个 SKU 之后**
 * 表单怎么联动（批次取数、提交 payload），以及每个入口传给选择器的业务过滤是否正确 ——
 * 用原生 select 替身即可沿用 `fireEvent.change(select, { target: { value } })` 的写法，
 * 并把 `filters` / `disabled` 挂成 data 属性供断言。
 */
import type { InventorySkuOptionFilters } from '@/lib/inventory/types'

export const STUB_SKUS = [
  { skuId: 'SKU-1', productCode: 'P001', productName: '精华液' },
  { skuId: 'SKU-2', productCode: 'P002', productName: '面膜' },
]

export function formatInventorySkuLabel(sku: { productName: string; specName?: string | null; productCode: string }) {
  return `${sku.productName}${sku.specName ? ` · ${sku.specName}` : ''} · ${sku.productCode}`
}

export function InventorySkuSearchSelect({
  value,
  onChange,
  filters,
  disabled,
  placeholder = '选择库存商品',
  ariaLabel,
}: {
  value: string
  onChange: (skuId: string, sku: null) => void
  filters?: InventorySkuOptionFilters
  disabled?: boolean
  placeholder?: string
  ariaLabel?: string
}) {
  return (
    <select
      aria-label={ariaLabel ?? placeholder}
      data-sku-picker=""
      data-filters={JSON.stringify(filters ?? {})}
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value, null)}
    >
      <option value="">{placeholder}</option>
      {STUB_SKUS.map((sku) => (
        <option key={sku.skuId} value={sku.skuId}>{sku.productCode} · {sku.productName}</option>
      ))}
    </select>
  )
}
