/**
 * 从 WorkFine SQL Server 同步商品数据到 PostgreSQL
 *
 * 数据源：
 * - UDT_M_1281: 全国可售项目
 * - UDT_M_1383: 门店自定义项目
 * - UDT_M_1460: 促销方案（JOIN UDT_S_1459 取方案名和市场限制）
 * - UDT_M_341: 家居产品（WorkFine 原始术语为"院装产品"，PG 已统一为"家居产品"）
 */

const sql = require("mssql");
const { Pool } = require("pg");
const crypto = require("crypto");

// 配置
const config = {
  mssql: {
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
  },
  pg: {
    connectionString: process.env.DATABASE_URL || "postgresql://fengyu:fengyu123@localhost:5432/fengyu",
    max: 5,
  },
};

// 生成唯一 ID
function generateId(...parts) {
  const content = parts.join(":");
  return crypto.createHash("sha256").update(content).digest("hex").substring(0, 16);
}

// 生成 SKU 显示名称
function generateSkuDisplayName(productType, sessionCount, specification = null) {
  if (productType === "家居产品") {
    return specification || "院装";
  } else if (productType === "单品") {
    return "单次体验";
  } else {
    return sessionCount ? `${sessionCount}次卡` : "疗程卡";
  }
}

// 映射产品类型
function mapProductType(productTypeRaw) {
  if (!productTypeRaw) return "家居产品";
  if (productTypeRaw.includes("疗程卡")) return "疗程卡";
  if (productTypeRaw.includes("单品")) return "单品";
  return "疗程卡";
}

// 映射大分类
function mapBigCategory(bigCategoryRaw, source) {
  if (source === "UDT_M_341") return "家居产品";

  const trimmed = bigCategoryRaw ? bigCategoryRaw.trim() : "";

  // 处理无效值：空字符串、"是"等
  if (!trimmed || trimmed === "是" || trimmed === "否") {
    return "护理项目";
  }

  // 旧值映射到新值
  if (trimmed === "生美" || trimmed === "非生美" || trimmed === "护理项目") {
    return "护理项目";
  }

  if (trimmed === "院装产品" || trimmed === "家居产品") {
    return "家居产品";
  }

  // 默认值
  return "护理项目";
}

// 查询 WorkFine 数据
async function fetchWorkFineData(mssqlPool) {
  const queries = {
    // UDT_M_1281: 全国可售项目
    UDT_M_1281: `
      SELECT
        RTRIM(UDF_M_14503) AS workfine_item_id,
        RTRIM(UDF_M_14505) AS name,
        RTRIM(UDF_M_14504) AS category,
        RTRIM(UDF_M_17783) AS big_category_raw,
        UDF_M_14506 AS session_count,
        UDF_M_14508 AS original_price,
        RTRIM(UDF_M_14502) AS product_type_raw,
        NULL AS plan_name,
        NULL AS market_restriction
      FROM UDT_M_1281
      WHERE UDF_M_14508 > 0
        AND UDF_M_14503 IS NOT NULL
        AND UDF_M_14505 IS NOT NULL
    `,

    // UDT_M_1383: 门店自定义项目（JOIN UDT_S_1382 取市场限制）
    UDT_M_1383: `
      SELECT
        RTRIM(m.UDF_M_14503) AS workfine_item_id,
        RTRIM(m.UDF_M_14505) AS name,
        RTRIM(m.UDF_M_14504) AS category,
        RTRIM(m.UDF_M_17784) AS big_category_raw,
        m.UDF_M_14506 AS session_count,
        m.UDF_M_14508 AS original_price,
        RTRIM(m.UDF_M_14502) AS product_type_raw,
        NULL AS plan_name,
        RTRIM(s.UDF_S_15997) AS market_restriction
      FROM UDT_M_1383 m
      INNER JOIN UDT_S_1382 s ON m.RID = s.RID
      WHERE m.UDF_M_17415 = '是'
        AND m.UDF_M_14503 IS NOT NULL
        AND m.UDF_M_14505 IS NOT NULL
    `,

    // UDT_M_1460: 促销方案（JOIN UDT_S_1459 取方案名和市场限制）
    UDT_M_1460: `
      SELECT
        RTRIM(m.UDF_M_17163) AS workfine_item_id,
        RTRIM(m.UDF_M_17165) AS name,
        RTRIM(ISNULL(s.UDF_S_17175, '')) AS plan_name,
        RTRIM(m.UDF_M_17164) AS category_raw,
        m.UDF_M_17167 AS session_count,
        m.UDF_M_17168 AS original_price,
        RTRIM(m.UDF_M_17162) AS product_type_raw,
        RTRIM(s.UDF_S_17793) AS market_restriction
      FROM UDT_M_1460 m
      INNER JOIN UDT_S_1459 s ON m.RID = s.RID
      WHERE m.UDF_M_17163 IS NOT NULL
        AND m.UDF_M_17165 IS NOT NULL
        AND (s.UDF_S_17157 IS NULL OR s.UDF_S_17157 <= GETDATE())
        AND (s.UDF_S_17158 IS NULL OR s.UDF_S_17158 >= GETDATE())
    `,

    // UDT_M_341: 家居产品（WorkFine 原表为"院装产品"）
    UDT_M_341: `
      SELECT
        RTRIM(UDF_M_1870) AS workfine_item_id,
        RTRIM(UDF_M_1871) AS name,
        RTRIM(UDF_M_1874) AS category,
        NULL AS big_category_raw,
        NULL AS session_count,
        UDF_M_1875 AS original_price,
        NULL AS product_type_raw,
        NULL AS plan_name,
        NULL AS market_restriction
      FROM UDT_M_341
      WHERE UDF_M_7494 = '是'
        AND UDF_M_1870 IS NOT NULL
        AND UDF_M_1871 IS NOT NULL
    `,
  };

  const results = {};

  for (const [source, query] of Object.entries(queries)) {
    try {
      const result = await mssqlPool.request().query(query);
      results[source] = result.recordset;
      console.log(`✓ ${source}: 查询到 ${result.recordset.length} 条记录`);
    } catch (error) {
      console.error(`✗ ${source} 查询失败:`, error.message);
      results[source] = [];
    }
  }

  return results;
}

