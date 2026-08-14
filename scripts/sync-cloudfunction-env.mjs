#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'

const [configPath, functionName, ...rawArgs] = process.argv.slice(2)

function usage() {
  console.error('Usage: sync-cloudfunction-env.mjs <cloudbaserc.json> <function> --sync KEY[,KEY] --require KEY[,KEY]')
  process.exit(1)
}

if (!configPath || !functionName) usage()

function optionValues(name) {
  const index = rawArgs.indexOf(name)
  if (index < 0 || !rawArgs[index + 1]) return []
  return rawArgs[index + 1].split(',').map((value) => value.trim()).filter(Boolean)
}

const syncKeys = optionValues('--sync')
const requiredKeys = optionValues('--require')
if (syncKeys.length === 0 && requiredKeys.length === 0) usage()

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const envId = String(config.envId || '').trim()
const localFunction = (config.functions || []).find((item) => item.name === functionName)
if (!envId || !localFunction) throw new Error(`配置中找不到 ${functionName} 或 envId`)
const desired = localFunction.envVariables || {}

for (const key of [...syncKeys, ...requiredKeys]) {
  if (!(key in desired) || String(desired[key]).length === 0) {
    throw new Error(`${functionName} 本地配置缺少必填变量 ${key}`)
  }
}

function extractJson(output) {
  const start = output.indexOf('{')
  if (start < 0) throw new Error('CLI 未返回 JSON')
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < output.length; index += 1) {
    const char = output[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) return JSON.parse(output.slice(start, index + 1))
  }
  throw new Error('CLI JSON 不完整')
}

function tcb(args) {
  const result = spawnSync('tcb', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  })
  if (result.status !== 0) {
    const message = String(result.stderr || result.stdout || '').split('\n').filter(Boolean).slice(-3).join(' ')
    throw new Error(`tcb 调用失败：${message || `exit ${result.status}`}`)
  }
  const payload = extractJson(result.stdout)
  if (payload.error) throw new Error(`tcb 返回错误：${payload.error.message || payload.error.code || 'unknown'}`)
  return payload
}

function remoteVariables() {
  const payload = tcb(['-e', envId, 'fn', 'detail', functionName, '--json'])
  const variables = payload.data?.Environment?.Variables
  if (!Array.isArray(variables)) throw new Error(`${functionName} 远端环境变量响应无效`)
  return new Map(variables.map(({ Key, Value }) => [String(Key), String(Value)]))
}

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest()
}

async function updateFunctionEnvironment(variables) {
  const secretId = process.env.TENCENTCLOUD_SECRETID?.trim()
  const secretKey = process.env.TENCENTCLOUD_SECRETKEY?.trim()
  if (!secretId || !secretKey) throw new Error('当前腾讯云账号凭据未注入')

  const service = 'scf'
  const host = 'scf.tencentcloudapi.com'
  const region = process.env.TENCENTCLOUD_REGION?.trim() || 'ap-shanghai'
  const action = 'UpdateFunctionConfiguration'
  const version = '2018-04-16'
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const payload = JSON.stringify({
    FunctionName: functionName,
    Namespace: envId,
    Environment: {
      Variables: [...variables.entries()].map(([Key, Value]) => ({ Key, Value })),
    },
  })
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`
  const signedHeaders = 'content-type;host'
  const hashedPayload = crypto.createHash('sha256').update(payload).digest('hex')
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`
  const algorithm = 'TC3-HMAC-SHA256'
  const credentialScope = `${date}/${service}/tc3_request`
  const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`
  const secretDate = hmac(`TC3${secretKey}`, date)
  const secretService = hmac(secretDate, service)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex')
  const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const response = await fetch(`https://${host}`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      Host: host,
      'X-TC-Action': action,
      'X-TC-Region': region,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': version,
    },
    body: payload,
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.Response?.Error) {
    const code = body?.Response?.Error?.Code || `HTTP_${response.status}`
    const message = body?.Response?.Error?.Message || 'unknown error'
    throw new Error(`SCF 环境变量更新失败：${code} ${message}`)
  }
}

let remote = remoteVariables()
const changedKeys = syncKeys.filter((key) => remote.get(key) !== String(desired[key]))

if (changedKeys.length > 0) {
  for (const key of changedKeys) remote.set(key, String(desired[key]))
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      await updateFunctionEnvironment(remote)
      break
    } catch (error) {
      const updating = error instanceof Error && /处于Updating状态|ResourceInUse/i.test(error.message)
      if (!updating || attempt === 14) throw error
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
  console.log(`  ✓ ${functionName} 已合并更新变量：${changedKeys.join(', ')}`)
  for (let attempt = 0; attempt < 10; attempt += 1) {
    remote = remoteVariables()
    if (syncKeys.every((key) => remote.get(key) === String(desired[key]))) break
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
} else {
  console.log(`  ✓ ${functionName} 待同步变量已一致`)
}

for (const key of syncKeys) {
  if (remote.get(key) !== String(desired[key])) throw new Error(`${functionName} 变量 ${key} 回读不一致`)
}
for (const key of requiredKeys) {
  if (!remote.get(key)) throw new Error(`${functionName} 远端缺少必填变量 ${key}`)
}

console.log(`  ✓ ${functionName} 环境变量回读验证通过（${[...new Set([...syncKeys, ...requiredKeys])].join(', ')}）`)
