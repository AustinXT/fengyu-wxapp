/**
 * 商品模块路由（客户端/商城管理）
 * 数据从 PG mall_categories / products / mall_product_skus / product_skus 查询
 */

const pg = require('../db/pg')
const {
  safeThumbUrl,
  safeThumbUrlByArea,
  PRODUCT_THUMB_BOX_SMALL,
  PRODUCT_THUMB_BOX_LARGE,
  PRODUCT_DETAIL_IMAGE_MAX_PIXELS,
  PRODUCT_DETAIL_IMAGE_MAX_COUNT,
} = require('../utils/image')

/**
 * 有效性过滤条件（商城商品层 + SKU 层叠加）
 *
 * 商城常规通道默认排除体验卡（sk.is_experience=true，仅 client 体验卡入口可见）。
 * 充值卡已剥离 SKU 化（2026-05-20），不再有充值卡 SKU 需要过滤。
 */
const PRODUCT_VALID_FILTER = `p.deleted_at IS NULL AND p.is_visible = true`
const SKU_VALID_FILTER = `sk.is_enabled = true AND sk.deleted_at IS NULL AND NOT sk.is_experience`

function marketScopeValues(scopeExpr) {
  return `string_to_array(replace(${scopeExpr}, ' ', ''), ',')`
}

/**
 * 商品 / SKU 可见范围过滤（*.market_scope）。
 *
 * admin 保存的是逗号分隔的市场 org_nodes.id；历史数据可能是市场名。
 * 顾客端只有 boundStoreId / boundMarketName，因此优先用门店反查市场 id/name，
 * 同时兼容旧的名称匹配。普通商城浏览在未绑门店时先按商品层全市场准入，
 * 再允许该商品下配置了具体市场的有效 SKU 用于展示。
 *
 * 语义约定（2026-08-06 修复）：
 * - NULL = 全部市场可见
 * - '' (空字符串) = 不可见于任何市场
 * - 'id1,id2' = 仅指定市场可见
 */
function buildMarketScopeFilter(auth, params, tableAlias) {
  const scopeExpr = `${tableAlias}.market_scope`
  const valuesExpr = marketScopeValues(scopeExpr)
  const globalExpr = `${scopeExpr} IS NULL`
  const storeId = auth?.boundStoreId || null
  const marketName = auth?.boundMarketName || null

  if (storeId) {
    params.push([storeId])
    const storeParam = `$${params.length}`
    return `AND (
      ${globalExpr}
      OR EXISTS (
        SELECT 1
        FROM stores s
        JOIN org_nodes sn ON s.org_node_id = sn.id
        JOIN org_nodes pm ON sn.parent_id = pm.id
        WHERE s.store_id = ANY(${storeParam})
          AND (
            pm.id = ANY(${valuesExpr})
            OR replace(pm.name, ' ', '') = ANY(${valuesExpr})
          )
      )
    )`
  }

  if (marketName) {
    params.push(marketName)
    return `AND (${globalExpr} OR replace($${params.length}, ' ', '') = ANY(${valuesExpr}))`
  }

  return `AND ${globalExpr}`
}

/**
 * 普通商城浏览的 SKU 可见范围过滤。
 *
 * 未绑定门店时，商品层的 market_scope 已由调用方严格限定为 NULL（全部市场）。
 * 此时允许商品下的指定市场 SKU 展示，只有空字符串（明确表示任何市场不可见）
 * 仍需排除。绑定门店或仅有历史市场名时，沿用标准门店/市场范围过滤。
 */
function buildCatalogSkuMarketScopeFilter(auth, params, tableAlias = 'sk') {
  const hasStore = Boolean(auth?.boundStoreId)
  const hasMarket = Boolean(auth?.boundMarketName)

  if (!hasStore && !hasMarket) {
    const scopeExpr = `${tableAlias}.market_scope`
    return `AND (${scopeExpr} IS NULL OR btrim(${scopeExpr}) <> '')`
  }

  return buildMarketScopeFilter(auth, params, tableAlias)
}

