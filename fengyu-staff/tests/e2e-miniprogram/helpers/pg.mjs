// helpers/pg.mjs — PG 连接池单例（lazy init）

import pg from 'pg';
import { PG_CONN } from './constants.mjs';

const { Pool } = pg;
let _pool = null;

export function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: PG_CONN,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
    _pool.on('error', (err) => {
      // 让池中空闲连接断开异常不致命，仅打印
      console.error('[pg pool] idle client error:', err.message);
    });
  }
  return _pool;
}

export async function query(sql, params = []) {
  const pool = getPool();
  const res = await pool.query(sql, params);
  return res.rows;
}

export async function tx(fn) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * H5：异步副作用 poll（积分发放 / 消息推送等非即时落库场景）。
 * 反复跑 sql 直到 predicate(rows) === true 或超时。
 */
export async function pgPoll(sql, params, predicate, { timeoutMs = 5000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastRows = [];
  while (Date.now() < deadline) {
    lastRows = await query(sql, params);
    if (predicate(lastRows)) return lastRows;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(
    `[L3 E2E] pgPoll 超时 ${timeoutMs}ms\n` +
    `  sql: ${sql.split('\n').map(l => l.trim()).join(' ').slice(0, 200)}\n` +
    `  params: ${JSON.stringify(params)}\n` +
    `  最后一次结果 (${lastRows.length} 行): ${JSON.stringify(lastRows.slice(0, 3))}`
  );
}

export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
