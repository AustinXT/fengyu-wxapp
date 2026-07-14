

const pg = require('../db/pg')
const { requireStaffBound } = require('../middleware/auth')


async function available(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const { clientPhone, items } = payload

  if (!clientPhone) {
    throw new Error('INVALID_PARAMS: 缺少 clientPhone')
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new Error('INVALID_PARAMS: 缺少 items 参数')
  }

  
  const clientRows = await pg.query(
    'SELECT user_id FROM client_wechat_users WHERE phone = $1 LIMIT 1',
    [clientPhone]
  )
  if (clientRows.length === 0) {
    ctx.result = { coupons: [] }
    return
  }
  const clientUserId = clientRows[0].user_id

  
  const storeId = ctx.auth.effectiveStoreId
  if (!storeId) {
    throw new Error('PERMISSION_DENIED: 管理层模式不支持券查询')
  }

  
  let marketId = null
  {
    const marketRows = await pg.query(
      `SELECT son.parent_id AS market_id FROM stores s JOIN org_nodes son ON s.org_node_id = son.id WHERE s.store_id = $1`,
      [storeId]
    )
    if (marketRows.length > 0) marketId = marketRows[0].market_id
  }

  
  await pg.query(
    `UPDATE user_coupons SET status = '已过期'
     WHERE user_id = $1 AND status = '未使用' AND expire_at <= NOW()`,
    [clientUserId]
  )

  
  const coupons = await pg.query(`
    SELECT
      uc.coupon_id, uc.expire_at,
      ct.template_id, ct.name, ct.coupon_type,
      COALESCE(uc.face_value_override, ct.discount_value) AS discount_value,
      ct.min_spend, ct.max_discount,
      ct.applicable_category_ids, ct.applicable_store_ids, ct.applicable_market_ids,
      ct.description
    FROM user_coupons uc
    JOIN coupon_templates ct ON uc.template_id = ct.template_id
    WHERE uc.user_id = $1 AND uc.status = '未使用' AND uc.expire_at > NOW()
      AND ct.is_active = true
    ORDER BY uc.expire_at ASC
  `, [clientUserId])

  if (coupons.length === 0) {
    ctx.result = { coupons: [] }
    return
  }

  
  const skuIds = items.map(i => i.skuId)
  const skuCats = await pg.query(
    `SELECT sku_id, category_id FROM product_skus WHERE sku_id = ANY($1) AND deleted_at IS NULL`,
    [skuIds]
  )
  const catMap = new Map()
  for (const r of skuCats) catMap.set(r.sku_id, r.category_id)

  const result = []
  for (const coupon of coupons) {
    
    if (coupon.applicable_store_ids && coupon.applicable_store_ids.length > 0) {
      if (!storeId || !coupon.applicable_store_ids.includes(storeId)) continue
    }

    
    if (coupon.applicable_market_ids && coupon.applicable_market_ids.length > 0) {
      if (!marketId || !coupon.applicable_market_ids.includes(marketId)) continue
    }

    
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

    
    const eligibleTotalRaw = eligibleItems.reduce(
      (sum, i) => sum + Number(i.amount || 0), 0
    )
    const eligibleTotal = Math.round(eligibleTotalRaw * 100) / 100
    const minSpend = Math.round((Number(coupon.min_spend) || 0) * 100) / 100
    
    if (eligibleTotal + 0.001 < minSpend) continue

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

  result.sort((a, b) => b.discount - a.discount)
  ctx.result = { coupons: result }
}

module.exports = { available }
