/**
 * PG 自托管数据库连接池
 * 用于读写小程序专属数据(订单、预约、服务单、用户等)
 */

const pg = require('pg')
const { Pool } = pg

// 全局 OID 解析：让 numeric/bigint 直接返回 JS Number 而不是字符串。
// 安全前提：业务金额 ≤ 9999.99（numeric(10,2)）、积分单值 << 2^53，详见 db/schema/points.ts 注释。
// 一旦业务量级逼近 2^53 需切回 bigint mode + BigInt 处理（届时撤销 OID=20 的设置）。
pg.types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)))    // int8 / bigint
pg.types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)))    // numeric
// date 是无时区自然日；保持 PG 的 YYYY-MM-DD 文本，避免转成进程本地零点 Date 后序列化偏移。
pg.types.setTypeParser(1082, (val) => val)                                        // date
// timestamp 列自 migration 0076 起统一为 timestamptz（1184）：PG 发带 +08 偏移字面，pg 内置 parser
// `new Date(value)` 按字面偏移正确解析为 Date，无需自定义 1114 parser（库已无 1114 列）。

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
