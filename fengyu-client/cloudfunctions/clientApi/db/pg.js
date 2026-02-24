/**
 * PG 自托管数据库连接池
 * 用于读写小程序专属数据(订单、预约、用户等)
 */

const { Pool } = require('pg')

// 延迟初始化连接池(冷启动优化)
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

/**
 * 执行 SQL 查询
 * @param {string} sql - SQL 语句
 * @param {Array} params - 参数
 * @returns {Promise<Array>} 查询结果
 */
async function query(sql, params = []) {
  const client = await getPool().connect()
  try {
    const result = await client.query(sql, params)
    return result.rows
  } finally {
    client.release()
  }
}

/**
 * 执行事务
 * @param {Function} callback - 事务回调,接收 client 参数
 */
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
