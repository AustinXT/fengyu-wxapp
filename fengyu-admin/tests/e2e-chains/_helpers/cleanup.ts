/**
 * 共享清理工具：删除测试销售单及其全部 FK 依赖。
 *
 * 设计要点：
 *   1. 按"最依赖先删"顺序逐张表 try/catch，单条失败不中断整体；
 *   2. card_transactions 默认保留真实流水（NULL 化 ref_order_id 而非删除）；
 *   3. 自动递归清理 ref_sale_order_id 指向当前单的回款/凭证单；
 *   4. 调用方只需传入 sale_order_id 与已定义的 psql 函数（执行 SQL 并返回 stdout 字符串）。
 *
 * FK 依赖图（5433 fengyu_wxapp，2026-05-17 审计）：
 *   sale_orders   ← point_transactions.ref_order_id
 *                 ← card_transactions.ref_order_id          (NULL 化 ⇒ 保留流水)
 *                 ← sale_items.sale_order_id
 *                 ← sale_order_payments.sale_order_id       (ON DELETE RESTRICT)
 *                 ← sale_orders.ref_sale_order_id           (自引用，回款/凭证单)
 *                 ← user_coupons.used_sale_order_id
 *   sale_items    ← appointments.sale_item_id
 *                 ← pickup_records.sale_item_id
 *                 ← sale_allocations.sale_item_id
 *                 ← sale_items.ref_sale_item_id
 *                 ← sale_order_payments.ref_sale_item_id
 *                 ← service_items.sale_item_id
 *   service_items ← service_commissions.service_item_id
 *
 * messages 表无 FK（ref_entity_id 是 text），无须删除即可放心 DROP sale_orders。
 */

export type PsqlFn = (sql: string) => string

export interface CleanupOptions {
  /** 是否保留 card_transactions 行（默认 true：NULL 化 ref；false：直接 DELETE） */
  preserveCardTransactions?: boolean
  /** 日志前缀，默认 '[cleanup]' */
  logPrefix?: string
}

/** 单条 SQL 容错执行：失败仅 console.log 不抛 */
function safe(psql: PsqlFn, sql: string, tag: string, prefix: string): void {
  try {
    psql(sql)
    console.log(`${prefix} ${tag}: ok`)
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e)
    console.log(`${prefix} ${tag}: skipped (${msg})`)
  }
}

/**
 * 清理一个销售单（及其所有 FK 子表 / 关联回款单）。
 *
 * @param soid     销售单号，如 "FY-XSD-WX-2605170014"
 * @param psql     执行 SQL 的函数（同步），返回 stdout 字符串
 * @param options  可选参数
 */
