/**
 * WorkFine SQL Server 连接(只读)
 * 用于查询员工、产品、门店等业务主数据
 *
 * 重要: 所有操作仅限 SELECT,严禁任何写入
 */

const sql = require('mssql')

// 连接池（Promise），模块加载时即开始连接，不阻塞主线程
let poolPromise = null

function connectPool() {
  const connectionString = process.env.MSSQL_CONNECTION_STRING

  if (connectionString) {
    return sql.connect(connectionString)
  }

  return sql.connect({
    user: process.env.MSSQL_USER || 'Sa',
    password: process.env.MSSQL_PASSWORD || 'oHx#+Q',
    database: process.env.MSSQL_DATABASE || 'wkdb_20220804_86cd3292',
    server: process.env.MSSQL_SERVER || '111.229.31.128',
    port: parseInt(process.env.MSSQL_PORT) || 1433,
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true
    },
    pool: {
      max: 5,
      min: 1,
      idleTimeoutMillis: 30000
    }
  })
}

async function getPool() {
  if (!poolPromise) {
    poolPromise = connectPool()
    // 连接失败时重置，下次重试
    poolPromise.catch(() => { poolPromise = null })
  }
  return poolPromise
}

// 预热：模块加载时立即发起连接（fire-and-forget）
getPool().catch(() => {})

/**
 * 执行 SQL 查询(只读)
 * @param {string} sqlQuery - SQL 查询语句
 * @returns {Promise<Array>} 查询结果
 */
async function query(sqlQuery) {
  const pool = await getPool()
  const result = await pool.request().query(sqlQuery)
  return result.recordset
}

module.exports = {
  query,
  getPool
}
