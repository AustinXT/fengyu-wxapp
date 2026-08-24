/**
 * 进销存临时停用开关。
 *
 * 入口关闭时库存管理和提货核销不出现在导航中；深链仍保留。
 * 联动关闭时提货只登记提货账，不读取或扣减库存。
 */
export const INVENTORY_ENTRY_ENABLED = false
export const INVENTORY_LINKAGE_ENABLED = false
