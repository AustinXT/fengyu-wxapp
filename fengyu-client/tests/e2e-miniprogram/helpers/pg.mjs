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

export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
