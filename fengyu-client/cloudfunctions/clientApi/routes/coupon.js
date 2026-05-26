/**
 * 优惠券模块路由（客户端）
 * coupon.list — 我的优惠券列表
 * coupon.available — 当前订单可用券
 */

const pg = require('../db/pg')
const { requirePhone } = require('../middleware/auth')

/**
 * 我的优惠券列表（按 status 分 tab）
 * payload: { status?: '未使用' | '已使用' | '已过期' }
 */
async function list(ctx) {
  await requirePhone()(ctx, async () => {})

  const { userId } = ctx.auth
  const { status } = ctx.event.payload || {}

  // 懒清扫过期券
  await pg.query(
    `UPDATE user_coupons SET status = '已过期'
     WHERE user_id = $1 AND status = '未使用' AND expire_at <= NOW()`,
    [userId]
  )

  let whereClause = 'WHERE uc.user_id = $1'
  const params = [userId]

  if (status) {
    params.push(status)
    whereClause += ` AND uc.status = $${params.length}`
  }

  const coupons = await pg.query(`
    SELECT
      uc.coupon_id, uc.status, uc.expire_at, uc.used_at, uc.created_at,
      ct.name, ct.coupon_type,
      COALESCE(uc.face_value_override, ct.discount_value) AS discount_value,
      ct.min_spend,
      ct.applicable_category_ids, ct.applicable_store_ids,
      ct.description
    FROM user_coupons uc
    JOIN coupon_templates ct ON uc.template_id = ct.template_id
    ${whereClause}
    ORDER BY
      CASE uc.status
        WHEN '未使用' THEN 0
        WHEN '已使用' THEN 1
        WHEN '已过期' THEN 2
      END,
      uc.expire_at ASC
  `, params)

  // 查询适用门店名称（批量）
  const storeIds = new Set()
  for (const c of coupons) {
    if (c.applicable_store_ids) {
      for (const id of c.applicable_store_ids) storeIds.add(id)
    }
  }
  let storeNameMap = {}
  if (storeIds.size > 0) {
    const storeRows = await pg.query(
      'SELECT store_id, store_name FROM stores WHERE store_id = ANY($1)',
      [Array.from(storeIds)]
    )
    for (const r of storeRows) storeNameMap[r.store_id] = r.store_name
  }

  // 查询适用品类名称（批量，复用 storeNameMap 模式）
  const categoryIds = new Set()
  for (const c of coupons) {
    if (c.applicable_category_ids) {
      for (const id of c.applicable_category_ids) categoryIds.add(id)
    }
  }
  let categoryNameMap = {}
  if (categoryIds.size > 0) {
    const catRows = await pg.query(
      'SELECT category_id, category_name FROM product_categories WHERE category_id = ANY($1)',
      [Array.from(categoryIds)]
    )
    for (const r of catRows) categoryNameMap[r.category_id] = r.category_name
  }

  ctx.result = {
    coupons: coupons.map(c => ({
      couponId: c.coupon_id,
      name: c.name,
      couponType: c.coupon_type,
      discountValue: c.discount_value,
      minSpend: c.min_spend,
      status: c.status,
      expireAt: c.expire_at,
      usedAt: c.used_at,
      createdAt: c.created_at,
      description: c.description,
      applicableStoreNames: c.applicable_store_ids
        ? c.applicable_store_ids.map(id => storeNameMap[id] || id)
        : null,
      applicableCategoryNames: c.applicable_category_ids
        ? c.applicable_category_ids.map(id => categoryNameMap[id] || id)
        : null,
    }))
  }
}

/**
 * 当前订单可用券
 * payload: { storeId?: string, storeName?: string, items: [{ skuId, quantity, amount }] }
 * amount = 该行小计（已含手动折扣），用于满减门槛判断
 */
