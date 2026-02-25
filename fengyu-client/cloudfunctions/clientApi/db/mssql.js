/**
 * WorkFine SQL Server 连接(只读)
 * 用于查询员工、产品、门店等业务主数据
 *
 * 重要: 所有操作仅限 SELECT,严禁任何写入
 */

const sql = require('mssql')

// 延迟初始化连接池
let pool = null

async function getPool() {
  if (!pool) {
    // 优先使用连接串，如果不存在则使用分离的环境变量
    const connectionString = process.env.MSSQL_CONNECTION_STRING

    if (connectionString) {
      // 使用连接串格式：Server=host,port;Database=db;User Id=user;Password=pass
      pool = await sql.connect(connectionString)
    } else {
      // 使用分离的环境变量（向后兼容）
      pool = await sql.connect({
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
          min: 0,
          idleTimeoutMillis: 30000
        }
      })
    }
  }
  return pool
}

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
