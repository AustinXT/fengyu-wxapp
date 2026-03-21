/**
 * WorkFine SQL Server 连接(只读)
 * 用于查询员工、产品、门店等业务主数据
 *
 * 重要: 所有操作仅限 SELECT,严禁任何写入
 */

const sql = require("mssql");

// 连接池（Promise），模块加载时即开始连接，不阻塞主线程
let poolPromise = null;

function connectPool() {
  const connectionString = process.env.MSSQL_CONNECTION_STRING;

  if (connectionString) {
    return sql.connect(connectionString);
  }

  return sql.connect({
    user: process.env.MSSQL_USER || "SD",
    password: process.env.MSSQL_PASSWORD || "",
    database: process.env.MSSQL_DATABASE || "wkdb_20220804_86cd3292",
    server: process.env.MSSQL_SERVER || "47.96.87.33",
    port: parseInt(process.env.MSSQL_PORT) || 1433,
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true,
    },
    pool: {
      max: 5,
      min: 1,
      idleTimeoutMillis: 30000,
    },
  });
}

async function getPool() {
  if (!poolPromise) {
    poolPromise = connectPool();
    // 连接失败时重置，下次重试
    poolPromise.catch(() => {
      poolPromise = null;
    });
  }
  return poolPromise;
}

// 预热：模块加载时立即发起连接（fire-and-forget）
getPool().catch(() => {});

/**
 * 执行 SQL 查询(只读)
 * @param {string} sqlQuery - SQL 查询语句（支持 @param 占位符）
 * @param {Object} [params] - 命名参数（如 { id: 'C001', phone: '138...' }）
 * @returns {Promise<Array>} 查询结果
 */
async function query(sqlQuery, params) {
  const pool = await getPool();
  const request = pool.request();
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      request.input(key, value);
    }
  }
  const result = await request.query(sqlQuery);
  return result.recordset;
}

module.exports = {
  query,
  getPool,
};
