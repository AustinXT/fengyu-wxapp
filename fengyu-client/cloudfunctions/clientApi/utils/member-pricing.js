


function isMember(customerType, memberLevel) {
  return customerType === '会员客' || (memberLevel != null && memberLevel !== '')
}


function resolveUnitPrice(sku, member) {
  const listUnit = Number(sku.price) || 0
  const special = sku.special_price != null ? Number(sku.special_price) : null
  
  const eligible = member === true
  const realUnit = eligible && special != null && special < listUnit ? special : listUnit
  return { listUnit, realUnit }
}

module.exports = { isMember, resolveUnitPrice }
