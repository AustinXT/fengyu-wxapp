const { maskPhone } = require('./pii')
const { hasValidManagerRole, isCurrentStoreManager } = require('../middleware/auth')

/** 按当前有效权限返回手机号：当前门店店长或合法管理层监管身份看全号，其余脱敏。 */
function maskPhoneForAuth(phone, auth) {
  const canReadFull = auth?.loginLevel === 'management'
    ? hasValidManagerRole(auth)
    : isCurrentStoreManager(auth)
  return canReadFull ? (phone || '') : maskPhone(phone)
}

module.exports = { maskPhoneForAuth }