/**
 * 计算 SPU 列表展示价（priceFrom / listPriceFrom）
 *
 * 组合套餐（is_bundle）展示套餐总价（SPU 的 special_price / price），
 * 而非单次套餐价（SKU bundle_price）——例如「599 体验福利」应展示总价 599，
 * 而非单次套餐价 199.67（≈ 599 ÷ 招牌任选 3 次）。
 * 普通单品维持各 SKU 最低起价（bundle_price 优先，含 special_price 会员视图）。
 */
function computeListPriceFrom(product, skus) {
  if (product.is_bundle) {
    const listPrice = Number(product.price)
    const specialPrice = product.special_price != null ? Number(product.special_price) : listPrice
    return {
      priceFrom: specialPrice,
      listPriceFrom: listPrice,
    }
  }
  const prices = skus.map(s => Number(s.bundle_price || s.special_price || s.price || 0))
  const listPrices = skus.map(s => Number(s.bundle_price || s.price || 0))
  return {
    priceFrom: prices.length > 0 ? Math.min(...prices) : null,
    listPriceFrom: listPrices.length > 0 ? Math.min(...listPrices) : null,
  }
}

/**
 * 内部函数：获取商品分类列表（mall_categories）
 * 仅返回含有效商品的分类
 */
async function getCategoriesList(auth) {
  const params = []
  const productMarketScopeFilter = buildMarketScopeFilter(auth, params, 'p')
  const skuMarketScopeFilter = buildCatalogSkuMarketScopeFilter(auth, params, 'sk')

  const sql = `
    SELECT
      mc.category_id,
      mc.category_name,
      mc.category_group,
      mc.sort_order AS category_order
    FROM mall_categories mc
    WHERE EXISTS (
        SELECT 1 FROM products p
        JOIN mall_product_skus mps ON mps.product_id = p.product_id
        JOIN product_skus sk ON mps.sku_id = sk.sku_id
        WHERE p.category_id = mc.category_id
          AND ${PRODUCT_VALID_FILTER}
          ${productMarketScopeFilter}
          AND ${SKU_VALID_FILTER}
          ${skuMarketScopeFilter}
      )
    ORDER BY mc.sort_order ASC
  `

  return pg.query(sql, params)
}

/**
 * 内部函数：获取一级分组列表（category_group IS NULL）
 * 仅返回下属二级分类中含有效商品的分组
 */
async function getCategoryGroups(auth) {
  const params = []
  const productMarketScopeFilter = buildMarketScopeFilter(auth, params, 'p')
  const skuMarketScopeFilter = buildCatalogSkuMarketScopeFilter(auth, params, 'sk')

  const sql = `
    SELECT
      mg.category_id,
      mg.category_name,
      mg.sort_order
    FROM mall_categories mg
    WHERE mg.category_group IS NULL
      AND EXISTS (
        SELECT 1 FROM mall_categories mc
        WHERE mc.category_group = mg.category_name
          AND EXISTS (
            SELECT 1 FROM products p
            JOIN mall_product_skus mps ON mps.product_id = p.product_id
            JOIN product_skus sk ON mps.sku_id = sk.sku_id
            WHERE p.category_id = mc.category_id
              AND ${PRODUCT_VALID_FILTER}
              ${productMarketScopeFilter}
              AND ${SKU_VALID_FILTER}
              ${skuMarketScopeFilter}
          )
      )
    ORDER BY mg.sort_order ASC
  `

  return pg.query(sql, params)
}

/**
 * 商品分类列表
 */
async function categories(ctx) {
  const categoriesList = await getCategoriesList(ctx.auth)
  ctx.result = { categories: categoriesList }
}

/**
 * issue #248：商品列表硬分页。
 *
 * 默认 20：实测生产（dev 为 prod 副本）最大分类 10 个商品、最坏单字关键词搜索命中 15 个，
 * 因此未发版的老前端（不传 limit/cursor）当前零截断；未来商品数增长时被截在 20 条，
 * 是刻意的页面级解码量硬上限，优于改造前的无界返回。
 * 上限 50：防客户端传 limit=9999 绕过硬上限。
 */
const PRODUCT_PAGE_SIZE_DEFAULT = 20
const PRODUCT_PAGE_SIZE_MAX = 50

