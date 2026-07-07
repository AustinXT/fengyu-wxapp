

const https = require('https')



const clientAppid = () => process.env.CLIENT_APPID || 'wx811eb4ded3dfba3f'
const clientAppsecret = () => process.env.CLIENT_APPSECRET


const LOGISTICS_TYPE_SELF_PICKUP = 4


let cachedToken = null
let tokenExpiresAt = 0


function isEnabled() {
  return process.env.WX_SHIPPING_ENABLED === 'true' && !!clientAppsecret()
}


async function getAccessToken(forceRefresh = false) {
  if (!clientAppsecret()) throw new Error('未配置 CLIENT_APPSECRET 环境变量')
  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) return cachedToken

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${clientAppid()}&secret=${clientAppsecret()}`
  const data = await httpGetJson(url)
  if (data.errcode) {
    throw new Error(`获取 access_token 失败: ${data.errcode} ${data.errmsg}`)
  }
  cachedToken = data.access_token
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000
  return cachedToken
}


function rfc3339(date) {
  const p = (n) => String(n).padStart(2, '0')
  const bj = new Date(date.getTime() + 8 * 3600 * 1000)
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())}` +
    `T${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}+08:00`
}


function buildSelfPickupPayload({ transactionId, openid, itemDesc, now }) {
  return {
    order_key: {
      order_number_type: 2,        
      transaction_id: transactionId,
    },
    logistics_type: LOGISTICS_TYPE_SELF_PICKUP,  
    delivery_mode: 1,              
    shipping_list: [{ item_desc: itemDesc }],
    upload_time: rfc3339(now || new Date()),
    payer: { openid },
  }
}


function callUploadShippingInfo(token, payload) {
  const url = `https://api.weixin.qq.com/wxa/sec/order/upload_shipping_info?access_token=${token}`
  const body = JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error('解析 upload_shipping_info 响应失败: ' + data)) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}


async function uploadSelfPickupShipping({ transactionId, openid, itemDesc }) {
  const payload = buildSelfPickupPayload({ transactionId, openid, itemDesc })
  let token = await getAccessToken()
  let res = await callUploadShippingInfo(token, payload)
  if (res && (res.errcode === 40001 || res.errcode === 42001)) {
    token = await getAccessToken(true)
    res = await callUploadShippingInfo(token, payload)
  }
  return res
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error('解析响应失败')) }
      })
    }).on('error', reject)
  })
}

module.exports = {
  isEnabled,
  rfc3339,
  buildSelfPickupPayload,
  uploadSelfPickupShipping,
  LOGISTICS_TYPE_SELF_PICKUP,
}
