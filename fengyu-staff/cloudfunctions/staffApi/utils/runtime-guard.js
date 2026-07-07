

const cloud = require('wx-server-sdk')


const PROD_ENV_IDS = new Set([
  'fengyu-staff-prod-d4dtv6052992e9',
])


function isProdRuntime() {
  try {
    return PROD_ENV_IDS.has(cloud.getWXContext().ENV)
  } catch (e) {
    
    return false
  }
}


function testBypassAllowed(envFlag) {
  return process.env[envFlag] === 'true' && !isProdRuntime()
}

module.exports = { isProdRuntime, testBypassAllowed, PROD_ENV_IDS }
