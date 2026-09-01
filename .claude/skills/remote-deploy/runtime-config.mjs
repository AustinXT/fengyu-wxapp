#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '../../..')

export const TARGETS = Object.freeze({
  dev: Object.freeze({
    sshHost: 'ali-demo',
    publicHost: '47.113.202.7',
    remoteDir: '/root/proj.xt.com/fengyu-wxapp/docker',
    migrationHost: '47.113.202.7',
    containerDbHost: '47.113.202.7',
    // CloudBase 标识归属断言用（方案 A：envId 随 TARGETS 入库，与 PG host 断言同一防线）
    cloudBaseEnvId: 'cloud1-3gpht4b01ff88838',
    staffEnvId: 'cloud1-9g3ydpg512eecc99',
    cdnBase: 'https://636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la',
  }),
  test: Object.freeze({
    sshHost: 'sqlserver101',
    publicHost: '101.34.242.103',
    remoteDir: '/www/wwwroot/fengyu-admin/docker',
    migrationHost: '101.34.242.103',
    containerDbHost: '172.18.0.1',
    // test 与 prod 共用同一套 CloudBase 环境（test 仅 PG 落在独立机器）
    cloudBaseEnvId: 'fengyu-client-prod-d1cga6909c0ba',
    staffEnvId: 'fengyu-staff-prod-d4dtv6052992e9',
    cdnBase: 'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la',
  }),
  prod: Object.freeze({
    sshHost: 'fengyu-prod',
    publicHost: '118.178.196.26',
    remoteDir: '/www/wwwroot/fengyu-admin/docker',
    migrationHost: '118.178.196.26',
    containerDbHost: '118.178.196.26',
    cloudBaseEnvId: 'fengyu-client-prod-d1cga6909c0ba',
    staffEnvId: 'fengyu-staff-prod-d4dtv6052992e9',
    cdnBase: 'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la',
  }),
})

const REQUIRED_KEYS = [
  'ENV_PROFILE',
  'PG_CONNECTION_STRING',
  'ADMIN_DATABASE_URL',
  'CLOUDBASE_ENV_ID',
  'CDN_BASE',
  'TENCENTCLOUD_SECRETID',
  'TENCENTCLOUD_SECRETKEY',
  'STAFF_ENV_ID',
  'STAFF_TENCENTCLOUD_SECRETID',
  'STAFF_TENCENTCLOUD_SECRETKEY',
  'CLIENT_SECRET',
  'WX_CLIENT_APPID',
  'WX_CLIENT_SECRET',
  'LAKALA_API_BASE',
  'LAKALA_APPID',
  'LAKALA_SERIAL_NO',
  'LAKALA_ENV',
  'LAKALA_PRIVATE_KEY_PEM',
  'LAKALA_PLATFORM_CERT_PEM',
  'LAKALA_SM4_KEY',
  'LAKALA_ORG_CODE',
  'ADMIN_JWT_SECRET',
  'ADMIN_RSA_PRIVATE_KEY',
  'NEXT_PUBLIC_RSA_PUBLIC_KEY',
  'ANALYST_ADMIN_LOGIN_URL',
  'ANALYST_ADMIN_ORIGIN',
  'ANALYST_PUBLIC_ORIGIN',
]

const ADMIN_PASSTHROUGH = [
  'CLOUDBASE_ENV_ID',
  'CDN_BASE',
  'TENCENTCLOUD_SECRETID',
  'TENCENTCLOUD_SECRETKEY',
  'STAFF_ENV_ID',
  'STAFF_TENCENTCLOUD_SECRETID',
  'STAFF_TENCENTCLOUD_SECRETKEY',
  'CLIENT_SECRET',
  'WX_CLIENT_APPID',
  'WX_CLIENT_SECRET',
  'WXACODE_ENV_VERSION',
  'TMAP_KEY',
  'TMAP_SECRET',
  'PRIVATE_UPLOAD_DIR',
  'SYSTEM_RUNTIME_DIR',
  'DATABASE_BACKUP_REQUEST_DIR',
  'SEC_CHECK_ENABLED',
  'ALIYUN_OCR_MODE',
  'ALIYUN_ACCESS_KEY_ID',
  'ALIYUN_ACCESS_KEY_SECRET',
  'ALIYUN_OCR_ENDPOINT',
  'ANALYST_INTERNAL_ORIGIN',
  'MSSQL_CONNECTION_STRING',
]

