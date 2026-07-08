

const pg = require('pg')
const { Pool } = pg




pg.types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)))    
pg.types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)))    




let pool = null

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.PG_CONNECTION_STRING,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    })

    pool.on('error', (err) => {
      console.error('PG pool error:', err)
    })
  }
  return pool
}


async function query(sql, params = []) {
  const client = await getPool().connect()
  try {
    const result = await client.query(sql, params)
    return result.rows
  } finally {
    client.release()
  }
}


async function transaction(callback) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

module.exports = {
  query,
  transaction,
  getPool
}
