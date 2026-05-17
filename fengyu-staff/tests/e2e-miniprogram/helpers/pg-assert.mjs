// helpers/pg-assert.mjs — PG 状态断言工具
//
// 与 fixtures.mjs.assertOrderStatus 配合使用；其他业务断言放这里。

import { query } from './pg.mjs';

export async function fetchOrder(orderId) {
  const rows = await query(
    `SELECT * FROM sale_orders WHERE sale_order_id = $1`,
    [orderId],
  );
  return rows[0] || null;
}

export async function fetchPayments(orderId) {
  const rows = await query(
    `SELECT change_type, amount, status, source_end, created_at
     FROM sale_order_payments
     WHERE sale_order_id = $1
     ORDER BY id ASC`,
    [orderId],
  );
  return rows;
}

export async function assertReceivedAt(orderId, expectedReceived) {
  const o = await fetchOrder(orderId);
  if (!o) throw new Error(`[assert] order ${orderId} missing`);
  const actual = Number(o.received);
  if (Math.abs(actual - expectedReceived) > 0.001) {
    throw new Error(`[assert] order ${orderId} received 期望 ${expectedReceived} 实际 ${actual}`);
  }
  return o;
}

export function eq(actual, expected, label = '值') {
  if (actual !== expected) {
    throw new Error(`[assert] ${label} 期望 "${expected}" 实际 "${actual}"`);
  }
}

export function ok(cond, msg) {
  if (!cond) {
    throw new Error(`[assert] ${msg || '条件失败'}`);
  }
}
