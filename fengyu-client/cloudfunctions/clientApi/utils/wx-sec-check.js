/**
 * 微信内容安全校验（sec-center）：文本 msg_sec_check + 图片 img_sec_check。
 *
 * 用途：client 端 UGC（用户生成内容）落库 / 上传前做合规拦截，满足小程序审核「内容安全」要求。
 *   - 文本（昵称 / 预约备注 / 转店备注 / 服务评价）→ checkText（msg_sec_check，有 openid 走 2.0，否则降级 1.0）
 *   - 头像图片 → checkImage（img_sec_check 同步，违规图根本不进 COS）
 *
 * 总开关 isEnabled()：SEC_CHECK_ENABLED=true 且已配置 CLIENT_APPSECRET 才生效。
 *   未启用时所有校验为 no-op（直接放行）——保证本地 / CI / e2e（无 appsecret）不被 fail-closed 误拦，
 *   prod 配齐 env 后才真正生效。
 *
 * 故障策略 = fail-closed：微信接口报错 / 超时 / 非 0 且非违规码（即「非违规判定」的任何异常）一律拦截，
 *   抛 'INVALID_PARAMS: SEC_CHECK_UNAVAILABLE: ...'，原始错误 console.error 供排查。违规判定抛 CONTENT_RISKY。
 *   两者一级前缀都走 INVALID_PARAMS(-400) 白名单，子标签仅供日志归类（见 utils/error-codes.js 二级前缀语法）。
 *
 * access_token 与 payNotify/utils/wx-shipping.js、staffApi/utils/wxacode.js 各自保留独立副本
 * （no-shared-cloudfunctions 规范），勿 import 复用。
 */

'use strict'

const https = require('https')
const cloud = require('wx-server-sdk')

// 客户端小程序 appid + 真实 appsecret（换 access_token 用，与 staffApi/payNotify 的 CLIENT_APPSECRET 同一份）。
// 调用时读 process.env（不在模块加载时 const 捕获），与 isEnabled 口径一致、便于测试。
const clientAppid = () => process.env.CLIENT_APPID || 'wx811eb4ded3dfba3f'
const clientAppsecret = () => process.env.CLIENT_APPSECRET

// msg_sec_check 2.0 的 suggest='review'（疑似 / 中等风险）是否拦截。
// 默认仅拦 'risky'，放行 'review'（避免误伤正常用户）；需收紧时改 true。
const BLOCK_REVIEW = false

// 微信「内容含违规」错误码（msg_sec_check 1.0 / img_sec_check 同步均用此码）
const ERRCODE_RISKY = 87014

// 模块级 access_token 缓存（提前 5 分钟过期，与 wx-shipping / wxacode 同策略）
let cachedToken = null
let tokenExpiresAt = 0

/** 是否启用内容安全校验（总开关）。未启用时所有 check* 为 no-op。 */
function isEnabled() {
  return process.env.SEC_CHECK_ENABLED === 'true' && !!clientAppsecret()
}

