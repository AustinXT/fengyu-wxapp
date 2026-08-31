import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  TARGETS,
  ROOT,
  analyzeMigrationState,
  buildServiceEnvs,
  parseEnv,
  renderBundle,
  renderEnv,
  validateConfig,
} from './runtime-config.mjs'

function rsaPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    private: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
    public: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64'),
  }
}

function validConfig(env = 'dev') {
  const rsa = rsaPair()
  const target = TARGETS[env]
  return {
    ENV_PROFILE: env,
    PG_CONNECTION_STRING: `postgresql://user:pass@${target.migrationHost}:5433/fengyu_wxapp`,
    ADMIN_DATABASE_URL: `postgresql://user:pass@${target.containerDbHost}:5433/fengyu_wxapp`,
    CLOUDBASE_ENV_ID: `${env}-client-env`,
    CDN_BASE: 'https://cdn.example.com',
    TENCENTCLOUD_SECRETID: 'client-id',
    TENCENTCLOUD_SECRETKEY: 'client-key',
    STAFF_ENV_ID: `${env}-staff-env`,
    STAFF_TENCENTCLOUD_SECRETID: 'staff-id',
    STAFF_TENCENTCLOUD_SECRETKEY: 'staff-key',
    CLIENT_SECRET: 'shared-client-secret',
    WX_CLIENT_APPID: 'wx-client',
    WX_CLIENT_SECRET: 'wx-secret',
    WXACODE_ENV_VERSION: env === 'dev' ? 'develop' : 'release',
    TMAP_KEY: 'map-key',
    TMAP_SECRET: 'map-secret',
    LAKALA_API_FAMILY: 'openapi',
    LAKALA_CLIENT_MODE: 'real',
    LAKALA_API_BASE: 'https://s2.lakala.com',
    LAKALA_TEST_BASE_URL: 'https://test.wsmsd.cn/sit',
    LAKALA_APPID: 'OP12345678',
    LAKALA_SERIAL_NO: 'serial',
    LAKALA_CALLBACK_IP_WHITELIST: '',
    LAKALA_ENV: env === 'dev' ? 'test' : 'release',
    LAKALA_PRIVATE_KEY_PEM: 'private-key',
    LAKALA_PLATFORM_CERT_PEM: 'platform-cert',
    LAKALA_SM4_KEY: 'sm4-key',
    LAKALA_ORG_CODE: 'org',
    LAKALA_USER_NO: 'user',
    LAKALA_ACTIVITY_ID: 'activity',
    LAKALA_MCC: 'mcc',
    LAKALA_SETTLEMENT_TYPE: 'settlement',
    LAKALA_SOURCE: 'source',
    LAKALA_SUB_APPID: 'sub-app',
    LAKALA_ALIPAY_SHARE_SOURCE: '',
    LAKALA_ONBOARDING_API_BASE: env === 'dev' ? 'https://test.wsmsd.cn/sit' : 'https://s2.lakala.com',
    LAKALA_ECONTRACT_CALLBACK_URL: '',
    LAKALA_ECONTRACT_TYPE: 'EC015',
    LAKALA_ONBOARDING_EMAIL: 'ops@example.com',
    LAKALA_ONBOARDING_BUSI_CODE: 'WECHAT_PAY',
    LAKALA_ONBOARDING_MER_TYPE: 'TP_MERCHANT',
    LAKALA_ONBOARDING_DEFAULT_LATITUDE: '28.0',
    LAKALA_ONBOARDING_DEFAULT_LONGITUDE: '115.0',
    LAKALA_ONBOARDING_BUSINESS_CONTENT: 'service',
    PRIVATE_UPLOAD_DIR: '/var/lib/fengyu/private-uploads',
    SYSTEM_RUNTIME_DIR: '/var/lib/fengyu/runtime-status',
    DATABASE_BACKUP_REQUEST_DIR: '/var/lib/fengyu/backup-control',
    DATABASE_BACKUP_DIR: '/var/lib/fengyu/database-backups',
    SCHEDULED_BACKUP_RETENTION_DAYS: '7',
    MANUAL_BACKUP_RETENTION_DAYS: '30',
    WECHAT_BOT_WEBHOOK_URL: '',
    ALIYUN_OCR_MODE: 'real',
    ALIYUN_ACCESS_KEY_ID: '',
    ALIYUN_ACCESS_KEY_SECRET: '',
    ALIYUN_OCR_ENDPOINT: 'ocr.example.com',
    ADMIN_JWT_SECRET: 'jwt-secret',
    ADMIN_RSA_PRIVATE_KEY: rsa.private,
    NEXT_PUBLIC_RSA_PUBLIC_KEY: rsa.public,
    SEC_CHECK_ENABLED: 'true',
    COOKIE_DOMAIN: env === 'prod' ? '.example.com' : '',
    ANALYST_INTERNAL_ORIGIN: 'http://analyst:3000',
    ANALYST_ADMIN_LOGIN_URL: 'https://admin.example.com/login',
    ANALYST_ADMIN_ORIGIN: 'https://admin.example.com',
    ANALYST_PUBLIC_ORIGIN: 'https://analyst.example.com',
    ANALYST_VIEW_ACTION: 'data_center:dashboard',
    ANALYST_CHAT_ACTION: 'data_center:dashboard',
    ANALYST_EXPORT_ACTION: 'data_center:dashboard',
    MINIMAX_API_KEY: '',
    MINIMAX_BASE_URL: 'https://api.minimaxi.com/v1',
    MINIMAX_MODEL: '',
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_MODEL: '',
  }
}

