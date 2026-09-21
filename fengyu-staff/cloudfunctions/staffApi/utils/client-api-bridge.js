/**
 * staffApi → clientApi 跨 env 内部调用桥（HMAC 签名 + HTTP 触发器）。
 *
 * 为什么需要：staffApi 所在的 CloudBase 账号**没有也不该有**拉卡拉凭据（凭据面限制在
 * clientApi 一处）。员工端关闭订单前必须让渠道关单，只能请 clientApi 代劳。
 *
 * 通道本身早已存在并在生产使用（staff.uploadAvatar 的跨 env 转上传），env 也已按通道
 * 区分好：正式函数指向 clientApi，Dev 影子函数指向 clientApiDev —— 不存在 dev 打到 prod
 * 的跨库风险。
 *
 * 安全依赖 clientApi index.js 的三重守卫：HMAC-SHA256(rawBody, CLIENT_SECRET) 签名比对、
 * 时间戳 ±5min 窗口、HTTP action 白名单。
 *
 * ⚠️ `routes/staff.js` 的 uploadAvatar 另有一份等价的内联实现（本模块建立之前就在跑）。
 * 刻意不在本次改动里收敛它：那是已上线的上传链路，与支付无关，不值得为了消重去动它。
 * 下次触碰 uploadAvatar 时可以让它改用本模块。
 */

'use strict'

const https = require('https')
const crypto = require('crypto')
const { URL } = require('url')

// 每次读 process.env 而不是模块加载时快照：云函数实例复用期间 env 不变，读取开销可忽略，
// 但这让「未配置时退回原行为」这条分支在单测里可被真实触发（模块常量无法在测试中改写）。
const DEFAULT_TIMEOUT_MS = 20000

function postJson(urlStr, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const data = Buffer.from(body, 'utf-8')
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        ...headers,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        let json = null
        try { json = JSON.parse(text) } catch (_) {}
        resolve({ status: res.statusCode, json, raw: text })
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs || DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new Error(`clientApi 调用超时 ${timeoutMs || DEFAULT_TIMEOUT_MS}ms`))
    })
    req.write(data)
    req.end()
  })
}

function isConfigured() {
  return Boolean(process.env.CLIENT_API_HTTP_URL && process.env.CLIENT_SECRET)
}

/**
 * 调 clientApi 的内部 action。
 *
 * 错误透传：clientApi 已 buildErrorResponse，message 自带 9 项白名单前缀，
 * 直接 throw 让 staffApi 的全局 catch 归类到同一个 errorType，前端无需区分是哪一端抛的。
 *
 * @param {string} action - 必须在 clientApi 的 HTTP_ACTION_ALLOWLIST 内
 * @param {object} payload
 * @returns {Promise<object>} clientApi 返回的 data
 */
async function callClientApi(action, payload) {
  if (!isConfigured()) {
    throw new Error('INVALID_STATE: CLIENT_API_HTTP_URL/CLIENT_SECRET 未配置')
  }

  const body = JSON.stringify({
    action,
    payload: payload || {},
    timestamp: Date.now(),
  })
  const sig = crypto.createHmac('sha256', process.env.CLIENT_SECRET).update(body).digest('hex')

  let resp
  try {
    resp = await postJson(process.env.CLIENT_API_HTTP_URL, body, { 'x-fengyu-signature': sig })
  } catch (err) {
    throw new Error(`INVALID_STATE: clientApi 调用失败：${err.message}`)
  }

  if (resp.status !== 200 || !resp.json) {
    throw new Error(`INVALID_STATE: clientApi HTTP status=${resp.status}, body=${(resp.raw || '').slice(0, 200)}`)
  }
  if (resp.json.code !== 0) {
    throw new Error(resp.json.message || 'INVALID_STATE: clientApi 调用失败')
  }
  return resp.json.data || {}
}

module.exports = {
  callClientApi,
  isConfigured,
}