/** 获取客户端小程序 access_token（带缓存，提前 5min 过期） */
async function getAccessToken(forceRefresh = false) {
  if (!clientAppsecret()) throw new Error('未配置 CLIENT_APPSECRET 环境变量')
  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) return cachedToken

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${clientAppid()}&secret=${clientAppsecret()}`
  const data = await net.httpGetJson(url)
  if (!data || data.errcode) {
    throw new Error(`获取 access_token 失败: ${data && data.errcode} ${data && data.errmsg}`)
  }
  cachedToken = data.access_token
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000
  return cachedToken
}

/** token 过期 / 失效错误码 → 强刷重试一次 */
function isTokenExpired(errcode) {
  return errcode === 40001 || errcode === 42001 || errcode === 40014
}

/** 当前调用方 openid（msg_sec_check 2.0 需要）；非云函数运行时（如本地 e2e）返回 null → 降级 1.0 */
function currentOpenid() {
  try {
    return (cloud.getWXContext() || {}).OPENID || null
  } catch (e) {
    return null
  }
}

/**
 * 文本内容安全校验（msg_sec_check）。
 * 违规 → 抛 'INVALID_PARAMS: CONTENT_RISKY: ...'；接口异常 → fail-closed 抛 'INVALID_PARAMS: SEC_CHECK_UNAVAILABLE: ...'。
 * @param {string} content 待校验文本
 * @param {{ scene?: number, openid?: string }} [opts] scene: 1资料 2评论 3论坛 4社交日志（默认 1）
 */
async function checkText(content, opts = {}) {
  if (!isEnabled()) return
  if (content == null) return
  const text = String(content).trim()
  if (!text) return // 空内容无需校验

  const scene = opts.scene || 1
  const openid = opts.openid || currentOpenid()

  let data
  try {
    let token = await getAccessToken()
    data = await callMsgSecCheck(token, text, scene, openid)
    if (data && isTokenExpired(data.errcode)) {
      token = await getAccessToken(true)
      data = await callMsgSecCheck(token, text, scene, openid)
    }
  } catch (err) {
    console.error('[wx-sec-check] msg_sec_check 调用异常:', err && err.message)
    throw new Error('INVALID_PARAMS: SEC_CHECK_UNAVAILABLE: 安全校验暂不可用，请稍后重试')
  }

  // 1.0：errcode 87014 = 违规
  if (data && data.errcode === ERRCODE_RISKY) {
    throw new Error('INVALID_PARAMS: CONTENT_RISKY: 内容包含违规信息，请修改后重试')
  }
  // 非 0（且非违规码）→ fail-closed
  if (!data || data.errcode !== 0) {
    console.error('[wx-sec-check] msg_sec_check 非预期返回:', safeJson(data))
    throw new Error('INVALID_PARAMS: SEC_CHECK_UNAVAILABLE: 安全校验暂不可用，请稍后重试')
  }
  // 2.0：result.suggest（risky 必拦；review 视 BLOCK_REVIEW；pass / 无 result → 放行）
  const suggest = data.result && data.result.suggest
  if (suggest === 'risky' || (BLOCK_REVIEW && suggest === 'review')) {
    throw new Error('INVALID_PARAMS: CONTENT_RISKY: 内容包含违规信息，请修改后重试')
  }
}

/**
 * 图片内容安全校验（img_sec_check，同步 1.0）。
 * 违规 → 抛 CONTENT_RISKY；接口异常 / 超限 → fail-closed 抛 SEC_CHECK_UNAVAILABLE。
 * 注意：img_sec_check 限图片 ≤1MB、分辨率 ≤750x1334，超限会返回错误码 → 被 fail-closed 拦截，前端须先压缩。
 * @param {Buffer} buffer 图片二进制
 * @param {{ openid?: string }} [opts]
 */
async function checkImage(buffer, opts = {}) {
  if (!isEnabled()) return
  if (!buffer || buffer.length === 0) return

  let data
  try {
    let token = await getAccessToken()
    data = await callImgSecCheck(token, buffer)
    if (data && isTokenExpired(data.errcode)) {
      token = await getAccessToken(true)
      data = await callImgSecCheck(token, buffer)
    }
  } catch (err) {
    console.error('[wx-sec-check] img_sec_check 调用异常:', err && err.message)
    throw new Error('INVALID_PARAMS: SEC_CHECK_UNAVAILABLE: 头像校验暂不可用，请稍后重试')
  }

  if (data && data.errcode === ERRCODE_RISKY) {
    throw new Error('INVALID_PARAMS: CONTENT_RISKY: 图片含违规内容，请更换后重试')
  }
  if (!data || data.errcode !== 0) {
    console.error('[wx-sec-check] img_sec_check 非预期返回:', safeJson(data))
    throw new Error('INVALID_PARAMS: SEC_CHECK_UNAVAILABLE: 头像校验暂不可用，请稍后重试')
  }
}

/** 调一次 msg_sec_check。有 openid 走 2.0（version/scene/openid），否则降级 1.0（仅 content）。 */
function callMsgSecCheck(token, content, scene, openid) {
  const url = `https://api.weixin.qq.com/wxa/msg_sec_check?access_token=${token}`
  const payload = openid
    ? { content, version: 2, scene, openid }
    : { content }
  return net.httpPostRaw(url, Buffer.from(JSON.stringify(payload)), 'application/json')
}

/** 调一次 img_sec_check（multipart/form-data，字段名 media，无 form-data 库手工拼） */
function callImgSecCheck(token, buffer) {
  const url = `https://api.weixin.qq.com/wxa/img_sec_check?access_token=${token}`
  const boundary = '----FengyuSecCheck' + Date.now().toString(16) + Math.random().toString(16).slice(2)
  const head = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="media"; filename="avatar.jpg"\r\n' +
    'Content-Type: application/octet-stream\r\n\r\n'
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Buffer.concat([head, buffer, tail])
  return net.httpPostRaw(url, body, `multipart/form-data; boundary=${boundary}`)
}

function safeJson(v) {
  try { return JSON.stringify(v) } catch (e) { return String(v) }
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error('解析响应失败: ' + data)) }
      })
    }).on('error', reject)
  })
}

function httpPostRaw(url, bodyBuffer, contentType) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': bodyBuffer.length },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error('解析响应失败: ' + data)) }
      })
    })
    req.on('error', reject)
    req.write(bodyBuffer)
    req.end()
  })
}

// HTTP 原语收进单一对象，便于单测覆写（避免 mock 内置 https 模块——vitest 默认外部化 Node 内置，mock 不生效）。
// 生产运行时即真实实现；单测通过 module.exports.__net.httpGetJson/httpPostRaw 注入桩。
const net = { httpGetJson, httpPostRaw }

/** 测试钩子：清空模块级 token 缓存（仅供单测重置状态用） */
function _resetTokenCache() {
  cachedToken = null
  tokenExpiresAt = 0
}

module.exports = {
  isEnabled,
  getAccessToken,
  checkText,
  checkImage,
  _resetTokenCache,
  __net: net,
}
