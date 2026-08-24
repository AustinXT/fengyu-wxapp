#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const auditDir = process.argv[2]

if (!auditDir) {
  console.error('Usage: node scripts/reconcile-env-files.mjs <prod-audit-dir>')
  process.exit(1)
}

function parseEnv(text) {
  const result = {}
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    const [, key] = match
    let value = match[2]
    if (value.startsWith('"') && !(value.length > 1 && value.endsWith('"'))) {
      while (index + 1 < lines.length) {
        value += `\n${lines[++index]}`
        if (lines[index].endsWith('"') && !lines[index].endsWith('\\"')) break
      }
    }
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
    result[key] = value
  }
  return result
}

function readEnv(file) {
  return fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {}
}

function functionEnv(name) {
  const parsed = JSON.parse(fs.readFileSync(path.join(auditDir, `${name}.json`), 'utf8'))
  return parsed.functions?.[0]?.envVariables ?? {}
}

function containerEnv(name) {
  const entries = JSON.parse(fs.readFileSync(path.join(auditDir, `${name}-container.json`), 'utf8'))
  return Object.fromEntries(entries.map((entry) => {
    const separator = entry.indexOf('=')
    return [entry.slice(0, separator), entry.slice(separator + 1)]
  }))
}

function encode(value) {
  const stringValue = String(value ?? '')
  if (!/[\n\r"#]|^\s|\s$/.test(stringValue)) return stringValue
  return `"${stringValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`
}

function templateKeys(text) {
  return [...text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((match) => match[1])
}

function render(template, values) {
  return template.replace(/^([A-Za-z_][A-Za-z0-9_]*)=.*$/gm, (_, key) => `${key}=${encode(values[key])}`)
}

const prodTemplatePath = path.join(root, 'envs/prod.env.example')
const devTemplatePath = path.join(root, 'envs/dev.env.example')
const prodTemplate = fs.readFileSync(prodTemplatePath, 'utf8')
const devTemplate = fs.readFileSync(devTemplatePath, 'utf8')
const prodTemplateValues = parseEnv(prodTemplate)
const devTemplateValues = parseEnv(devTemplate)

const prodPath = path.join(root, 'envs/prod.env')
const testPath = path.join(root, 'envs/test.env')
const devPath = path.join(root, 'envs/dev.env')
const currentProd = readEnv(prodPath)
const currentTest = readEnv(testPath)
const currentDev = readEnv(devPath)
const staffAccount = readEnv(path.join(root, 'fengyu-staff/.env'))
const admin = readEnv(path.join(auditDir, 'admin.env'))
const adminContainer = containerEnv('admin')
const analystContainer = containerEnv('analyst')
const clientApi = functionEnv('clientApi')
const payNotify = functionEnv('payNotify')
const staffApi = functionEnv('staffApi')

// 权威顺序：模板安全默认值 < 本地已有值 < prod 主机源文件/容器运行态 < 对应线上云函数。
const prod = {
  ...prodTemplateValues,
  ...currentProd,
  ...admin,
  ...adminContainer,
  ...analystContainer,
  ...clientApi,
  ...payNotify,
  ...staffApi,
}

// 容器内的派生键不进入中央 env；只反向映射实际部署值所对应的规范键。
Object.assign(prod, {
  ADMIN_DATABASE_URL: adminContainer.DATABASE_URL ?? prod.ADMIN_DATABASE_URL,
  ADMIN_JWT_SECRET: adminContainer.JWT_SECRET ?? prod.ADMIN_JWT_SECRET,
  ADMIN_RSA_PRIVATE_KEY: adminContainer.RSA_PRIVATE_KEY ?? prod.ADMIN_RSA_PRIVATE_KEY,
  ANALYST_ADMIN_LOGIN_URL: analystContainer.ADMIN_LOGIN_URL ?? prod.ANALYST_ADMIN_LOGIN_URL,
  ANALYST_ADMIN_ORIGIN: analystContainer.NEXT_PUBLIC_ADMIN_ORIGIN ?? prod.ANALYST_ADMIN_ORIGIN,
  ANALYST_PUBLIC_ORIGIN: analystContainer.NEXT_PUBLIC_ANALYST_ORIGIN ?? prod.ANALYST_PUBLIC_ORIGIN,
  STAFF_TENCENTCLOUD_SECRETID: adminContainer.STAFF_TENCENTCLOUD_SECRETID || staffAccount.TENCENTCLOUD_SECRETID || prod.STAFF_TENCENTCLOUD_SECRETID,
  STAFF_TENCENTCLOUD_SECRETKEY: adminContainer.STAFF_TENCENTCLOUD_SECRETKEY || staffAccount.TENCENTCLOUD_SECRETKEY || prod.STAFF_TENCENTCLOUD_SECRETKEY,
  ENV_PROFILE: 'prod',
})

// PG_CONNECTION_STRING 以三个线上云函数共同使用的 PG 为准，远程 admin 的同名遗留值不参与。
prod.PG_CONNECTION_STRING = clientApi.PG_CONNECTION_STRING

const test = { ...prodTemplateValues, ...currentTest, ENV_PROFILE: 'test' }
const dev = { ...devTemplateValues, ...currentTest, ...currentDev, ENV_PROFILE: 'dev' }

for (const [file, template, values] of [
  [prodPath, prodTemplate, prod],
  [testPath, prodTemplate, test],
  [devPath, devTemplate, dev],
]) {
  const keys = templateKeys(template)
  const missing = keys.filter((key) => values[key] === undefined)
  if (missing.length) throw new Error(`${path.basename(file)} missing keys: ${missing.join(', ')}`)
  fs.writeFileSync(file, render(template, values), { mode: 0o600 })
}

console.log(`Reconciled ${templateKeys(prodTemplate).length} keys across prod/test/dev without printing values.`)
