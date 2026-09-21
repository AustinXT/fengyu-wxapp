/**
 * 小程序码生成工具
 * 使用 HTTP API 生成客户端小程序码（跨 appid）
 */

const cloud = require('wx-server-sdk')
const https = require('https')

// 模块级 access_token 缓存
let cachedToken = null
let tokenExpiresAt = 0

const CLIENT_APPID = process.env.CLIENT_APPID || 'wx811eb4ded3dfba3f'
// 客户端小程序真实 appsecret（换 access_token 用）。
// 注意：必须是客户端小程序的 appsecret（32 位 hex），与跨 env HMAC 用的 CLIENT_SECRET 区分开——
// 二者曾共用 CLIENT_SECRET，prod 把它配成了 64 位内部 HMAC 密钥，导致换 token 报 40125 invalid appsecret。
const CLIENT_APPSECRET = process.env.CLIENT_APPSECRET
const WXACODE_ENV_VERSION = process.env.WXACODE_ENV_VERSION || 'release'

// 微信只认这三个值；其余一律回落到环境变量默认值
const VALID_ENV_VERSIONS = ['develop', 'trial', 'release']

/**
 * 把调用方自报的版本收敛到白名单内，非法/缺失回落到本函数的部署默认值。
 *
 * 为什么要按请求传而不是只读环境变量：正式函数 staffApi 同时服务体验版和正式版，
 * 而微信规定 trial 码只能体验版打开、release 码只能正式版打开——
 * 一个环境变量满足不了两者。
 */
function resolveEnvVersion(envVersion) {
  return VALID_ENV_VERSIONS.includes(envVersion) ? envVersion : WXACODE_ENV_VERSION
}

/**
 * 本函数实例自身的部署身份：影子函数（staffApiDev）部署时 WXACODE_ENV_VERSION=develop，
 * 正式函数为 release。
 */
function getSelfEnvVersion() {
  return WXACODE_ENV_VERSION
}

/**
 * 最终生效的码版本。**这是防止影子函数覆写生产小程序码的承重逻辑。**
 *
 * - 正式函数（self=release）：服务 trial 与 release 两种调用方，按自报值决定
 * - 影子函数（self≠release）：**恒用自身版本，完全忽略调用方自报值**
 *
 * 影子函数与正式函数同住一个 env，也就是同一个 COS 桶。而 release 码刻意不带路径后缀，
 * 所以只要影子函数有任何一条路径能算出 'release'，它就会把 develop 码写进
 * `wxacode/order/<id>.png` —— 与生产同一个 key，直接覆盖，顾客扫码付不了款。
 * 两条触发路径都真实存在：① 调用方 _envVersion 缺失（getAccountInfoSync 抛错的兜底产物）
 * ② 任意已绑定员工伪造 _envVersion:'release'。
 * 因此版本必须由「函数自己是谁」决定，与「库选择由函数 env 决定」同一条原则。
 */
function effectiveEnvVersion(requested) {
  const self = getSelfEnvVersion()
  return self === 'release' ? resolveEnvVersion(requested) : self
}

/** 云存储路径 / 缓存键的版本后缀。release 无后缀（保持生产既有路径不变）。 */
function versionPathSuffix(envVersion) {
  return envVersion === 'release' ? '' : `-${envVersion}`
}

/**
 * 获取客户端小程序 access_token（带缓存）
 */
async function getClientAccessToken(forceRefresh = false) {
  if (!CLIENT_APPSECRET) {
    throw new Error('未配置 CLIENT_APPSECRET 环境变量')
  }

  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken
  }

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${CLIENT_APPID}&secret=${CLIENT_APPSECRET}`

  const data = await httpGet(url)

  if (data.errcode) {
    throw new Error(`获取 access_token 失败: ${data.errcode} ${data.errmsg}`)
  }

  cachedToken = data.access_token
  // 提前 5 分钟过期
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000
  return cachedToken
}

/**
 * 生成客户端小程序码
 * @param {string} scene - 场景值（max 32 chars）
 * @param {string} page - 小程序页面路径
 * @param {string} [envVersion] - 调用方所在的小程序版本（develop/trial/release），决定码指向哪个版本
 * @returns {Buffer} PNG 图片 buffer
 */
async function generateWxacode(scene, page, envVersion) {
  const target = resolveEnvVersion(envVersion)
  let token = await getClientAccessToken()
  let buffer = await requestWxacode(token, scene, page, target)

  // 响应小于 1000 字节可能是错误 JSON
  if (buffer.length < 1000) {
    try {
      const errData = JSON.parse(buffer.toString())
      if (errData.errcode === 42001 || errData.errcode === 40001) {
        // token 过期，清缓存重试一次
        token = await getClientAccessToken(true)
        buffer = await requestWxacode(token, scene, page, target)
        if (buffer.length < 1000) {
          const retryErr = JSON.parse(buffer.toString())
          throw new Error(`生成小程序码失败: ${retryErr.errcode} ${retryErr.errmsg}`)
        }
      } else if (errData.errcode) {
        throw new Error(`生成小程序码失败: ${errData.errcode} ${errData.errmsg}`)
      }
    } catch (e) {
      if (e.message.startsWith('生成小程序码')) throw e
      // 不是 JSON，当作正常图片
    }
  }

  return buffer
}

/**
 * 上传图片到云存储并获取 CDN URL
 * @param {Buffer} buffer - 图片数据
 * @param {string} cloudPath - 云存储路径
 * @returns {string} CDN URL
 */
async function uploadToCloudStorage(buffer, cloudPath) {
  const uploadRes = await cloud.uploadFile({
    cloudPath,
    fileContent: buffer
  })

  const urlRes = await cloud.getTempFileURL({
    fileList: [uploadRes.fileID]
  })

  const fileInfo = urlRes.fileList[0]
  if (fileInfo.status !== 0) {
    throw new Error('获取云存储临时 URL 失败')
  }

  return fileInfo.tempFileURL
}

// ========== 内部工具 ==========

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error('解析 access_token 响应失败')) }
      })
    }).on('error', reject)
  })
}

function requestWxacode(token, scene, page, envVersion) {
  const url = `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${token}`
  const body = JSON.stringify({
    scene,
    page,
    check_path: false,
    env_version: resolveEnvVersion(envVersion),
    width: 430,
    auto_color: false,
    line_color: { r: 212, g: 167, b: 106 } // 品牌金色
  })

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

module.exports = {
  getClientAccessToken,
  generateWxacode,
  uploadToCloudStorage,
  // 路由层需要用同一套判定算云存储路径/缓存键的后缀——必须复用，不能各算各的
  effectiveEnvVersion,
  versionPathSuffix,
  getSelfEnvVersion
}
