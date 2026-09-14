/**
 * e2e-inventory-ui/_helpers/cutover.ts
 *
 * 期初切流门禁（总闸）的读写。
 *
 * 背景：src/lib/inventory/cutover.ts 的 assertInventoryBusinessWritable() 守在所有
 * 库存写路径的事务第一行，状态非「已初始化」一律抛
 *   INVALID_STATE: 库存期初尚未导入并核验完成，暂不可办理库存业务
 * dev 库 inventory_cutover_states 原为空表 → 判「待初始化」→ 全部写入被拦死。
 *
 * 本套件按用户决定在 dev 上开闸，**开后不恢复**（见 BUSINESS-SCENARIOS.md §3.1）。
 * 生产走 WorkFine 期初迁移脚本置位，与此无关。
 */

import { psql, sqlStr } from './env'

export const CUTOVER_KEY = 'workfine_inventory'

export type BaselineStatus = '待初始化' | '待核验' | '已初始化'

/** 当前门禁状态。空行视为「待初始化」，与 cutover.ts:15-16 的 stateFromRows 同口径。 */
export function readCutoverStatus(): BaselineStatus {
  const raw = psql(
    `SELECT status FROM inventory_cutover_states WHERE cutover_key = ${sqlStr(CUTOVER_KEY)}`,
  )
  return raw === '已初始化' || raw === '待核验' ? raw : '待初始化'
}

export function isGateOpen(): boolean {
  return readCutoverStatus() === '已初始化'
}

/**
 * 开闸：置「已初始化」。幂等。
 *
 * operator 必须是**真实存在的 employee_id** —— initialized_by 有 FK 指向
 * staff_wechat_users，填任意字符串会被 23503 拒绝。默认用 seed 出来的超管账号。
 */
export function openCutoverGate(operator = 'INVT-ADM-01'): void {
  psql(
    `INSERT INTO inventory_cutover_states
       (cutover_key, status, initialized_by, initialized_at, verified_at, updated_at)
     VALUES (${sqlStr(CUTOVER_KEY)}, '已初始化', ${sqlStr(operator)}, NOW(), NOW(), NOW())
     ON CONFLICT (cutover_key) DO UPDATE
       SET status = '已初始化',
           initialized_by = EXCLUDED.initialized_by,
           initialized_at = COALESCE(inventory_cutover_states.initialized_at, EXCLUDED.initialized_at),
           verified_at = EXCLUDED.verified_at,
           updated_at = NOW()`,
  )
}

/**
 * 关闸：置「待初始化」。
 * 仅供 INV-00 在开闸前构造「关闭态」以验证 fail-closed 确实生效；
 * 正常流程跑完不调用（用户已确认开后不恢复）。
 */
export function closeCutoverGate(): void {
  psql(
    `INSERT INTO inventory_cutover_states (cutover_key, status, updated_at)
     VALUES (${sqlStr(CUTOVER_KEY)}, '待初始化', NOW())
     ON CONFLICT (cutover_key) DO UPDATE
       SET status = '待初始化', updated_at = NOW()`,
  )
}