// 转换数据为 SPU 和 SKU 映射
function transformData(workFineData) {
  const spuMap = new Map(); // spu_id -> spu_data
  const skuList = [];

  for (const [source, records] of Object.entries(workFineData)) {
    for (const record of records) {
      const {
        workfine_item_id,
        name,
        category,
        big_category_raw,
        session_count,
        product_type_raw,
        plan_name,
        market_restriction,
      } = record;

      // 确定分类和大分类
      let spuCategory, spuBigCategory, spuMarketRestriction;

      if (source === "UDT_M_1460") {
        // 促销方案：category 用方案名（plan_name），无方案名归入"其他"
        spuCategory = plan_name && plan_name.trim() ? plan_name.trim() : "其他";
        spuBigCategory = "促销方案";
        spuMarketRestriction = (market_restriction && market_restriction.trim()) || null;
      } else if (source === "UDT_M_1383") {
        spuCategory = category;
        spuBigCategory = mapBigCategory(big_category_raw, source);
        spuMarketRestriction = (market_restriction && market_restriction.trim()) || null;
      } else {
        // UDT_M_1281 / UDT_M_341：无市场限制
        spuCategory = category;
        spuBigCategory = mapBigCategory(big_category_raw, source);
        spuMarketRestriction = null;
      }

      // 生成 SPU ID (基于名称和分类去重)
      const spuId = generateId(name, spuCategory);

      // 如果 SPU 不存在，创建它
      if (!spuMap.has(spuId)) {
        spuMap.set(spuId, {
          spu_id: spuId,
          name: name,
          category: spuCategory,
          big_category: spuBigCategory,
          cover_image: null,
          description: null,
          sort_order: 0,
        });
      }

      // 创建 SKU 映射
      const productType = mapProductType(product_type_raw);
      const skuDisplayName = generateSkuDisplayName(productType, session_count);

      skuList.push({
        sku_id: generateId(spuId, workfine_item_id, source),
        spu_id: spuId,
        workfine_item_id: workfine_item_id,
        workfine_source: source,
        product_type: productType,
        sku_display_name: skuDisplayName,
        sort_order: 0,
        is_active: true,
        market_restriction: spuMarketRestriction,
      });
    }
  }

  return {
    spuList: Array.from(spuMap.values()),
    skuList: skuList,
  };
}