// v2.0 首次启用严格配置门禁时允许从模板补齐的非秘密运行时默认值。
// 秘密、数据库地址和环境标识绝不能从 example 猜测，必须沿用真实 env 或历史 staff 账号文件。
const LEGACY_SAFE_DEFAULT_KEYS = [
  'SYSTEM_RUNTIME_DIR',
  'DATABASE_BACKUP_REQUEST_DIR',
  'DATABASE_BACKUP_DIR',
  'SCHEDULED_BACKUP_RETENTION_DAYS',
  'MANUAL_BACKUP_RETENTION_DAYS',
  'WECHAT_BOT_WEBHOOK_URL',
  'COOKIE_DOMAIN',
  'ANALYST_INTERNAL_ORIGIN',
]

const CRON_PASSTHROUGH = [
  'CLOUDBASE_ENV_ID',
  'CDN_BASE',
  'TENCENTCLOUD_SECRETID',
  'TENCENTCLOUD_SECRETKEY',
  'CLIENT_SECRET',
  'WX_CLIENT_APPID',
  'WX_CLIENT_SECRET',
  'PRIVATE_UPLOAD_DIR',
  'SYSTEM_RUNTIME_DIR',
  'DATABASE_BACKUP_REQUEST_DIR',
  'DATABASE_BACKUP_DIR',
  'SCHEDULED_BACKUP_RETENTION_DAYS',
  'MANUAL_BACKUP_RETENTION_DAYS',
  'WECHAT_BOT_WEBHOOK_URL',
]

const EXPORT_PASSTHROUGH = [
  'CLOUDBASE_ENV_ID',
  'CDN_BASE',
  'TENCENTCLOUD_SECRETID',
  'TENCENTCLOUD_SECRETKEY',
  'SYSTEM_RUNTIME_DIR',
]

const LAKALA_KEYS = [
  'LAKALA_API_FAMILY',
  'LAKALA_CLIENT_MODE',
  'LAKALA_API_BASE',
  'LAKALA_TEST_BASE_URL',
  'LAKALA_APPID',
  'LAKALA_SERIAL_NO',
  'LAKALA_CALLBACK_IP_WHITELIST',
  'LAKALA_ENV',
  'LAKALA_PRIVATE_KEY_PEM',
  'LAKALA_PLATFORM_CERT_PEM',
  'LAKALA_SM4_KEY',
  'LAKALA_ORG_CODE',
  'LAKALA_USER_NO',
  'LAKALA_ACTIVITY_ID',
  'LAKALA_MCC',
  'LAKALA_SETTLEMENT_TYPE',
  'LAKALA_SOURCE',
  'LAKALA_SUB_APPID',
  'LAKALA_ALIPAY_SHARE_SOURCE',
  'LAKALA_ONBOARDING_API_BASE',
  'LAKALA_ECONTRACT_CALLBACK_URL',
  'LAKALA_ECONTRACT_TYPE',
  'LAKALA_ONBOARDING_EMAIL',
  'LAKALA_ONBOARDING_BUSI_CODE',
  'LAKALA_ONBOARDING_MER_TYPE',
  'LAKALA_ONBOARDING_DEFAULT_LATITUDE',
  'LAKALA_ONBOARDING_DEFAULT_LONGITUDE',
  'LAKALA_ONBOARDING_BUSINESS_CONTENT',
]

function fail(message) {
  throw new Error(message)
}

function endsWithUnescapedQuote(text) {
  if (!text.endsWith('"')) return false
  let backslashCount = 0
  for (let index = text.length - 2; index >= 0 && text[index] === '\\'; index -= 1) {
    backslashCount += 1
  }
  return backslashCount % 2 === 0
}

