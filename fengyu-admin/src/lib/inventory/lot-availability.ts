/**
 * 批次可用量 = 物理在手 - 已预留。
 *
 * 独立成纯函数是为了可测：调用方（如 pickup-records 的提货出库建单）拿到的行来自
 * `tx.execute(sql\`\`)` 原生 SQL，不经 drizzle 列映射 —— `inventory_stock_lots.id` 与
 * `inventory_stock_reservations.lot_id` 都是 bigint(int8)，postgres.js 对其无 parser，
 * 原样返回 **string**。两侧 key 必须都经 `Number()` 归一，否则 `Map.get` 恒 miss、
 * 已预留量被静默忽略，可用量系统性高估（2026-09-10 修复）。
 */
export function computeAvailableByLot(
  lotRows: ReadonlyArray<{ id: number | string; quantity_on_hand: string | number }>,
  reservationRows: ReadonlyArray<{ lot_id: number | string; quantity: string | number }>,
): Map<number, number> {
  const reservedByLot = new Map(
    reservationRows.map((row) => [Number(row.lot_id), Number(row.quantity)]),
  )
  return new Map(
    lotRows.map((row) => {
      const lotId = Number(row.id)
      return [lotId, Math.max(0, Number(row.quantity_on_hand) - (reservedByLot.get(lotId) ?? 0))]
    }),
  )
}
