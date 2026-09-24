/**
 * #350：可提货清单带下单日期，供提货录入按销售单分组。
 *
 * 下单日期取 sale_orders.sale_order_datetime，在 SQL 里按上海日历日截成 YYYY-MM-DD 再下发 ——
 * 与 staffApi availablePickupItems 同写法（小程序端日期本地化不可靠，两端统一服务端格式化）。
 */
import { describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'

const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }))

vi.mock('@/db', () => ({ db: { execute: mockExecute } }))
vi.mock('@/lib/with-permission', () => ({
  withPermission: (_action: string, fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => fn({ employeeId: 'E1', roles: [], permissions: { actions: [] } }, ...args),
  withAnyPermission: (_actions: string[], fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => fn({ employeeId: 'E1', roles: [], permissions: { actions: [] } }, ...args),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { getAvailablePickupItems } from '../pickup-records'

describe('getAvailablePickupItems 下单日期（#350）', () => {
  it('SQL 取 sale_orders.sale_order_datetime 的上海日历日，映射成 orderDate', async () => {
    mockExecute.mockResolvedValueOnce([{
      sale_item_id: 'SI-1', sale_item_group_id: 'SI-1', source_sale_item_ids: ['SI-1'],
      sale_order_id: 'ORDER-A', sku_id: 'sku-1', product_name: '面霜',
      quantity: 2, picked_up_quantity: 0, paid_quantity: 2, pending_pickup_quantity: 2,
      unit_real_price: '199.00', store_id: 'store-1', store_name: '红谷滩店', order_date: '2026-09-20',
    }])

    const rows = await getAvailablePickupItems('client-1')

    const query = mockExecute.mock.calls[0][0]
    const compiled = new PgDialect().sqlToQuery(query)
    expect(compiled.sql).toContain("to_char(o.sale_order_datetime AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS order_date")
    expect(compiled.sql).toContain('MIN(order_date) AS order_date')
    expect(rows[0]).toMatchObject({ saleOrderId: 'ORDER-A', orderDate: '2026-09-20', storeName: '红谷滩店', unitRealPrice: '199.00' })
  })

  it('order_date 缺失时映射为 null 而不是 undefined', async () => {
    mockExecute.mockResolvedValueOnce([{
      sale_item_id: 'SI-2', sale_order_id: 'ORDER-B', quantity: 1, pending_pickup_quantity: 1,
      unit_real_price: '10.00', store_id: 'store-1',
    }])
    const rows = await getAvailablePickupItems('client-1')
    expect(rows[0].orderDate).toBeNull()
  })
})
