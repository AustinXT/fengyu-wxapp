/**
 * 会员价分流定价 helper —— 「仅会员享受会员价（special_price），非会员按标价（price）」。
 *
 * 会员判定口径（产品决策）：customer_type='会员客' 或 member_level 非空，任一满足即会员。
 * 体验卡（is_experience）同口径（#6=B，不再豁免）：会员享会员价（special_price），非会员按标价。
 * 会员价须严格 < 标价才生效（guard 脏数据：DB 无 special_price <= price 约束）。
 *
 * 三端独立副本（clientApi/utils + staffApi/utils 字节一致；admin 见 src/lib/member-pricing.ts），
 * 逻辑须一致，禁止抽取 cloudfunctions-shared（用户已 veto）。
 * 套餐（bundle_price / unit_member_price）是另一套机制，不经过此 helper。
 */

/** 顾客是否会员：会员客 或 有钻石等级（member_level 非空）。 */
function isMember(customerType, memberLevel) {
  return customerType === '会员客' || (memberLevel != null && memberLevel !== '')
}

/**
 * 解析单品 SKU 对某顾客的适用单价（标价 + 成交基线）。
 * 成交基线未叠加店长改价 / 券抵扣，仅做「会员价 or 标价」分流。
 *
 * @param {{price:*, special_price:*, is_experience?:boolean}} sku - snake_case SKU 行（DB 直出）
 * @param {boolean} member - 该顾客是否会员
 * @returns {{listUnit:number, realUnit:number}} listUnit=标价(落 unit_price/划线)，realUnit=成交基线(落 unit_real_price)
 */
function resolveUnitPrice(sku, member) {
  const listUnit = Number(sku.price) || 0
  const special = sku.special_price != null ? Number(sku.special_price) : null
  // 会员价分流（#6=B：体验卡不再豁免，与普通单品同口径）；会员价须严格低于标价
  const eligible = member === true
  const realUnit = eligible && special != null && special < listUnit ? special : listUnit
  return { listUnit, realUnit }
}

module.exports = { isMember, resolveUnitPrice }
