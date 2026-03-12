const sql = require("mssql");
const connStr = "Server=47.96.87.33,1433;Database=wkdb_20220804_86cd3292;User Id=SD;Password=Se4Qimoh;TrustServerCertificate=True";

(async () => {
  const pool = await sql.connect(connStr);
  
  // Query sample data from each table
  const tables = [
    "UDT_S_336","UDT_M_342",
    "UDT_S_539","UDT_M_540",
    "UDT_S_744","UDT_M_745",
    "UDT_S_601","UDT_M_602",
    "UDT_S_587","UDT_M_588",
    "UDT_S_585","UDT_M_586",
    "UDT_S_612","UDT_M_613",
    "UDT_S_548","UDT_M_549"
  ];
  
  for (const tbl of tables) {
    try {
      const result = await pool.request().query("SELECT TOP 3 * FROM " + tbl);
      console.log("\n=== " + tbl + " (sample " + result.recordset.length + " rows) ===");
      if (result.recordset.length > 0) {
        // Print each row as key:value pairs, skipping system fields
        for (let i = 0; i < result.recordset.length; i++) {
          console.log("--- Row " + (i+1) + " ---");
          const row = result.recordset[i];
          for (const [k, v] of Object.entries(row)) {
            if (["FILLUSERID","FILLORGID","LASTMODUSER","ISINWF","LOCKSTATE","REPORTSTATUS","TAG","WORKFLOWSTATUS"].includes(k)) continue;
            if (v === null || v === "") continue;
            let val = v;
            if (v instanceof Date) val = v.toISOString().slice(0,19);
            console.log("  " + k + ": " + val);
          }
        }
      } else {
        console.log("  (empty table)");
      }
    } catch(e) {
      console.log("\n=== " + tbl + " ERROR: " + e.message + " ===");
    }
  }
  
  await pool.close();
})().catch(e => { console.error(e.message); process.exit(1); });