function decodeQuoted(body) {
  let decoded = ''
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (character !== '\\' || index + 1 >= body.length) {
      decoded += character
      continue
    }
    const next = body[index + 1]
    if (next === 'n') decoded += '\n'
    else if (next === '"') decoded += '"'
    else if (next === '\\') decoded += '\\'
    else decoded += `\\${next}`
    index += 1
  }
  return decoded
}

export function parseEnv(text) {
  const result = {}
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    const key = match[1]
    if (Object.hasOwn(result, key)) fail(`duplicate environment key: ${key}`)
    let value = match[2]
    if (value.startsWith('"') && !endsWithUnescapedQuote(value)) {
      const startLine = index + 1
      while (index + 1 < lines.length) {
        value += `\n${lines[++index]}`
        if (endsWithUnescapedQuote(value)) break
      }
      if (!endsWithUnescapedQuote(value)) {
        fail(`env file line ${startLine}: KEY "${key}" has an unterminated double-quoted value (quote opened but never closed before end of file)`)
      }
    }
    if (value.startsWith('"') && endsWithUnescapedQuote(value)) {
      value = decodeQuoted(value.slice(1, -1))
    }
    result[key] = value
  }
  return result
}

// envs 源文件编码必须保留字面 $，绝不能转换为 compose 专用的 $$。
export function encodeEnvValue(value) {
  const stringValue = String(value ?? '')
  if (!/[\n\r"#]|^\s|\s$/.test(stringValue)) return stringValue
  return `"${stringValue
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n')}"`
}

// compose env_file 消费侧会插值 $；双写为 $$ 才能保留字面值。
function encodeComposeEnvValue(value) {
  return encodeEnvValue(value).replace(/\$/g, () => '$$')
}

export function renderEnv(values) {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${encodeComposeEnvValue(value)}`)
    .join('\n')}\n`
}

function templateKeys(text) {
  return [...text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((match) => match[1])
}

function renderFromTemplate(template, values) {
  return template.replace(
    /^([A-Za-z_][A-Za-z0-9_]*)=.*$/gm,
    (_, key) => `${key}=${encodeEnvValue(values[key])}`,
  )
}

function readOptionalEnv(file) {
  return fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {}
}

/**
 * 将 v2.0 之前的三个真实 env 原地迁移到严格门禁要求：
 * - 保留各环境已有真值；
 * - staff 独立账号沿用旧 fengyu-staff/.env（test 优先沿用 prod）；
 * - 仅补齐明确列出的非秘密模板默认值；
 * - 三份文件全部校验通过后再以 0600 写回。
 */
export function reconcileLegacyConfigFiles(options = {}) {
  const root = options.root || ROOT
  const templateRoot = options.templateRoot || root
  const envDir = path.join(root, 'envs')
  const templateEnvDir = path.join(templateRoot, 'envs')
  const templates = {
    dev: fs.readFileSync(path.join(templateEnvDir, 'dev.env.example'), 'utf8'),
    test: fs.readFileSync(path.join(templateEnvDir, 'prod.env.example'), 'utf8'),
    prod: fs.readFileSync(path.join(templateEnvDir, 'prod.env.example'), 'utf8'),
  }
  const templateValues = Object.fromEntries(
    Object.entries(templates).map(([env, text]) => [env, parseEnv(text)]),
  )
  const current = Object.fromEntries(['dev', 'test', 'prod'].map((env) => [
    env,
    readOptionalEnv(path.join(envDir, `${env}.env`)),
  ]))
  const legacyStaff = readOptionalEnv(path.join(root, 'fengyu-staff/.env'))

  const configs = Object.fromEntries(['dev', 'test', 'prod'].map((env) => {
    const config = { ...current[env], ENV_PROFILE: env }
    for (const key of LEGACY_SAFE_DEFAULT_KEYS) {
      const templateDefault = key === 'COOKIE_DOMAIN' && env !== 'prod' ? '' : templateValues[env][key]
      if (!Object.hasOwn(config, key) || (!config[key] && templateDefault)) {
        config[key] = templateDefault
      }
    }
    // dev/test 当前均以 IP 访问；注入生产父域会令浏览器拒收登录 Cookie。
    if (env !== 'prod') config.COOKIE_DOMAIN = ''
    const staffFallback = env === 'test' ? current.prod : {}
    config.STAFF_TENCENTCLOUD_SECRETID ||= (
      staffFallback.STAFF_TENCENTCLOUD_SECRETID || legacyStaff.TENCENTCLOUD_SECRETID
    )
    config.STAFF_TENCENTCLOUD_SECRETKEY ||= (
      staffFallback.STAFF_TENCENTCLOUD_SECRETKEY || legacyStaff.TENCENTCLOUD_SECRETKEY
    )
    validateConfig(env, config)
    return [env, config]
  }))

  for (const env of ['dev', 'test', 'prod']) {
    const file = path.join(envDir, `${env}.env`)
    const keys = templateKeys(templates[env])
    const missing = keys.filter((key) => configs[env][key] === undefined)
    if (missing.length) fail(`${path.relative(root, file)} missing keys after reconcile: ${missing.join(', ')}`)
    fs.writeFileSync(file, renderFromTemplate(templates[env], configs[env]), { mode: 0o600 })
    fs.chmodSync(file, 0o600)
  }

  return { environments: ['dev', 'test', 'prod'], keyCount: templateKeys(templates.prod).length }
}

function assertUrl(name, value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail(`${name} must be a valid URL`)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    fail(`${name} must be a credential-free http(s) URL`)
  }
  return url
}

function assertDatabaseUrl(name, value, expectedHost) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail(`${name} must be a valid PostgreSQL URL`)
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) fail(`${name} must use PostgreSQL`)
  if (url.hostname !== expectedHost || url.port !== '5433' || url.pathname !== '/fengyu_wxapp') {
    fail(`${name} must target ${expectedHost}:5433/fengyu_wxapp`)
  }
}