/**
 * ⚠️ 分页入参归一在本仓有多份，**各自保留副本**（用户已 veto cloudfunctions-shared），
 * 语义各不相同，改这里前先确认你要的是哪一份：
 * - `fengyu-admin/src/lib/export-pagination.ts`：`limit == null` → 不分页返全量
 * - `fengyu-staff/cloudfunctions/staffApi/utils/paging.js`：非法值回落默认，不抛（#240 修过 `Number()` 可抛的坑）
 * - `clientApi/routes/points.js:72-85`：同端已有一份严格校验，口径与本函数一致
 * - 本函数：非法值一律抛 `INVALID_PARAMS`（顾客端没有「全量」这个合法语义）
 *
 * clientApi 内还有 5 个列表接口是零校验/半校验的，收编工作见 issue #272，不在本函数范围。
 *
 * 只收 `number`，不做隐式转换：`Number(raw)` 对 `true` 给 1、对 `['20']` 给 20、
 * 对 `'0x14'` 给 20（全部静默接受），对 `{toString:null}`（合法 JSON）直接抛
 * `TypeError: Cannot convert object to primitive value` —— 那条错误没有白名单前缀，
 * 会被全局 catch 降级成 `{code:-1,'服务器内部错误'}` 而不是 -400。
 */
function normalizeProductPageSize(raw, defaultSize = PRODUCT_PAGE_SIZE_DEFAULT) {
  if (raw === undefined || raw === null) return defaultSize
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error('INVALID_PARAMS: limit 必须是正整数')
  }
  return Math.min(raw, PRODUCT_PAGE_SIZE_MAX)
}

/**
 * 复合游标 (sort_order, product_id)。
 *
 * products.sort_order 可重复（integer NOT NULL DEFAULT 0），单列游标会漏行/重行，
 * 故与主键 product_id 组成复合键，配合行值比较保证全序。
 * 对外是不透明 base64 串，前端只需原样回传。
 */
/**
 * 游标长度上限只为挡「10MB base64 走完 Buffer + JSON.parse 才被拒」这种浪费，
 * 不是业务约束。`products.product_id` 是 **无长度约束的 text**（生产实际值形如
 * `prod-1786781954741`，约 18 字符），所以阈值必须留足冗余，
 * 否则会出现「服务端生成的 nextCursor 被自己拒收」的死局。
 */
const PRODUCT_CURSOR_MAX_LENGTH = 2048
const INT4_MIN = -2147483648
const INT4_MAX = 2147483647

function encodeProductCursor(row) {
  return Buffer.from(
    JSON.stringify([Number(row.sort_order), String(row.product_id)]),
    'utf8'
  ).toString('base64')
}

