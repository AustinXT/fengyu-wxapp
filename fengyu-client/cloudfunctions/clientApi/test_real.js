/**
 * clientApi 云函数真实测试
 * 使用真实的 PG 和 MSSQL 连接测试三个核心接口
 */

const pg = require('./db/pg')
const mssql = require('./db/mssql')

// 测试商品分类接口
async function testCategories() {
  console.log('\n========================================')
  console.log('测试 1: product.categories')
  console.log('========================================')

  try {
    // 模拟未绑定门店的查询
    let categoriesSql = `
      SELECT
        p.category,
        p.big_category,
        MIN(p.sort_order) AS category_order
      FROM product_spu p
      WHERE p.big_category != '院装产品'
        AND EXISTS (
          SELECT 1 FROM product_spu_sku_map m
          WHERE m.spu_id = p.spu_id AND m.is_active = true
        )
        AND EXISTS (
          SELECT 1 FROM product_spu_sku_map m
          WHERE m.spu_id = p.spu_id
            AND m.is_active = true
            AND m.workfine_source IN ('UDT_M_1281', 'UDT_M_341')
        )
      GROUP BY p.category, p.big_category
      ORDER BY MIN(p.sort_order) ASC
    `

    const categoriesResult = await pg.query(categoriesSql)

    // 院装产品分类
    let inStoreSql = `
      SELECT
        '院装产品' AS category,
        '院装产品' AS big_category,
        MIN(p.sort_order) AS category_order
      FROM product_spu p
      WHERE p.big_category = '院装产品'
        AND EXISTS (
          SELECT 1 FROM product_spu_sku_map m
          WHERE m.spu_id = p.spu_id AND m.is_active = true
        )
        AND EXISTS (
          SELECT 1 FROM product_spu_sku_map m
          WHERE m.spu_id = p.spu_id
            AND m.is_active = true
            AND m.workfine_source = 'UDT_M_341'
        )
    `

    const inStoreResult = await pg.query(inStoreSql)

    const result = {
      categories: [...categoriesResult, ...inStoreResult]
    }

    console.log('✅ 查询成功!')
    console.log(`   - 生美/非生美分类: ${categoriesResult.length} 个`)
    console.log(`   - 院装产品分类: ${inStoreResult.length} 个`)
    console.log(`   - 总计: ${result.categories.length} 个分类`)

    if (result.categories.length > 0) {
      console.log('\n   前 5 个分类:')
      result.categories.slice(0, 5).forEach((cat, i) => {
        console.log(`   ${i + 1}. ${cat.category} (${cat.big_category}) - 排序: ${cat.category_order}`)
      })
    }

    return result
  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    throw error
  }
}