function assertRsaPair(config) {
  let derived
  let configured
  try {
    const privatePem = Buffer.from(config.ADMIN_RSA_PRIVATE_KEY, 'base64').toString('utf8')
    const publicPem = Buffer.from(config.NEXT_PUBLIC_RSA_PUBLIC_KEY, 'base64').toString('utf8')
    derived = crypto.createPublicKey(privatePem).export({ type: 'spki', format: 'der' })
    configured = crypto.createPublicKey(publicPem).export({ type: 'spki', format: 'der' })
  } catch {
    fail('ADMIN RSA key pair is not valid base64-encoded PEM')
  }
  if (!crypto.timingSafeEqual(derived, configured)) fail('ADMIN RSA public/private keys do not match')
}

function assertOptionalProvider(config, prefix) {
  const key = config[`${prefix}_API_KEY`] || ''
  const model = config[`${prefix}_MODEL`] || ''
  if ((key && !model) || (!key && model)) fail(`${prefix}_API_KEY and ${prefix}_MODEL must be set together`)
}

export function validateConfig(env, config) {
  const target = TARGETS[env]
  if (!target) fail(`unsupported environment: ${env}`)
  for (const key of REQUIRED_KEYS) {
    if (!config[key]) fail(`envs/${env}.env missing required ${key}`)
  }
  if (config.ENV_PROFILE !== env) fail(`ENV_PROFILE=${config.ENV_PROFILE || 'empty'}, expected ${env}`)
  for (const [key, value] of Object.entries(config)) {
    if (/PLACEHOLDER|CHANGE_ME|REPLACE_ME|^<[^>]+>$/.test(value)) fail(`${key} still contains a placeholder`)
  }

  assertDatabaseUrl('PG_CONNECTION_STRING', config.PG_CONNECTION_STRING, target.migrationHost)
  assertDatabaseUrl('ADMIN_DATABASE_URL', config.ADMIN_DATABASE_URL, target.containerDbHost)
  if (config.CLOUDBASE_ENV_ID !== target.cloudBaseEnvId) {
    fail(`CLOUDBASE_ENV_ID does not belong to the ${env} target (expected ${target.cloudBaseEnvId}) — cross-environment config?`)
  }
  if (config.STAFF_ENV_ID !== target.staffEnvId) {
    fail(`STAFF_ENV_ID does not belong to the ${env} target (expected ${target.staffEnvId}) — cross-environment config?`)
  }
  assertUrl('CDN_BASE', config.CDN_BASE)
  if (config.CDN_BASE !== target.cdnBase) {
    fail(`CDN_BASE does not belong to the ${env} target (expected ${target.cdnBase}) — cross-environment config?`)
  }
  assertUrl('ANALYST_ADMIN_LOGIN_URL', config.ANALYST_ADMIN_LOGIN_URL)
  assertUrl('ANALYST_ADMIN_ORIGIN', config.ANALYST_ADMIN_ORIGIN)
  assertUrl('ANALYST_PUBLIC_ORIGIN', config.ANALYST_PUBLIC_ORIGIN)
  assertRsaPair(config)
  assertOptionalProvider(config, 'MINIMAX')
  assertOptionalProvider(config, 'OPENAI')

  if (env === 'prod' && !config.COOKIE_DOMAIN) fail('prod COOKIE_DOMAIN must be explicit')
  if (env === 'test') {
    if (!['release', 'prod', 'production'].includes(config.LAKALA_ENV)) {
      fail('test LAKALA_ENV must use the approved production onboarding channel')
    }
    if (config.LAKALA_ONBOARDING_API_BASE !== 'https://s2.lakala.com') {
      fail('test LAKALA_ONBOARDING_API_BASE must be https://s2.lakala.com')
    }
    if (config.LAKALA_APPID === 'OP00000003') fail('test LAKALA_APPID must not use the SIT credential')
  }

  return target
}

