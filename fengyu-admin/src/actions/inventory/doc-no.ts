import type { PgTransaction } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export type InventoryDocCategory = 'procurement' | 'sale' | 'transfer' | 'scrap'

const PREFIX_BY_CATEGORY: Record<InventoryDocCategory, string> = {
  procurement: 'INV-PROC',
  sale: 'INV-SALE',
  transfer: 'INV-TRF',
  scrap: 'INV-SCR',
}

const TABLE_BY_CATEGORY: Record<InventoryDocCategory, string> = {
  procurement: 'inventory_procurement_orders',
  sale: 'inventory_sale_orders',
  transfer: 'inventory_transfer_orders',
  scrap: 'inventory_scrap_orders',
}

/**
 * 在事务内生成库存单据号：'INV-PROC-YYMMDD-0001'
 *
 * advisory_xact_lock 按 category 隔离，避免跨类别串行；当天序号按当日（doc_date 不参与）。
 * 与 sale_orders/employees 现有模式同构。
 *
 * 注：这是事务内工具函数（接受 tx 作为参数），不是顶层 Server Action；
 * 不需要 withPermission 包裹。eslint rule 仅按目录匹配，需显式豁免。
 */
// eslint-disable-next-line no-restricted-syntax
export async function generateInventoryDocNo(
  tx: PgTransaction<any, any, any>,
  category: InventoryDocCategory,
): Promise<string> {
  const prefix = PREFIX_BY_CATEGORY[category]
  const table = TABLE_BY_CATEGORY[category]
  const lockKey = `${category}_inventory_id_gen`

  const rows = await tx.execute(sql`
    WITH lock AS (
      SELECT pg_advisory_xact_lock(hashtext(${lockKey}))
    )
    SELECT ${sql.raw(`'${prefix}-'`)} || to_char(NOW(), 'YYMMDD') ||
      LPAD(
        (SELECT COALESCE(MAX(
          CAST(NULLIF(SUBSTRING(id FROM '.{4}$'), '') AS INTEGER)
        ), 0) + 1
        FROM ${sql.raw(table)}
        WHERE id LIKE ${sql.raw(`'${prefix}-'`)} || to_char(NOW(), 'YYMMDD') || '%'
        )::TEXT, 4, '0'
      ) AS id
    FROM lock
  `)

  const id = (rows as unknown as Array<{ id: string }>)[0]?.id
  if (!id) throw new Error('INVALID_STATE: 库存单据号生成失败')
  return id
}
