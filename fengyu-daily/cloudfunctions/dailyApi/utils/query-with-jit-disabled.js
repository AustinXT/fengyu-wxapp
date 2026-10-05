const pg = require('../db/pg');

// Keep JIT disabled only for this statement. Standalone reads use a read-only
// transaction; callers already inside a transaction restore their prior value.
async function query(sql, params = []) {
  const client = await pg.getPool().connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL jit = off');
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result.rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function onClient(client, sql, params = []) {
  const [{ jit }] = (await client.query('SHOW jit')).rows;
  await client.query('SET LOCAL jit = off');
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    await client.query('SELECT set_config($1, $2, true)', ['jit', jit]);
  }
}

module.exports = { query, onClient };
