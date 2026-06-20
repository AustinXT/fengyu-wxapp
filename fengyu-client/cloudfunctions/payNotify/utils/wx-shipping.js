/**
 * 微信小程序「发货信息管理」自动上报（用户自提 logistics_type=4）
 *
 * 背景：微信要求每笔「微信支付」交易付款后录入发货信息，否则资金冻结 / 触发自动退款 /
 * 限制小程序微信支付（小程序后台「发货信息管理」即手动「发货」入口）。本店主营美容服务 +
 * 到店领取的美容品，顾客均「到店领取 / 当面拿走」，故按 logistics_type=4（用户自提）自动上报：
 *   - 实物电商类目下，到店领取的美容品标「用户自提」如实合规（标虚拟商品=品类不符）；
 *   - 美容服务同属到店消费，一并按自提上报；
 *   - 自提归入「其他发货方式」，微信按 T+2 自动确认收货。
 * 付款回调即上报「已发货」，无需后台手动点「发货」。
 *
 * 关键约定（拉卡拉服务商收单）：
 *   - 上报必须用「微信交易单号 transaction_id」(order_number_type=2)，即拉卡拉回调里的
 *     `acc_trade_no`——不能用商户单号 out_trade_no（那是拉卡拉向微信下单时自造的单号，与我方
 *     sale_order_id 不一致，发货管理里匹配不上）。
 *   - 仅微信渠道（account_type=WECHAT）上报；支付宝订单不进微信发货管理，调用方负责跳过。
 *
 * 用户自提（logistics_type=4）shipping_list 仅需 item_desc，无需物流单号 / 快递公司 / 联系人。
 *
 * access_token 与 staffApi/utils/wxacode.js 各自保留独立副本（no-shared-cloudfunctions 规范）。
 *
 * 启用条件（两者皆需）：环境变量 WX_SHIPPING_ENABLED=true + 已配置 CLIENT_APPSECRET。
 * 一次性前置：小程序后台需已开通「发货信息管理服务」并设置消息跳转路径（set_msg_jump_path）。
 */

const https = require('https')

// 客户端小程序 appid + 真实 appsecret（换 access_token 用，与 staffApi 的 CLIENT_APPSECRET 同一份）。
// appsecret 在调用时读取 process.env（不在模块加载时 const 捕获），与 WX_SHIPPING_ENABLED 口径一致、便于测试。
const clientAppid = () => process.env.CLIENT_APPID || 'wx811eb4ded3dfba3f'
const clientAppsecret = () => process.env.CLIENT_APPSECRET

// 用户自提（logistics_type=4）。常量化便于将来按品类细分上报方式。
const LOGISTICS_TYPE_SELF_PICKUP = 4

// 模块级 access_token 缓存（提前 5 分钟过期，与小程序码工具同策略）
let cachedToken = null
let tokenExpiresAt = 0

/** 是否启用自动发货上报 */
function isEnabled() {
  return process.env.WX_SHIPPING_ENABLED === 'true' && !!clientAppsecret()
}

/** 获取客户端小程序 access_token（带缓存） */
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

/**
 * RFC3339 时间戳（+08:00）。进程 TZ 已在 index.js 设为 Asia/Shanghai，
 * 故 getHours/getMonth 等本地时间方法对应东八区墙钟。
 */
function rfc3339(date) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}+08:00`
}

/**
 * 构造 upload_shipping_info 请求体（用户自提）。抽成纯函数便于单测断言字段。
 * @param {{ transactionId:string, openid:string, itemDesc:string, now?:Date }} p
 */
function buildSelfPickupPayload({ transactionId, openid, itemDesc, now }) {
  return {
    order_key: {
      order_number_type: 2,        // 2 = 用微信 transaction_id 定位订单
      transaction_id: transactionId,
    },
    logistics_type: LOGISTICS_TYPE_SELF_PICKUP,  // 4 = 用户自提（无需物流单号）
    delivery_mode: 1,              // 1 = 统一发货
    shipping_list: [{ item_desc: itemDesc }],
    upload_time: rfc3339(now || new Date()),
    payer: { openid },
  }
}

/** 调一次 upload_shipping_info，返回 { errcode, errmsg } */
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

/**
 * 上报用户自提发货（logistics_type=4）。token 过期（40001/42001）自动刷新重试一次。
 * @param {{ transactionId:string, openid:string, itemDesc:string }} p
 * @returns {Promise<{errcode:number, errmsg:string}>}
 */
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
