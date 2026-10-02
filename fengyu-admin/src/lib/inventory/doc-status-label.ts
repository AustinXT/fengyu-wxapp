import type { InventoryDocRow } from './types'

/**
 * 单据状态的展示文案。采购订单「待收货」且已有入库时显示「部分入库」（#335）——
 * 这只是派生标签，业务判断（候选、关闭、入库）一律仍看 `status`。
 */
export function inventoryDocStatusLabel(doc: Pick<InventoryDocRow, 'status' | 'partiallyReceived'>): string {
  return doc.partiallyReceived && doc.status === '待收货' ? '部分入库' : doc.status
}
