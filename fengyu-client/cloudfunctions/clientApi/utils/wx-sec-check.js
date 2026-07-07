

'use strict'

const https = require('https')
const cloud = require('wx-server-sdk')



const clientAppid = () => process.env.CLIENT_APPID || 'wx811eb4ded3dfba3f'
const clientAppsecret = () => process.env.CLIENT_APPSECRET



const BLOCK_REVIEW = false


const ERRCODE_RISKY = 87014


let cachedToken = null
let tokenExpiresAt = 0


function isEnabled() {
  return process.env.SEC_CHECK_ENABLED === 'true' && !!clientAppsecret()
}


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


function isTokenExpired(errcode) {
  return errcode === 40001 || errcode === 42001 || errcode === 40014
}


function currentOpenid() {
  try {
    return (cloud.getWXContext() || {}).OPENID || null
  } catch (e) {
    return null
  }
}


async function checkText(content, opts = {}) {
  if (!isEnabled()) return
  if (content == null) return
  const text = String(content).trim()
  if (!text) return 

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

  
  if (data && data.errcode === ERRCODE_RISKY) {
    throw new Error('INVALID_PARAMS: CONTENT_RISKY: 内容包含违规信息，请修改后重试')
  }
  
  if (!data || data.errcode !== 0) {
    console.error('[wx-sec-check] msg_sec_check 非预期返回:', safeJson(data))
    throw new Error('INVALID_PARAMS: SEC_CHECK_UNAVAILABLE: 安全校验暂不可用，请稍后重试')
  }
  
  const suggest = data.result && data.result.suggest
  if (suggest === 'risky' || (BLOCK_REVIEW && suggest === 'review')) {
    throw new Error('INVALID_PARAMS: CONTENT_RISKY: 内容包含违规信息，请修改后重试')
  }
}


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


function callMsgSecCheck(token, content, scene, openid) {
  const url = `https://api.weixin.qq.com/wxa/msg_sec_check?access_token=${token}`
  const payload = openid
    ? { content, version: 2, scene, openid }
    : { content }
  return net.httpPostRaw(url, Buffer.from(JSON.stringify(payload)), 'application/json')
}


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



const net = { httpGetJson, httpPostRaw }


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