export function readConfig(env, options = {}) {
  const file = options.file || path.join(ROOT, 'envs', `${env}.env`)
  const stat = fs.statSync(file)
  if ((stat.mode & 0o077) !== 0) fail(`${path.relative(ROOT, file)} must have mode 0600`)
  const config = parseEnv(fs.readFileSync(file, 'utf8'))
  validateConfig(env, config)
  return { file, config, target: TARGETS[env] }
}

function pick(config, keys) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(config, key)).map((key) => [key, config[key]]))
}

export function buildServiceEnvs(config) {
  const lakala = pick(config, LAKALA_KEYS)
  return {
    admin: {
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai',
      DATABASE_URL: config.ADMIN_DATABASE_URL,
      JWT_SECRET: config.ADMIN_JWT_SECRET,
      RSA_PRIVATE_KEY: config.ADMIN_RSA_PRIVATE_KEY,
      COOKIE_DOMAIN: config.COOKIE_DOMAIN || '',
      COOKIE_SECURE: '',
      NEXT_PUBLIC_ANALYST_ORIGIN: config.ANALYST_PUBLIC_ORIGIN,
      ...pick(config, ADMIN_PASSTHROUGH),
      ...lakala,
    },
    'cron-worker': {
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai',
      DATABASE_URL: config.ADMIN_DATABASE_URL,
      ...pick(config, CRON_PASSTHROUGH),
    },
    'export-worker': {
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai',
      DATABASE_URL: config.ADMIN_DATABASE_URL,
      JWT_SECRET: config.ADMIN_JWT_SECRET,
      ...pick(config, EXPORT_PASSTHROUGH),
    },
    analyst: {
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai',
      DATABASE_URL: config.ADMIN_DATABASE_URL,
      JWT_SECRET: config.ADMIN_JWT_SECRET,
      ADMIN_LOGIN_URL: config.ANALYST_ADMIN_LOGIN_URL,
      NEXT_PUBLIC_ADMIN_ORIGIN: config.ANALYST_ADMIN_ORIGIN,
      NEXT_PUBLIC_ANALYST_ORIGIN: config.ANALYST_PUBLIC_ORIGIN,
      ANALYST_VIEW_ACTION: config.ANALYST_VIEW_ACTION,
      ANALYST_CHAT_ACTION: config.ANALYST_CHAT_ACTION,
      ANALYST_EXPORT_ACTION: config.ANALYST_EXPORT_ACTION,
      MINIMAX_API_KEY: config.MINIMAX_API_KEY,
      MINIMAX_BASE_URL: config.MINIMAX_BASE_URL,
      MINIMAX_MODEL: config.MINIMAX_MODEL,
      OPENAI_API_KEY: config.OPENAI_API_KEY,
      OPENAI_BASE_URL: config.OPENAI_BASE_URL,
      OPENAI_MODEL: config.OPENAI_MODEL,
    },
  }
}

