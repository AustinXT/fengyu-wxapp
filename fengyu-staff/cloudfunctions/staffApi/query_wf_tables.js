const sql = require("mssql");
const connStr = "Server=47.96.87.33,1433;Database=wkdb_20220804_86cd3292;User Id=SD;Password=Se4Qimoh;TrustServerCertificate=True";

(async () => {
  const pool = await sql.connect(connStr);
  
  
  console.log("=== M745: 出库数量 vs 数量 ===");
  const m745 = await pool.request().query(
    "SELECT UDF_M_14566 as outbound_qty, UDF_M_3912 as qty FROM UDT_M_745"
  );
  for (const row of m745.recordset) {
    console.log("  outbound=" + row.outbound_qty + " qty=" + row.qty);
  }

  
  console.log("\n=== M549: 库存可选数量 ===");
  const r549 = await pool.request().query(
    "SELECT COUNT(*) as cnt FROM UDT_M_549 WHERE UDF_M_5523 IS NOT NULL AND UDF_M_5523 != 0"
  );
  console.log("  non-zero: " + r549.recordset[0].cnt + "/761");

  
  console.log("\n=== M588: 退货财务字段 ===");
  const checks588 = [
    ["UDF_M_6230", "批号单价"],
    ["UDF_M_6231", "退货货款"],
    ["UDF_M_5521", "库存数量"],
  ];
  for (const [col, name] of checks588) {
    const r = await pool.request().query(
      "SELECT COUNT(*) as cnt FROM UDT_M_588 WHERE " + col + " IS NOT NULL AND " + col + " != 0"
    );
    console.log("  " + name + " non-zero: " + r.recordset[0].cnt + "/156");
  }

  
  console.log("\n=== M586: 报损字段 ===");
  const r5181 = await pool.request().query(
    "SELECT COUNT(*) as cnt FROM UDT_M_586 WHERE UDF_M_5181 IS NOT NULL AND UDF_M_5181 != ''"
  );
  console.log("  报损原因 non-empty: " + r5181.recordset[0].cnt + "/38505");
  const r5173 = await pool.request().query(
    "SELECT COUNT(*) as cnt FROM UDT_M_586 WHERE UDF_M_5173 IS NOT NULL AND UDF_M_5173 != 0"
  );
  console.log("  可用数量 non-zero: " + r5173.recordset[0].cnt + "/38505");
  
  const d5181 = await pool.request().query(
    "SELECT DISTINCT UDF_M_5181 FROM UDT_M_586 WHERE UDF_M_5181 IS NOT NULL AND UDF_M_5181 != ''"
  );
  console.log("  报损原因 distinct values: " + d5181.recordset.map(r => r.UDF_M_5181).join(", "));
  
  
  console.log("\n=== S539: 入库源字段 ===");
  const r6240 = await pool.request().query(
    "SELECT COUNT(*) as cnt FROM UDT_S_539 WHERE UDF_S_6240 IS NOT NULL AND UDF_S_6240 > '1900-02-01'"
  );
  console.log("  配货日期 valid: " + r6240.recordset[0].cnt + "/7919");
  const r15470 = await pool.request().query(
    "SELECT COUNT(*) as cnt FROM UDT_S_539 WHERE UDF_S_15470 IS NOT NULL AND UDF_S_15470 != 0"
  );
  console.log("  配货数量 non-zero: " + r15470.recordset[0].cnt + "/7919");
  const r19043 = await pool.request().query(
    "SELECT COUNT(*) as cnt FROM UDT_S_539 WHERE UDF_S_19043 IS NOT NULL AND UDF_S_19043 != ''"
  );
  console.log("  签字图 non-empty: " + r19043.recordset[0].cnt + "/7919");

  
  console.log("\n=== M342: 市场字段 sample ===");
  const s6211 = await pool.request().query(
    "SELECT TOP 5 UDF_M_6211, UDF_M_1888, UDF_M_1889 FROM UDT_M_342 WHERE UDF_M_6211 IS NOT NULL AND UDF_M_6211 != ''"
  );
  for (const row of s6211.recordset) {
    console.log("  市场=" + row.UDF_M_6211 + " 编号=" + row.UDF_M_1888 + " 名称=" + row.UDF_M_1889);
  }

  
  console.log("\n=== M602: 验证字段 sample ===");
  const sv = await pool.request().query(
    "SELECT TOP 5 UDF_M_18917, UDF_M_18918, UDF_M_17672, UDF_M_1889 FROM UDT_M_602 WHERE UDF_M_18917 IS NOT NULL AND UDF_M_18917 != ''"
  );
  for (const row of sv.recordset) {
    console.log("  验证名称=" + row.UDF_M_18917 + " 验证编号=" + row.UDF_M_18918 + " 流水号=" + row.UDF_M_17672 + " 产品=" + row.UDF_M_1889);
  }

  await pool.close();
})().catch(e => { console.error(e.message); process.exit(1); });