// 同步数据到 PostgreSQL
async function syncToPostgreSQL(pgPool, spuList, skuList, dryRun = false) {
  const client = await pgPool.connect();

  try {
    await client.query("BEGIN");

    if (!dryRun) {
      // 禁用外键约束检查（临时）
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      console.log("✓ 已禁用外键约束检查");
    }

    // 插入 SPU（使用 ON CONFLICT DO UPDATE 实现增量更新）
    let spuInserted = 0;
    for (const spu of spuList) {
      if (dryRun) {
        console.log(`[DRY-RUN] SPU: ${spu.name} (${spu.big_category})`);
      } else {
        await client.query(
          `INSERT INTO product_spu (spu_id, name, category, big_category, cover_image, description, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (spu_id) DO UPDATE SET
             name = EXCLUDED.name,
             category = EXCLUDED.category,
             big_category = EXCLUDED.big_category`,
          [spu.spu_id, spu.name, spu.category, spu.big_category, spu.cover_image, spu.description, spu.sort_order],
        );
      }
      spuInserted++;
    }
    console.log(`✓ SPU: ${dryRun ? "将插入" : "已插入/更新"} ${spuInserted} 条`);

    // 插入 SKU 映射
    let skuInserted = 0;
    for (const sku of skuList) {
      if (dryRun) {
        console.log(
          `[DRY-RUN] SKU: ${sku.sku_display_name} -> ${sku.workfine_item_id} (${sku.workfine_source}) market=${sku.market_restriction || "null"}`,
        );
      } else {
        await client.query(
          `INSERT INTO product_spu_sku_map
           (sku_id, spu_id, workfine_item_id, workfine_source, product_type, sku_display_name, sort_order, is_active, market_restriction)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (sku_id) DO UPDATE SET
             workfine_item_id = EXCLUDED.workfine_item_id,
             workfine_source = EXCLUDED.workfine_source,
             product_type = EXCLUDED.product_type,
             sku_display_name = EXCLUDED.sku_display_name,
             market_restriction = EXCLUDED.market_restriction`,
          [
            sku.sku_id,
            sku.spu_id,
            sku.workfine_item_id,
            sku.workfine_source,
            sku.product_type,
            sku.sku_display_name,
            sku.sort_order,
            sku.is_active,
            sku.market_restriction,
          ],
        );
      }
      skuInserted++;
    }
    console.log(`✓ SKU: ${dryRun ? "将插入" : "已插入"} ${skuInserted} 条`);

    if (!dryRun) {
      await client.query("COMMIT");
      console.log("✓ 事务已提交");
    } else {
      await client.query("ROLLBACK");
      console.log("✓ DRY-RUN 模式，已回滚");
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// 验证数据
async function verifyData(pgPool) {
  const client = await pgPool.connect();

  try {
    // 按数据源统计
    const sourceStats = await client.query(`
      SELECT workfine_source, COUNT(*) as count
      FROM product_spu_sku_map
      GROUP BY workfine_source
      ORDER BY workfine_source
    `);
    console.log("\n=== 数据源统计 ===");
    sourceStats.rows.forEach((row) => {
      console.log(`${row.workfine_source}: ${row.count} 条`);
    });

    // 按大分类统计
    const categoryStats = await client.query(`
      SELECT big_category, COUNT(*) as count
      FROM product_spu
      GROUP BY big_category
      ORDER BY big_category
    `);
    console.log("\n=== SPU 大分类统计 ===");
    categoryStats.rows.forEach((row) => {
      console.log(`${row.big_category}: ${row.count} 条`);
    });

    // 按产品类型统计
    const typeStats = await client.query(`
      SELECT product_type, COUNT(*) as count
      FROM product_spu_sku_map
      GROUP BY product_type
      ORDER BY product_type
    `);
    console.log("\n=== SKU 产品类型统计 ===");
    typeStats.rows.forEach((row) => {
      console.log(`${row.product_type}: ${row.count} 条`);
    });
  } finally {
    client.release();
  }
}

// 主函数
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  console.log("=== 开始同步 WorkFine 商品数据 ===");
  console.log(`模式: ${dryRun ? "DRY-RUN (预览)" : "正式执行"}`);
  console.log(`PostgreSQL: ${config.pg.connectionString}\n`);

  let mssqlPool = null;
  let pgPool = null;

  try {
    // 连接数据库
    console.log("连接 WorkFine SQL Server...");
    mssqlPool = await sql.connect(config.mssql);
    console.log("✓ WorkFine 连接成功\n");

    console.log("连接 PostgreSQL...");
    pgPool = new Pool(config.pg);
    await pgPool.query("SELECT NOW()");
    console.log("✓ PostgreSQL 连接成功\n");

    // 查询 WorkFine 数据
    console.log("=== 从 WorkFine 提取数据 ===");
    const workFineData = await fetchWorkFineData(mssqlPool);

    // 转换数据
    console.log("\n=== 数据转换 ===");
    const { spuList, skuList } = transformData(workFineData);
    console.log(`✓ 生成 SPU: ${spuList.length} 条`);
    console.log(`✓ 生成 SKU: ${skuList.length} 条\n`);

    // 同步到 PostgreSQL
    console.log("=== 同步到 PostgreSQL ===");
    await syncToPostgreSQL(pgPool, spuList, skuList, dryRun);

    // 验证数据
    if (!dryRun) {
      console.log("\n=== 验证数据 ===");
      await verifyData(pgPool);
    }

    console.log("\n✓ 同步完成!");
  } catch (error) {
    console.error("\n✗ 同步失败:", error);
    process.exit(1);
  } finally {
    if (mssqlPool) {
      await mssqlPool.close();
    }
    if (pgPool) {
      await pgPool.end();
    }
  }
}

main();