test('env parser preserves quoted multiline values and rejects duplicate keys', () => {
  assert.deepEqual(parseEnv('A="line1\\nline2"\nB=value\n'), { A: 'line1\nline2', B: 'value' })
  assert.throws(() => parseEnv('A=1\nA=2\n'), /duplicate environment key/)
})

test('all fixed environment targets validate and RSA mismatch fails closed', () => {
  for (const env of Object.keys(TARGETS)) assert.equal(validateConfig(env, validConfig(env)), TARGETS[env])
  const config = validConfig('prod')
  config.NEXT_PUBLIC_RSA_PUBLIC_KEY = validConfig('prod').NEXT_PUBLIC_RSA_PUBLIC_KEY
  assert.throws(() => validateConfig('prod', config), /do not match/)
})

test('shell deploy targets stay identical to the validated Node target table', () => {
  const common = path.join(ROOT, '.claude/skills/remote-deploy/deploy-common.sh')
  for (const [env, target] of Object.entries(TARGETS)) {
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'source "$1"',
      'load_target "$2"',
      'printf "%s|%s|%s|%s|%s" "$SSH_HOST" "$TARGET_PUBLIC_HOST" "$REMOTE_DIR" "$MIGRATION_HOST" "$CONTAINER_DB_HOST"',
    ].join('\n'), 'bash', common, env], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, [
      target.sshHost,
      target.publicHost,
      target.remoteDir,
      target.migrationHost,
      target.containerDbHost,
    ].join('|'))
  }
})

test('service environment rendering enforces isolation', () => {
  const services = buildServiceEnvs(validConfig('prod'))
  assert.equal(services.admin.STAFF_TENCENTCLOUD_SECRETID, 'staff-id')
  assert.equal(services.admin.NEXT_PUBLIC_ANALYST_ORIGIN, 'https://analyst.example.com')
  assert.equal(services['cron-worker'].LAKALA_APPID, 'OP12345678')
  assert.equal(services['export-worker'].RSA_PRIVATE_KEY, undefined)
  assert.equal(services.analyst.STAFF_TENCENTCLOUD_SECRETID, undefined)
  assert.equal(services.analyst.LAKALA_PRIVATE_KEY_PEM, undefined)
})