// 测试商品列表接口
async function testSpuList() {
  console.log('\n========================================')
  console.log('测试 2: product.spuList (生美分类)')
  console.log('========================================')

  try {
    const bigCategory = '生美'

    // 查询 SPU 列表
    let whereClause = `
      WHERE EXISTS (SELECT 1 FROM product_spu_sku_map m WHERE m.spu_id = p.spu_id AND m.is_active = true)
        AND EXISTS (
          SELECT 1 FROM product_spu_sku_map m
          WHERE m.spu_id = p.spu_id
            AND m.is_active = true
            AND m.workfine_source IN ('UDT_M_1281', 'UDT_M_341')
        )
        AND p.big_category = $1
    `
    const params = [bigCategory]

    const spuList = await pg.query(`
      SELECT
        p.spu_id,
        p.name,
        p.category,
        p.big_category,
        p.cover_image,
        p.description,
        p.sort_order
      FROM product_spu p
      ${whereClause}
      ORDER BY p.sort_order ASC
      LIMIT 3
    `, params)

    console.log(`✅ 查询成功! 找到 ${spuList.length} 个 SPU (限制显示前3个)`)

    // 查询第一个 SPU 的 SKU 列表
    if (spuList.length > 0) {
      const spu = spuList[0]
      console.log(`\n   第一个 SPU: ${spu.name}`)

      const skuList = await pg.query(`
        SELECT
          sku_id,
          workfine_item_id,
          workfine_source,
          product_type,
          sku_display_name,
          sort_order
        FROM product_spu_sku_map
        WHERE spu_id = $1 AND is_active = true
          AND workfine_source IN ('UDT_M_1281', 'UDT_M_341')
        ORDER BY sort_order ASC
        LIMIT 3
      `, [spu.spu_id])

      console.log(`   - SKU 数量: ${skuList.length} 个 (限制显示前3个)`)

      if (skuList.length > 0) {
        const sku = skuList[0]
        console.log(`   - 第一个 SKU: ${sku.sku_display_name}`)
        console.log(`     来源: ${sku.workfine_source}`)

        // 从 WorkFine 读取价格信息
        if (sku.workfine_source === 'UDT_M_1281') {
          const priceSql = `
            SELECT
              UDF_M_14503 AS item_id,
              UDF_M_14505 AS item_name,
              UDF_M_14506 AS session_count,
              UDF_M_14508 AS original_price
            FROM UDT_M_1281
            WHERE UDF_M_14503 = '${sku.workfine_item_id}'
          `
          const priceData = await mssql.query(priceSql)

          if (priceData.length > 0) {
            console.log(`     价格: ¥${priceData[0].original_price}`)
            console.log(`     次数: ${priceData[0].session_count} 次`)
          }
        }
      }
    }

    return { spuList }
  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    throw error
  }
}

// 测试门店列表接口
async function testStoreList() {
  console.log('\n========================================')
  console.log('测试 3: store.list')
  console.log('========================================')

  try {
    const sql = `
      SELECT
        UDF_M_437 AS market_name,
        UDF_M_438 AS store_name,
        UDF_M_1777 AS open_date,
        UDF_M_8590 AS available_beds,
        UDF_M_12033 AS store_region
      FROM UDT_M_219
      WHERE UDF_M_11956 != '是'
      ORDER BY UDF_M_437, UDF_M_438
    `

    const stores = await mssql.query(sql)

    console.log(`✅ 查询成功! 找到 ${stores.length} 个营业中的门店`)

    if (stores.length > 0) {
      // 统计市场分布
      const markets = {}
      stores.forEach(store => {
        markets[store.market_name] = (markets[store.market_name] || 0) + 1
      })

      console.log(`\n   市场分布:`)
      Object.entries(markets).forEach(([market, count]) => {
        console.log(`   - ${market}: ${count} 家门店`)
      })

      console.log(`\n   前 5 个门店:`)
      stores.slice(0, 5).forEach((store, i) => {
        console.log(`   ${i + 1}. ${store.market_name} - ${store.store_name}`)
        if (store.available_beds) {
          console.log(`      床位数: ${store.available_beds}`)
        }
      })
    }

    return { stores }
  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    throw error
  }
}

// 运行所有测试
async function runAllTests() {
  console.log('========================================')
  console.log('clientApi 核心接口集成测试')
  console.log('========================================')
  console.log('测试时间:', new Date().toLocaleString('zh-CN'))

  try {
    // 测试数据库连接
    console.log('\n🔍 检查数据库连接...')
    await pg.query('SELECT 1 as test')
    console.log('   ✅ PG 数据库连接正常')

    await mssql.query('SELECT 1 as test')
    console.log('   ✅ MSSQL 数据库连接正常')

    // 运行测试
    await testCategories()
    await testSpuList()
    await testStoreList()

    console.log('\n========================================')
    console.log('✅ 所有测试通过!')
    console.log('========================================\n')

  } catch (error) {
    console.error('\n========================================')
    console.error('❌ 测试失败!')
    console.error('========================================')
    console.error('错误信息:', error.message)
    console.error('错误堆栈:', error.stack)
    process.exit(1)
  } finally {
    // 关闭数据库连接
    await pg.end()
    await mssql.end()
  }
}

// 运行测试
runAllTests()
