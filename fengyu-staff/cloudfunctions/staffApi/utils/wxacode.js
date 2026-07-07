

const cloud = require('wx-server-sdk')
const https = require('https')


let cachedToken = null
let tokenExpiresAt = 0

const CLIENT_APPID = process.env.CLIENT_APPID || 'wx811eb4ded3dfba3f'



const CLIENT_APPSECRET = process.env.CLIENT_APPSECRET
const WXACODE_ENV_VERSION = process.env.WXACODE_ENV_VERSION || 'release'


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
  
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000
  return cachedToken
}


async function generateWxacode(scene, page) {
  let token = await getClientAccessToken()
  let buffer = await requestWxacode(token, scene, page)

  
  if (buffer.length < 1000) {
    try {
      const errData = JSON.parse(buffer.toString())
      if (errData.errcode === 42001 || errData.errcode === 40001) {
        
        token = await getClientAccessToken(true)
        buffer = await requestWxacode(token, scene, page)
        if (buffer.length < 1000) {
          const retryErr = JSON.parse(buffer.toString())
          throw new Error(`生成小程序码失败: ${retryErr.errcode} ${retryErr.errmsg}`)
        }
      } else if (errData.errcode) {
        throw new Error(`生成小程序码失败: ${errData.errcode} ${errData.errmsg}`)
      }
    } catch (e) {
      if (e.message.startsWith('生成小程序码')) throw e
      
    }
  }

  return buffer
}


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

function requestWxacode(token, scene, page) {
  const url = `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${token}`
  const body = JSON.stringify({
    scene,
    page,
    check_path: false,
    env_version: WXACODE_ENV_VERSION,
    width: 430,
    auto_color: false,
    line_color: { r: 212, g: 167, b: 106 } 
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
  uploadToCloudStorage
}