function decodeProductCursor(raw) {
  const bad = () => new Error('INVALID_PARAMS: cursor 不合法')

  // 缺省即「首页」。CloudBase payload 是 JSON，表达不出 undefined，
  // 所以 null 与 undefined 在本接口**等价**视为首页；空串 / 0 / 对象一律视为畸形游标。
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string' || raw === '') throw bad()
  // 合法游标 base64 后 < 60 字符。先卡长度，别让 10MB 的串走完 Buffer + JSON.parse 才被拒。
  if (raw.length > PRODUCT_CURSOR_MAX_LENGTH) throw bad()

  let parsed
  try {
    // Buffer.from(x, 'base64') 对非法字符是静默忽略而非抛错，真正的守门人是 JSON.parse
    parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
  } catch (e) {
    throw bad()
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw bad()

  const [sortOrder, productId] = parsed
  if (!Number.isInteger(sortOrder) || typeof productId !== 'string' || productId === '') throw bad()
  // sort_order 是 int4。超范围的值走到 `$n::int` 会让 PG 抛 22003，
  // 那条错误没有白名单前缀 → 降级成 -1「服务器内部错误」，而且库已经白打了一次。
  if (sortOrder < INT4_MIN || sortOrder > INT4_MAX) throw bad()

  return { sortOrder, productId }
}

/**
 * 内部函数：按分类获取商城商品列表（含 SKU）
 *
 * issue #248：返回 { items, nextCursor, hasMore }（原先直接返回数组）。
 * 三个入口 spuList / search / shopInit 共用，一处改写覆盖三者。
 */
async function getProductListByCategory({ categoryId, auth, keyword, limit, cursor }) {
  // 入参校验先于任何查询
  const pageSize = normalizeProductPageSize(limit)
  const decodedCursor = decodeProductCursor(cursor)

  const params = []
  const productMarketScopeFilter = buildMarketScopeFilter(auth, params, 'p')
  let whereClause = `WHERE ${PRODUCT_VALID_FILTER} ${productMarketScopeFilter}`

  if (categoryId) {
    params.push(categoryId)
    whereClause += ` AND p.category_id = $${params.length}`
  }

  // 全量搜索：按商品名模糊匹配（首页搜索框，跨全部分类）
  if (keyword) {
    params.push(`%${keyword}%`)
    whereClause += ` AND p.name ILIKE $${params.length}`
  }

  // issue #248 keyset 翻页：行值比较取「排在游标之后」的行。
  // sort_order / product_id 两列都是 NOT NULL，不存在 NULL 传播导致静默丢行。
  // 参数按 text 下发，须显式转型，否则行值比较的类型推断会失败。
  if (decodedCursor) {
    params.push(decodedCursor.sortOrder, decodedCursor.productId)
    whereClause += ` AND (p.sort_order, p.product_id) > ($${params.length - 1}::int, $${params.length}::text)`
  }

  // 仅返回有有效 SKU 的商品
  const existsSkuMarketScopeFilter = buildCatalogSkuMarketScopeFilter(auth, params, 'sk')
  whereClause += ` AND EXISTS (
    SELECT 1 FROM mall_product_skus mps
    JOIN product_skus sk ON mps.sku_id = sk.sku_id
    WHERE mps.product_id = p.product_id
      AND ${SKU_VALID_FILTER}
      ${existsSkuMarketScopeFilter}
  )`

  // 多取一行作探测行，用于判定 hasMore（不额外打一次 count 查询）
  params.push(pageSize + 1)
  const probedRows = await pg.query(`
    SELECT
      p.product_id, p.name, p.category_id,
      mc.category_name,
      p.cover_image, p.sort_order,
      p.price, p.special_price, p.is_bundle
    FROM products p
    JOIN mall_categories mc ON p.category_id = mc.category_id
    ${whereClause}
    ORDER BY p.sort_order ASC, p.product_id ASC
    LIMIT $${params.length}
  `, params)

  const hasMore = probedRows.length > pageSize
  const productRows = hasMore ? probedRows.slice(0, pageSize) : probedRows
  const nextCursor = hasMore ? encodeProductCursor(productRows[productRows.length - 1]) : null

  // 批量查询所有商品的 SKU（通过 mall_product_skus 关联）
  // PR-D：附带 product_kind + kind_display_color（一级行 display_color），
  // 用于客户端购物车 tag 颜色渲染（DB 驱动）
  const productIds = productRows.map(p => p.product_id)
  let allSkus = []
  if (productIds.length > 0) {
    const skuParams = [productIds]
    const skuMarketScopeFilter = buildCatalogSkuMarketScopeFilter(auth, skuParams, 'sk')
    allSkus = await pg.query(`
      SELECT
        mps.product_id, sk.sku_id, sk.product_type, sk.spec_name,
        sk.price, sk.special_price, sk.session_count, sk.unit,
        sk.service_fee, mps.sort_order AS display_order,
        mps.bundle_price, mps.bundle_group_id,
        bg.group_name, bg.pick_count AS group_pick_count,
        pc.product_kind,
        parent_pc.display_color AS kind_display_color
      FROM mall_product_skus mps
      JOIN product_skus sk ON mps.sku_id = sk.sku_id
      LEFT JOIN product_categories pc ON sk.category_id = pc.category_id
      LEFT JOIN product_categories parent_pc
        ON parent_pc.product_kind IS NULL
       AND parent_pc.category_name = pc.product_kind
      LEFT JOIN mall_bundle_groups bg ON mps.bundle_group_id = bg.id
      WHERE mps.product_id = ANY($1)
        AND ${SKU_VALID_FILTER}
        ${skuMarketScopeFilter}
      ORDER BY mps.sort_order ASC
    `, skuParams)
  }

  const skuByProduct = {}
  for (const sku of allSkus) {
    if (!skuByProduct[sku.product_id]) skuByProduct[sku.product_id] = []
    skuByProduct[sku.product_id].push(sku)
  }

  const spuList = productRows.map(product => {
    const skus = skuByProduct[product.product_id] || []
    const { priceFrom, listPriceFrom } = computeListPriceFrom(product, skus)
    return {
      ...product,
      // issue #230：封面图下发前强制缩略，无法保证缩略时下发 null（前端有占位分支）。
      // 本函数是 spuList / search / shopInit 三个入口的共同实现，一处改写覆盖三者。
      cover_image: safeThumbUrl(product.cover_image, PRODUCT_THUMB_BOX_LARGE),
      skuList: skus,
      priceFrom,
      listPriceFrom
    }
  })

  return { spuList, nextCursor, hasMore }
}

/**
 * 商品列表
 *
 * issue #248：支持 keyset 分页（limit / cursor），返回 nextCursor / hasMore。
 */
async function spuList(ctx) {
  const { categoryId, limit, cursor } = ctx.event.payload || {}
  ctx.result = await getProductListByCategory({ categoryId, auth: ctx.auth, limit, cursor })
}

/**
 * 全量商品搜索（首页搜索框）
 * 按商品名模糊匹配、跨全部分类——替代纯前端本地缓存搜索，
 * 让顾客能搜到任何可见商品（含未浏览过分类的商品）。
 */
async function search(ctx) {
  const { keyword, limit, cursor } = ctx.event.payload || {}
  // 分页入参先校验再短路：空关键词也不该成为绕过 limit/cursor 校验的口子，
  // 否则三个 action 的入参契约不一致（search 返回 code=0，另两个返回 -400）
  normalizeProductPageSize(limit)
  decodeProductCursor(cursor)

  // 非字符串一律当空关键词短路：`(keyword || '').trim()` 对 `[]`（truthy）会抛
  // `trim is not a function` → 没有白名单前缀 → 降级成 -1 而不是走空结果分支
  const kw = typeof keyword === 'string' ? keyword.trim() : ''
  if (!kw) {
    ctx.result = { spuList: [], nextCursor: null, hasMore: false }
    return
  }
  ctx.result = await getProductListByCategory({ auth: ctx.auth, keyword: kw, limit, cursor })
}

/**
 * Shop 页初始化接口（合并 categories + 第一个分类的商品列表）
 *
 * issue #248：额外下发 spuCategoryId —— 本批商品归属哪个分类由后端说了算。
 * 改造前 shop.ts 把这批商品缓存到 `categories[0].category_id`，而这里取的是
 * 「第一个 group 下的第一个二级分类」，两者不必然相同；分页后游标必须与分类严格
 * 对应（否则「加载更多」会翻错分类的下一页），故由后端下发权威值。
 */
async function shopInit(ctx) {
  const { limit, cursor } = ctx.event.payload || {}
  // 入参校验先于任何查询：shopInit 要并发打两个分类查询，畸形入参别让它们先白跑
  normalizeProductPageSize(limit)
  decodeProductCursor(cursor)

  const [groups, categoriesList] = await Promise.all([
    getCategoryGroups(ctx.auth),
    getCategoriesList(ctx.auth),
  ])

  // 找第一个 group 下的第一个二级分类，加载其商品
  let firstCategoryId = null
  if (groups.length > 0 && categoriesList.length > 0) {
    const firstChild = categoriesList.find(c => c.category_group === groups[0].category_name)
    if (firstChild) firstCategoryId = firstChild.category_id
  } else if (categoriesList.length > 0) {
    // 降级：无分组时取第一个分类
    firstCategoryId = categoriesList[0].category_id
  }

  // 透传 cursor：本接口既然下发 nextCursor，就必须收得回来，
  // 否则调用方拿着 nextCursor 再调一次仍是第一页（重复行 / 死循环）
  const firstPage = firstCategoryId
    ? await getProductListByCategory({ categoryId: firstCategoryId, auth: ctx.auth, limit, cursor })
    : { spuList: [], nextCursor: null, hasMore: false }

  ctx.result = {
    groups,
    categories: categoriesList,
    spuCategoryId: firstCategoryId,
    ...firstPage,
  }
}

/**
 * SKU 详情
 */
async function skuDetail(ctx) {
  const { skuId, productId } = ctx.event.payload || {}
  const params = [skuId, productId || null]
  // 结算页的直接下单入口也会调用 skuDetail。未绑定门店时必须与目录详情
  // 使用同一套“全市场商品下允许展示已配置市场 SKU”的规则，否则会出现
  // 目录可选但结算页加载价格失败的断链。
  const marketScopeFilter = buildCatalogSkuMarketScopeFilter(ctx.auth, params, 'sk')

  if (!skuId) {
    throw new Error('INVALID_PARAMS: 缺少 skuId 参数')
  }

  // cover_image 取自 products 表。同一 sku 可挂在多个商品下（mall_product_skus 唯一键
  // 是 (product_id, sku_id) 复合），故传入 productId 时按该商品精确取封面；
  // 缺省时确定性兜底：优先非套餐商品、再按映射插入序，避免随机命中错误封面。
  const rows = await pg.query(`
    SELECT
      sk.sku_id, sk.product_type, sk.spec_name,
      sk.price, sk.special_price, sk.session_count, sk.unit,
      sk.service_fee, sk.sort_order, sk.is_shengmei,
      pc.category_id, pc.category_name, pc.product_kind, pc.sales_category,
      (SELECT p.cover_image FROM mall_product_skus mps
       JOIN products p ON mps.product_id = p.product_id
       WHERE mps.sku_id = sk.sku_id
         AND ($2::text IS NULL OR mps.product_id = $2)
       ORDER BY p.is_bundle ASC, mps.id ASC
       LIMIT 1) AS cover_image
    FROM product_skus sk
    JOIN product_categories pc ON sk.category_id = pc.category_id
    WHERE sk.sku_id = $1 AND sk.deleted_at IS NULL
      ${marketScopeFilter}
  `, params)

  if (rows.length === 0) {
    throw new Error('INVALID_PARAMS: 商品不存在')
  }

  const sku = rows[0]
  // issue #230：结算页（120rpx）与体验卡详情页（整屏 480rpx 头图）共用本接口，按大者取档
  sku.cover_image = safeThumbUrl(sku.cover_image, PRODUCT_THUMB_BOX_LARGE)

  ctx.result = { sku }
}

/**
 * 热门推荐列表
 */
const HOT_LIST_DEFAULT_LIMIT = 6

async function hotList(ctx) {
  const { limit } = ctx.event.payload || {}
  // issue #248：原先是 `const { limit = 6 }` 直进 `LIMIT $1`。解构默认值只对 undefined 生效，
  // 所以 `{limit:null}` 会下发 `LIMIT NULL` —— **在 PG 里等于不限行数**，而本接口下发 cover_image；
  // `{limit:'abc'}` 则让 PG 抛 int8in 语法错。与列表接口共用同一套归一。
  const params = [normalizeProductPageSize(limit, HOT_LIST_DEFAULT_LIMIT)]
  const productMarketScopeFilter = buildMarketScopeFilter(ctx.auth, params, 'p')
  const existsSkuMarketScopeFilter = buildCatalogSkuMarketScopeFilter(ctx.auth, params, 'sk')

  const productRows = await pg.query(`
    SELECT
      p.product_id, p.name, p.category_id,
      mc.category_name,
      p.cover_image, p.sort_order,
      p.price, p.special_price, p.is_bundle
    FROM products p
    JOIN mall_categories mc ON p.category_id = mc.category_id
    WHERE ${PRODUCT_VALID_FILTER}
      ${productMarketScopeFilter}
      AND EXISTS (
        SELECT 1 FROM mall_product_skus mps
        JOIN product_skus sk ON mps.sku_id = sk.sku_id
        WHERE mps.product_id = p.product_id
          AND ${SKU_VALID_FILTER}
          ${existsSkuMarketScopeFilter}
      )
    ORDER BY p.sort_order ASC
    LIMIT $1
  `, params)

  // 批量查询 SKU（取最低价）
  const productIds = productRows.map(p => p.product_id)
  let allSkus = []
  if (productIds.length > 0) {
    const skuParams = [productIds]
    const skuMarketScopeFilter = buildCatalogSkuMarketScopeFilter(ctx.auth, skuParams, 'sk')
    allSkus = await pg.query(`
      SELECT mps.product_id, sk.sku_id, sk.price, sk.special_price, mps.bundle_price
      FROM mall_product_skus mps
      JOIN product_skus sk ON mps.sku_id = sk.sku_id
      WHERE mps.product_id = ANY($1)
        AND ${SKU_VALID_FILTER}
        ${skuMarketScopeFilter}
      ORDER BY mps.sort_order ASC
    `, skuParams)
  }

  const skuByProduct = {}
  for (const sku of allSkus) {
    if (!skuByProduct[sku.product_id]) skuByProduct[sku.product_id] = []
    skuByProduct[sku.product_id].push(sku)
  }

  const result = productRows.map(product => {
    const skus = skuByProduct[product.product_id] || []
    const { priceFrom, listPriceFrom } = computeListPriceFrom(product, skus)
    return {
      ...product,
      // issue #230：当前无前端消费者（仅路由注册 + 测试），仍按同口径保护，
      // 避免将来接上页面时又是一条无防护链路
      cover_image: safeThumbUrl(product.cover_image, PRODUCT_THUMB_BOX_LARGE),
      priceFrom,
      listPriceFrom
    }
  })

  ctx.result = { spuList: result }
}

/**
 * 商品详情（含 SKU 列表）
 */
async function spuDetail(ctx) {
  const { spuId, productId: inputProductId } = ctx.event.payload || {}
  const productId = inputProductId || spuId

  if (!productId) {
    throw new Error('INVALID_PARAMS: 缺少 productId 参数')
  }

  const params = [productId]
  const productMarketScopeFilter = buildMarketScopeFilter(ctx.auth, params, 'p')

  const productRows = await pg.query(`
    SELECT
      p.product_id, p.name, p.category_id,
      mc.category_name,
      p.cover_image, p.detail_images, p.description, p.sort_order,
      p.price, p.special_price, p.is_bundle
    FROM products p
    JOIN mall_categories mc ON p.category_id = mc.category_id
    WHERE p.product_id = $1 ${productMarketScopeFilter}
  `, params)

  if (productRows.length === 0) {
    throw new Error('INVALID_PARAMS: 商品不存在')
  }

  const product = productRows[0]

  // PR-D：JOIN product_categories pc → parent_pc，带出 product_kind + kind_display_color
  const skuParams = [productId]
  const skuMarketScopeFilter = buildCatalogSkuMarketScopeFilter(ctx.auth, skuParams, 'sk')
  const skuList = await pg.query(`
    SELECT
      sk.sku_id, sk.product_type, sk.spec_name,
      sk.price, sk.special_price, sk.session_count, sk.unit,
      sk.service_fee, sk.sort_order, sk.is_shengmei,
      mps.bundle_price, mps.bundle_list_price, mps.sort_order AS display_order,
      mps.bundle_group_id,
      bg.group_name, bg.pick_count AS group_pick_count,
      pc.product_kind,
      parent_pc.display_color AS kind_display_color
    FROM mall_product_skus mps
    JOIN product_skus sk ON mps.sku_id = sk.sku_id
    LEFT JOIN product_categories pc ON sk.category_id = pc.category_id
    LEFT JOIN product_categories parent_pc
      ON parent_pc.product_kind IS NULL
     AND parent_pc.category_name = pc.product_kind
    LEFT JOIN mall_bundle_groups bg ON mps.bundle_group_id = bg.id
    WHERE mps.product_id = $1
      AND ${SKU_VALID_FILTER}
      ${skuMarketScopeFilter}
    ORDER BY COALESCE(bg.sort_order, 0) ASC, mps.sort_order ASC
  `, skuParams)

  // 构建分组信息（套餐商品）
  let bundleGroups = null
  if (product.is_bundle) {
    const groupRows = await pg.query(`
      SELECT id, group_name, pick_count, sort_order
      FROM mall_bundle_groups
      WHERE product_id = $1
      ORDER BY sort_order ASC
    `, [productId])

    bundleGroups = groupRows.map(g => ({
      id: g.id,
      groupName: g.group_name,
      pickCount: g.pick_count,
      skuIds: skuList.filter(s => s.bundle_group_id === g.id).map(s => s.sku_id),
    }))
  }

  const { priceFrom, listPriceFrom } = computeListPriceFrom(product, skuList)

  ctx.result = {
    spu: {
      ...product,
      // issue #230：头图是常规比例图（生产 44/44 长宽比恒为 1.56），走 box 档。
      cover_image: safeThumbUrl(product.cover_image, PRODUCT_THUMB_BOX_LARGE),
      // 详情长图走**面积模式**而不是 box：生产 14/14 张高宽比 3.56~5.42，
      // box 的 contain 语义会把它们压到 199~302px 宽，前端 mode="widthFix"
      // 再拉回满屏等于放大 4~6 倍，文字糊掉。面积模式直接封顶总像素（=解码内存）
      // 且不破坏长宽比。
      //
      // filter 掉无法保证的那些——详情长图是 wx:for 直接渲染、没有占位分支，
      // 留 null 会变成裂图。
      //
      // 张数也必须截断：单张封顶解决不了「很多张加起来撑爆」，而 admin 的 9 张上限
      // 只在 UI 层，server action 与 DB 都没有约束（详见 image.js 的常量注释）。
      // 先 filter 再 slice：保证截断后拿到的是 9 张**可用**的图，
      // 而不是「9 张里混着几张被 filter 掉的空位」。
      detail_images: Array.isArray(product.detail_images)
        ? product.detail_images
            .map(img => safeThumbUrlByArea(img, PRODUCT_DETAIL_IMAGE_MAX_PIXELS))
            .filter(Boolean)
            .slice(0, PRODUCT_DETAIL_IMAGE_MAX_COUNT)
        : [],
      skuList,
      bundleGroups,
      priceFrom,
      listPriceFrom
    }
  }
}

/**
 * 体验卡 SKU 列表（client 体验卡入口专用）
 *
 * 与商城常规通道（spuList / shopInit / hotList）互斥：
 *   - 商城通道用 SKU_VALID_FILTER，默认排除 is_experience = true
 *   - 本入口反向只取 is_experience = true 的 SKU
 *
 * 返回顺序按 sortOrder ASC（admin 配置项 C5），同 sortOrder 时按 sku_id 兜底稳定排序。
 * 一并返回所属商品名 / 封面图（mall_product_skus → products JOIN），便于列表卡片直接渲染。
 *
 * 按 product_skus.market_scope 过滤：null=全部市场、空字符串=全部不可见，
 * 其余仅对当前绑定门店所属市场可见。
 */
async function experienceCardList(ctx) {
  const params = []
  const marketScopeFilter = buildMarketScopeFilter(ctx.auth, params, 'sk')

  const rows = await pg.query(`
    SELECT
      sk.sku_id, sk.product_type, sk.spec_name,
      sk.price, sk.special_price, sk.session_count, sk.unit,
      sk.service_fee, sk.sort_order,
      p.product_id, p.name AS product_name,
      p.cover_image, p.description
    FROM product_skus sk
    LEFT JOIN mall_product_skus mps ON mps.sku_id = sk.sku_id
    LEFT JOIN products p ON p.product_id = mps.product_id
    WHERE sk.is_experience = true
      AND sk.is_enabled = true
      AND sk.deleted_at IS NULL
      ${marketScopeFilter}
    ORDER BY sk.sort_order ASC, sk.sku_id ASC
  `, params)

  // issue #230：体验卡列表卡片是 200rpx 方图，走小档。
  // LEFT JOIN products 时 cover_image 本就可能为 NULL，safeThumbUrl 同样返回 null，语义一致。
  for (const row of rows) {
    row.cover_image = safeThumbUrl(row.cover_image, PRODUCT_THUMB_BOX_SMALL)
  }

  ctx.result = { skuList: rows }
}

module.exports = {
  categories,
  spuList,
  search,
  skuDetail,
  spuDetail,
  hotList,
  shopInit,
  experienceCardList,
  // 分页口径的单一来源。index.js 的 action 路由只按名字取上面那些函数，
  // 多这一个键不会变成可调用 action；导出它是为了让测试断言权威值而不是再抄一份字面量。
  __pageSizeCaliber: {
    PRODUCT_PAGE_SIZE_DEFAULT,
    PRODUCT_PAGE_SIZE_MAX,
    HOT_LIST_DEFAULT_LIMIT,
    PRODUCT_CURSOR_MAX_LENGTH,
  },
}