export function cleanupSaleOrder(
  soid: string,
  psql: PsqlFn,
  options: CleanupOptions = {},
): void {
  if (!soid) return
  const prefix = options.logPrefix ?? '[cleanup]'
  const preserveCT = options.preserveCardTransactions !== false // 默认保留

  console.log(`${prefix} 开始清理 sale_order=${soid} (preserveCardTransactions=${preserveCT})`)

  // ---- L1: sale_items 的孙子表（service_commissions 经 service_items 关联） ----
  safe(
    psql,
    `DELETE FROM service_commissions WHERE service_item_id IN (` +
      `SELECT service_item_id FROM service_items WHERE sale_item_id IN (` +
      `SELECT sale_item_id FROM sale_items WHERE sale_order_id='${soid}'))`,
    'service_commissions',
    prefix,
  )

  // ---- L2: sale_items 的直接子表 ----
  safe(
    psql,
    `DELETE FROM sale_allocations WHERE sale_item_id IN (` +
      `SELECT sale_item_id FROM sale_items WHERE sale_order_id='${soid}')`,
    'sale_allocations',
    prefix,
  )
  safe(
    psql,
    `DELETE FROM service_items WHERE sale_item_id IN (` +
      `SELECT sale_item_id FROM sale_items WHERE sale_order_id='${soid}')`,
    'service_items',
    prefix,
  )
  safe(
    psql,
    `DELETE FROM appointments WHERE sale_item_id IN (` +
      `SELECT sale_item_id FROM sale_items WHERE sale_order_id='${soid}')`,
    'appointments',
    prefix,
  )
  safe(
    psql,
    `DELETE FROM pickup_records WHERE sale_item_id IN (` +
      `SELECT sale_item_id FROM sale_items WHERE sale_order_id='${soid}')`,
    'pickup_records',
    prefix,
  )
  // sale_order_payments.ref_sale_item_id 也指向 sale_items，需先 NULL 化（避免 RESTRICT）
  safe(
    psql,
    `UPDATE sale_order_payments SET ref_sale_item_id=NULL WHERE ref_sale_item_id IN (` +
      `SELECT sale_item_id FROM sale_items WHERE sale_order_id='${soid}')`,
    'sale_order_payments.ref_sale_item_id (NULL)',
    prefix,
  )
  // 自引用：ref_sale_item_id 指向本单 sale_item
  safe(
    psql,
    `UPDATE sale_items SET ref_sale_item_id=NULL WHERE ref_sale_item_id IN (` +
      `SELECT sale_item_id FROM sale_items WHERE sale_order_id='${soid}')`,
    'sale_items.ref_sale_item_id (NULL)',
    prefix,
  )

  // ---- L3: sale_orders 的直接子表（除 sale_items / sale_order_payments） ----
  safe(
    psql,
    `DELETE FROM point_transactions WHERE ref_order_id='${soid}'`,
    'point_transactions',
    prefix,
  )
  // user_coupons.used_sale_order_id 用 NULL 化保留券记录（券属于顾客资产）
  safe(
    psql,
    `UPDATE user_coupons SET used_sale_order_id=NULL, used_at=NULL, status='未使用' WHERE used_sale_order_id='${soid}'`,
    'user_coupons (rollback)',
    prefix,
  )
  // card_transactions: 默认 NULL 化保留流水；preserveCardTransactions=false 时 DELETE
  if (preserveCT) {
    safe(
      psql,
      `UPDATE card_transactions SET ref_order_id=NULL WHERE ref_order_id='${soid}'`,
      'card_transactions.ref_order_id (NULL)',
      prefix,
    )
  } else {
    safe(
      psql,
      `DELETE FROM card_transactions WHERE ref_order_id='${soid}'`,
      'card_transactions (delete)',
      prefix,
    )
  }

  // ---- L4: 递归清理关联回款/凭证单（ref_sale_order_id=soid） ----
  let hkdRows = ''
  try {
    hkdRows = psql(`SELECT sale_order_id FROM sale_orders WHERE ref_sale_order_id='${soid}'`).trim()
  } catch {
    /* ignore */
  }
  if (hkdRows) {
    for (const hkdId of hkdRows
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean)) {
      console.log(`${prefix}   递归清理回款/凭证单 ${hkdId}`)
      cleanupSaleOrder(hkdId, psql, options)
    }
  }
  // 防御：还可能有自引用未清完（如另一方向的 ref）→ NULL 化
  safe(
    psql,
    `UPDATE sale_orders SET ref_sale_order_id=NULL WHERE ref_sale_order_id='${soid}'`,
    'sale_orders.ref_sale_order_id (NULL)',
    prefix,
  )

  // ---- L5: sale_items + sale_order_payments（必须先于 sale_orders） ----
  safe(
    psql,
    `DELETE FROM sale_items WHERE sale_order_id='${soid}'`,
    'sale_items',
    prefix,
  )
  safe(
    psql,
    `DELETE FROM sale_order_payments WHERE sale_order_id='${soid}'`,
    'sale_order_payments',
    prefix,
  )

  // ---- L6: operation_logs（非 FK，仅 target_id 字符串匹配） ----
  safe(
    psql,
    `DELETE FROM operation_logs WHERE target_id='${soid}'`,
    'operation_logs',
    prefix,
  )

  // ---- L7: sale_orders 自身 ----
  safe(
    psql,
    `DELETE FROM sale_orders WHERE sale_order_id='${soid}'`,
    'sale_orders',
    prefix,
  )

  console.log(`${prefix} 清理完成 sale_order=${soid}`)
}