function publicManifest(env, config, target) {
  return {
    env,
    sshHost: target.sshHost,
    publicHost: target.publicHost,
    remoteDir: target.remoteDir,
    migrationHost: target.migrationHost,
    containerDbHost: target.containerDbHost,
    analystPublicOrigin: config.ANALYST_PUBLIC_ORIGIN,
    analystAdminOrigin: config.ANALYST_ADMIN_ORIGIN,
    analystAdminLoginUrl: config.ANALYST_ADMIN_LOGIN_URL,
    nextPublicRsaPublicKey: config.NEXT_PUBLIC_RSA_PUBLIC_KEY,
    cloudbaseEnvId: config.CLOUDBASE_ENV_ID,
    cdnBase: config.CDN_BASE,
  }
}

export function renderBundle(env, outputDir, options = {}) {
  const { config, target } = readConfig(env, options)
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(outputDir, 0o700)
  const services = buildServiceEnvs(config)
  for (const [service, values] of Object.entries(services)) {
    const file = path.join(outputDir, `${service}.env`)
    fs.writeFileSync(file, renderEnv(values), { mode: 0o600 })
    fs.chmodSync(file, 0o600)
  }
  const manifest = publicManifest(env, config, target)
  fs.writeFileSync(path.join(outputDir, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return manifest
}

export const KNOWN_PROD_HISTORICAL_MIGRATION_ROWS = Object.freeze([
  {
    // 生产库历史 0034 遗留行；2026-09-01 只读核验，非当前本地 journal 的迁移。
    created_at: '1787637056739',
    hash: 'd4549ec0237b8f4441af860a02c0905e59e382e3c07503063f6310ec95b896bd',
  },
])

function migrationRowKey(row) {
  return `${String(row.created_at)}|${row.hash}`
}

export function analyzeMigrationState(entries, remoteRows, hashes, options = {}) {
  if (!remoteRows.length) return { ok: false, reason: 'migration journal is empty', pending: [] }
  const knownHistoricalKeys = new Set((options.knownHistoricalRows ?? []).map(migrationRowKey))
  const ignoredHistoricalRows = remoteRows.filter((row) => knownHistoricalKeys.has(migrationRowKey(row)))
  const effectiveRemoteRows = remoteRows.filter((row) => !knownHistoricalKeys.has(migrationRowKey(row)))
  if (!effectiveRemoteRows.length) {
    return { ok: false, reason: 'migration journal has no local-compatible rows', pending: [] }
  }
  const latestRemote = [...effectiveRemoteRows].sort((a, b) => Number(b.created_at) - Number(a.created_at))[0]
  const latestWhen = Number(latestRemote.created_at)
  const localAtLatest = entries.find((entry) => Number(entry.when) === latestWhen)
  if (!localAtLatest) {
    const latestLocal = Math.max(...entries.map((entry) => Number(entry.when)))
    return {
      ok: false,
      reason: latestWhen > latestLocal ? 'database is ahead of local code' : 'database latest migration is absent from local journal',
      pending: [],
    }
  }
  if (hashes.get(localAtLatest.tag) !== latestRemote.hash) {
    return { ok: false, reason: `latest migration hash mismatch: ${localAtLatest.tag}`, pending: [] }
  }
  const pending = entries.filter((entry) => Number(entry.when) > latestWhen).map((entry) => entry.tag)
  const historicalRowDelta = effectiveRemoteRows.length - entries.filter((entry) => Number(entry.when) <= latestWhen).length
  // journal 完整性必须双向一致；任一侧缺历史行都可能让缺表缺列的版本被错误放行。
  if (historicalRowDelta < 0) {
    return {
      ok: false,
      reason: `remote journal is missing ${Math.abs(historicalRowDelta)} historical migration row(s)`,
      pending,
      latestTag: localAtLatest.tag,
      historicalRowDelta,
    }
  }
  if (historicalRowDelta > 0) {
    return {
      ok: false,
      reason: `local journal is missing ${historicalRowDelta} historical migration row(s) present on remote`,
      pending,
      latestTag: localAtLatest.tag,
      historicalRowDelta,
    }
  }
  return {
    ok: pending.length === 0,
    reason: pending.length ? `${pending.length} pending migration(s)` : '',
    pending,
    latestTag: localAtLatest.tag,
    historicalRowDelta,
    ignoredHistoricalRowCount: ignoredHistoricalRows.length,
  }
}

export async function checkMigrations(env, options = {}) {
  const { config, target } = readConfig(env, options)
  const url = env === 'test' ? config.PG_CONNECTION_STRING : config.ADMIN_DATABASE_URL
  const requireFromDb = createRequire(path.join(ROOT, 'db/package.json'))
  const { Client } = requireFromDb('pg')
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 })
  const journal = JSON.parse(fs.readFileSync(path.join(ROOT, 'db/migrations/meta/_journal.json'), 'utf8'))
  const hashes = new Map(journal.entries.map((entry) => {
    const sql = fs.readFileSync(path.join(ROOT, 'db/migrations', `${entry.tag}.sql`), 'utf8')
    return [entry.tag, crypto.createHash('sha256').update(sql).digest('hex')]
  }))
  try {
    await client.connect()
    const table = await client.query("SELECT to_regclass('drizzle.__drizzle_migrations')::text AS name")
    if (!table.rows[0]?.name) fail('target database has no drizzle migration journal')
    const result = await client.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id')
    const state = analyzeMigrationState(journal.entries, result.rows, hashes, {
      knownHistoricalRows: env === 'prod' ? KNOWN_PROD_HISTORICAL_MIGRATION_ROWS : [],
    })
    if (!state.ok) {
      const detail = state.pending.length ? `: ${state.pending.join(', ')}` : ''
      fail(`${state.reason}${detail}`)
    }
    return { ...state, host: target.migrationHost }
  } finally {
    await client.end().catch(() => {})
  }
}

