const { maskPhone } = require('./pii')


function maskPhoneForAuth(phone, auth) {
  const isManager = !!(auth && Array.isArray(auth.roles) && auth.roles.includes('manager'))
  return isManager ? (phone || '') : maskPhone(phone)
}

module.exports = { maskPhoneForAuth }
