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

// 注：env 一律每次读 process.env 而不是在模块加载时快照。云函数实例复用期间 env 不变，
// 读取开销可忽略，但这让「未配置时退回原行为」那条分支在单测里可被真实触发
// （模块级常量无法在测试中改写）。
//
// 25s：`order.voidPaymentIntent` 在 clientApi 侧最多串行走三次拉卡拉往返
// （queryTrade → closeTrade → 复核 queryTrade），每次 7s 预算，合计约 21s。
//
// ⚠️ 这个值**按线上 staffApi 实际 30s 的函数超时来定，不是按 cloudbaserc 模板里的 60s**
// （双谱系评审 round-6）：`tcb fn code update` 只推代码，**不会更新已存在函数的 timeout**，
// 所以模板改成 60 对存量函数无效，线上仍是 30s。把桥设成 50s 会让 staffApi 先被平台
// 硬杀——那正是「渠道意图已释放、本地订单却没关」的来源。
//
// 25s 的设计在两种情况下都成立：线上仍是 30s 时留 5s 余量；将来真把函数超时调到 60s，
// 也只是更宽松。改这里或改 clientApi 的 LAKALA_VOID_CALL_TIMEOUT_MS，两边都要回来核对。
const DEFAULT_TIMEOUT_MS = 25000

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
 * 把 clientApi 的错误响应还原成带一级白名单前缀的 Error。
 *
 * clientApi 的 `buildErrorResponse` 会把前缀从 message 里剥掉（`parseErrorPrefix` 返回
 * `message.slice(...)`），前缀改放 `errorType`。原样 rethrow 的话，staffApi 自己的
 * buildErrorResponse 认不出白名单前缀，会把「支付已成功」这类明确业务冲突降级成
 * 「服务器内部错误」，店员看不到真正原因。
 *
 * 导出为独立纯函数是为了可测——这条链路上的 mock 很容易写成「带全前缀」的理想形态，
 * 反而把真实缺陷掩盖掉。
 */
function buildBridgeError(json) {
  const message = String((json && json.message) || 'clientApi 调用失败')
  const prefix = String((json && json.errorType) || '').trim()
  // errorType 缺失时保守归为 INVALID_STATE，至少不让它降级成「服务器内部错误」
  if (!prefix) return new Error(`INVALID_STATE: ${message}`)
  return new Error(message.startsWith(`${prefix}:`) ? message : `${prefix}: ${message}`)
}

/**
 * 调 clientApi 的内部 action。
 *
 * 错误透传要**重建**一级前缀，不能原样 rethrow：clientApi 的 `buildErrorResponse` 会把
 * 一级前缀从 message 里剥掉（`parseErrorPrefix` 返回 `message.slice(...)`），前缀改放在
 * `errorType` 字段。原样抛出去，staffApi 自己的 buildErrorResponse 认不出白名单前缀，
 * 会把「支付已成功」这类明确业务冲突降级成「服务器内部错误」，店员看不到真正原因。
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
    throw buildBridgeError(resp.json)
  }
  return resp.json.data || {}
}

module.exports = {
  callClientApi,
  isConfigured,
  buildBridgeError,
}
