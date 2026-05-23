const { maskPhone } = require('./pii')

/** 按当前员工角色返回手机号：manager 看全号，其余脱敏。 */
function maskPhoneForAuth(phone, auth) {
  const isManager = !!(auth && Array.isArray(auth.roles) && auth.roles.includes('manager'))
  return isManager ? (phone || '') : maskPhone(phone)
}

module.exports = { maskPhoneForAuth }
