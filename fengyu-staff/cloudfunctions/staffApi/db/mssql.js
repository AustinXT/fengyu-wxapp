

const sql = require("mssql");


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
    
    poolPromise.catch(() => {
      poolPromise = null;
    });
  }
  return poolPromise;
}


getPool().catch(() => {});


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