async function main() {
  const [command, env, outputDir] = process.argv.slice(2)
  if (command === 'reconcile') {
    try {
      const result = reconcileLegacyConfigFiles()
      console.log(`reconciled ${result.environments.join('/')} (${result.keyCount} keys, mode 0600)`)
    } catch (error) {
      console.error(`ERROR: ${error.message}`)
      process.exit(1)
    }
    return
  }
  if (!['dev', 'test', 'prod'].includes(env)) {
    console.error('Usage: runtime-config.mjs reconcile | <validate|render|migrations> <dev|test|prod> [output-dir]')
    process.exit(1)
  }
  try {
    if (command === 'validate') {
      const { config, target } = readConfig(env)
      console.log(JSON.stringify(publicManifest(env, config, target)))
    } else if (command === 'render') {
      if (!outputDir) fail('render requires an output directory')
      console.log(JSON.stringify(renderBundle(env, outputDir)))
    } else if (command === 'migrations') {
      const state = await checkMigrations(env)
      const drift = state.historicalRowDelta ? `; historical row delta=${state.historicalRowDelta}` : ''
      console.log(`migration gate passed: ${env} ${state.host} latest=${state.latestTag}${drift}`)
    } else {
      fail(`unsupported command: ${command}`)
    }
  } catch (error) {
    console.error(`ERROR: ${error.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