async function available(ctx) {
  await requirePhone()(ctx, async () => {})

  const { userId } = ctx.auth
  const payload = ctx.event.payload || {}
  const { items } = payload

  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new Error('INVALID_PARAMS: 缺少 items 参数')
  }

  // 解析门店ID
  let storeId = payload.storeId
  if (!storeId && payload.storeName) {
    const storeRows = await pg.query(
      'SELECT store_id FROM stores WHERE store_name = $1 LIMIT 1',
      [payload.storeName]
    )
    if (storeRows.length > 0) storeId = storeRows[0].store_id
  }

  // 懒清扫过期券
  await pg.query(
    `UPDATE user_coupons SET status = '已过期'
     WHERE user_id = $1 AND status = '未使用' AND expire_at <= NOW()`,
    [userId]
  )

  // 查询用户可用券 + 模板信息（face_value_override 优先于 template.discount_value）
  const coupons = await pg.query(`
    SELECT
      uc.coupon_id, uc.expire_at,
      ct.template_id, ct.name, ct.coupon_type,
      COALESCE(uc.face_value_override, ct.discount_value) AS discount_value,
      ct.min_spend, ct.max_discount,
      ct.applicable_category_ids, ct.applicable_store_ids,
      ct.description
    FROM user_coupons uc
    JOIN coupon_templates ct ON uc.template_id = ct.template_id
    WHERE uc.user_id = $1 AND uc.status = '未使用' AND uc.expire_at > NOW()
      AND ct.is_active = true
    ORDER BY uc.expire_at ASC
  `, [userId])

  if (coupons.length === 0) {
    ctx.result = { coupons: [] }
    return
  }

  // 解析每个 SKU 的 category_id（SKU 直接有 category_id，无需 JOIN products）
  const skuIds = items.map(i => i.skuId)
  const skuCats = await pg.query(
    `SELECT sku_id, category_id FROM product_skus WHERE sku_id = ANY($1) AND deleted_at IS NULL`,
    [skuIds]
  )
  const catMap = new Map()
  for (const r of skuCats) catMap.set(r.sku_id, r.category_id)

  // 逐张券评估适用性
  const result = []
  for (const coupon of coupons) {
    // 门店匹配
    if (coupon.applicable_store_ids && coupon.applicable_store_ids.length > 0) {
      if (!storeId || !coupon.applicable_store_ids.includes(storeId)) continue
    }

    // 品项分类匹配 → 找出符合的行
    let eligibleItems
    if (coupon.applicable_category_ids && coupon.applicable_category_ids.length > 0) {
      eligibleItems = items.filter(item => {
        const catId = catMap.get(item.skuId)
        return coupon.applicable_category_ids.includes(catId)
      })
    } else {
      eligibleItems = items
    }
    if (eligibleItems.length === 0) continue

    // 满减门槛（归一化到分 + 浮点兜底，避免 JS 浮点 + PG numeric 边界抖动）
    const eligibleTotalRaw = eligibleItems.reduce(
      (sum, i) => sum + Number(i.amount || 0), 0
    )
    const eligibleTotal = Math.round(eligibleTotalRaw * 100) / 100
    const minSpend = Math.round((Number(coupon.min_spend) || 0) * 100) / 100
    // +0.001 兜底 JS 浮点累计误差（仅用于门槛判断，分摊/显示仍精确到分）
    if (eligibleTotal + 0.001 < minSpend) continue

    // 计算可抵扣金额
    let discount = 0
    if (coupon.coupon_type === '现金券' || coupon.coupon_type === '品项券') {
      discount = Math.min(Number(coupon.discount_value), eligibleTotal)
    } else if (coupon.coupon_type === '折扣券') {
      discount = eligibleTotal * (1 - Number(coupon.discount_value))
      if (coupon.max_discount) {
        discount = Math.min(discount, Number(coupon.max_discount))
      }
    }
    discount = Math.round(discount * 100) / 100

    result.push({
      couponId: coupon.coupon_id,
      name: coupon.name,
      couponType: coupon.coupon_type,
      discountValue: coupon.discount_value,
      minSpend: coupon.min_spend,
      expireAt: coupon.expire_at,
      description: coupon.description,
      discount,
      eligibleItemCount: eligibleItems.length,
    })
  }

  // 按抵扣金额降序
  result.sort((a, b) => b.discount - a.discount)

  ctx.result = { coupons: result }
}

module.exports = { list, available }
