import { db } from '@/db'
import { ApiError } from '@/lib/api-error'
import { sql } from 'drizzle-orm'

export const WORKFINE_INVENTORY_CUTOVER_KEY = 'workfine_inventory'

export type InventoryBaselineStatus = '待初始化' | '待核验' | '已初始化'

type SqlExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>
}

function stateFromRows(value: unknown): InventoryBaselineStatus {
  const row = (value as Array<{ status?: unknown }>)[0]
  const status = typeof row?.status === 'string' ? row.status : '待初始化'
  return status === '已初始化' || status === '待核验' ? status : '待初始化'
}

export async function getInventoryBaselineStatus(): Promise<{
  status: InventoryBaselineStatus
  isInitialized: boolean
}> {
  const result = await db.execute(sql`
    SELECT status
      FROM inventory_cutover_states
     WHERE cutover_key = ${WORKFINE_INVENTORY_CUTOVER_KEY}
  `)
  const status = stateFromRows(result)
  return { status, isInitialized: status === '已初始化' }
}

/**
 * 库存期初通过 WorkFine 导入并核验前，禁止产生任何业务库存流水。
 * 状态行在当前事务内初始化并锁定，避免受控 reset 与正常业务写入交叉。
 */
export async function assertInventoryBusinessWritable(tx: SqlExecutor): Promise<void> {
  await tx.execute(sql`
    INSERT INTO inventory_cutover_states (cutover_key, status)
    VALUES (${WORKFINE_INVENTORY_CUTOVER_KEY}, '待初始化')
    ON CONFLICT (cutover_key) DO NOTHING
  `)
  const result = await tx.execute(sql`
    SELECT status
      FROM inventory_cutover_states
     WHERE cutover_key = ${WORKFINE_INVENTORY_CUTOVER_KEY}
     FOR UPDATE
  `)
  const status = stateFromRows(result)
  if (status !== '已初始化') {
    throw new ApiError('INVALID_STATE', '库存期初尚未导入并核验完成，暂不可办理库存业务')
  }
}
