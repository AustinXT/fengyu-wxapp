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
// timestamp without time zone (1114)：库存北京墙钟字面，显式按 +08:00 构造 Date，与进程 TZ 解耦。
// CloudBase 运行时 process.env.TZ 不可靠（V8/ICU 时区 spawn 期已锁 UTC），默认 parser 会把
// 北京墙钟当 UTC 解析 → 序列化给前端再 +8 → 晚 8 小时。返回 Date（类型不变，内部运算兼容）。
pg.types.setTypeParser(1114, (val) => (val === null ? null : new Date(val.replace(' ', 'T') + '+08:00')))

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