test('bundle files are mode 0600 and contain only the target service whitelist', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-deploy-config-'))
  const source = path.join(temp, 'prod.env')
  fs.writeFileSync(source, renderEnv(validConfig('prod')), { mode: 0o600 })
  const output = path.join(temp, 'bundle')
  renderBundle('prod', output, { file: source })
  for (const file of ['admin.env', 'cron-worker.env', 'export-worker.env', 'analyst.env', 'build-manifest.json']) {
    assert.equal(fs.statSync(path.join(output, file)).mode & 0o777, 0o600)
  }
  const analyst = parseEnv(fs.readFileSync(path.join(output, 'analyst.env'), 'utf8'))
  assert.equal(analyst.STAFF_TENCENTCLOUD_SECRETKEY, undefined)
  fs.rmSync(temp, { recursive: true, force: true })
})

test('remote compose overrides base env_file and environment per service', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-deploy-compose-'))
  const source = path.join(temp, 'prod.env')
  fs.writeFileSync(source, renderEnv(validConfig('prod')), { mode: 0o600 })
  renderBundle('prod', temp, { file: source })
  fs.copyFileSync(path.join(ROOT, 'docker/docker-compose.yml'), path.join(temp, 'docker-compose.yml'))
  fs.copyFileSync(path.join(ROOT, 'docker/docker-compose.remote.yml'), path.join(temp, 'docker-compose.remote.yml'))
  fs.writeFileSync(path.join(temp, 'compose.env'), [
    'ADMIN_IMAGE=fengyu-admin:test-immutable',
    'ANALYST_IMAGE=fengyu-analyst:test-immutable',
    `ADMIN_ENV_FILE=${path.join(temp, 'admin.env')}`,
    `CRON_ENV_FILE=${path.join(temp, 'cron-worker.env')}`,
    `EXPORT_ENV_FILE=${path.join(temp, 'export-worker.env')}`,
    `ANALYST_ENV_FILE=${path.join(temp, 'analyst.env')}`,
    '',
  ].join('\n'), { mode: 0o600 })

  const result = spawnSync('docker', [
    'compose',
    '--project-directory', ROOT,
    '--env-file', path.join(temp, 'compose.env'),
    '-f', path.join(temp, 'docker-compose.yml'),
    '-f', path.join(temp, 'docker-compose.remote.yml'),
    'config',
    '--format', 'json',
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const compose = JSON.parse(result.stdout)
  assert.equal(compose.services.admin.image, 'fengyu-admin:test-immutable')
  assert.equal(compose.services.admin.environment.DATABASE_URL.includes(TARGETS.prod.containerDbHost), true)
  assert.equal(compose.services.admin.environment.POSTGRES_USER, undefined)
  assert.equal(compose.services.analyst.environment.LAKALA_PRIVATE_KEY_PEM, undefined)
  assert.equal(compose.services['export-worker'].environment.RSA_PRIVATE_KEY, undefined)
  fs.rmSync(temp, { recursive: true, force: true })
})

test('migration analysis follows latest created_at and hash instead of row count', () => {
  const entries = [
    { tag: '0000_a', when: 100 },
    { tag: '0001_b', when: 200 },
    { tag: '0002_c', when: 300 },
  ]
  const hashes = new Map([['0000_a', 'a'], ['0001_b', 'b'], ['0002_c', 'c']])
  const pending = analyzeMigrationState(entries, [{ hash: 'b', created_at: '200' }], hashes)
  assert.deepEqual(pending.pending, ['0002_c'])
  assert.equal(pending.ok, false)

  const currentWithHistoricalExtra = analyzeMigrationState(entries, [
    { hash: 'a', created_at: '100' },
    { hash: 'legacy', created_at: '150' },
    { hash: 'b', created_at: '200' },
    { hash: 'c', created_at: '300' },
  ], hashes)
  assert.equal(currentWithHistoricalExtra.ok, true)
  assert.equal(currentWithHistoricalExtra.latestTag, '0002_c')
  assert.equal(currentWithHistoricalExtra.historicalRowDelta, 1)
})
