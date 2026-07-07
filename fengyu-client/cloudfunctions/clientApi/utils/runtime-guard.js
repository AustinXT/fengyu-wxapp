

const cloud = require('wx-server-sdk')


const PROD_ENV_IDS = new Set([
  'fengyu-client-prod-d1cga6909c0ba',
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
