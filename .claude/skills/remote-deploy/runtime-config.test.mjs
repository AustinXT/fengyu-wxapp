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
  KNOWN_PROD_HISTORICAL_MIGRATION_ROWS,
  analyzeMigrationState,
  buildServiceEnvs,
  encodeEnvValue,
  parseEnv,
  reconcileLegacyConfigFiles,
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
    CLOUDBASE_ENV_ID: target.cloudBaseEnvId,
    CDN_BASE: target.cdnBase,
    TENCENTCLOUD_SECRETID: 'client-id',
    TENCENTCLOUD_SECRETKEY: 'client-key',
    STAFF_ENV_ID: target.staffEnvId,
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
    MSSQL_CONNECTION_STRING: 'Server=workfine.example.com;Database=workfine;User Id=readonly;Password=secret',
  }
}

test('env parser preserves quoted multiline values and rejects duplicate keys', () => {
  assert.deepEqual(parseEnv('A="line1\\nline2"\nB=value\n'), { A: 'line1\nline2', B: 'value' })
  assert.throws(() => parseEnv('A=1\nA=2\n'), /duplicate environment key/)
})

test('env parser rejects unterminated quoted values with the opening line number', () => {
  assert.throws(
    () => parseEnv('# c\nA=1\nB="broken\n'),
    (error) => /never closed|unterminated/.test(error.message) && /line 3/.test(error.message),
  )
  assert.throws(
    () => parseEnv('A="value\nB=other\n'),
    (error) => /never closed|unterminated/.test(error.message) && /line 1/.test(error.message),
  )
})

test('env quoted values preserve backslashes through encode and parse', () => {
  const tricky = ['a\\nb', '\\\\', '\\"', '$'].join('|')
  assert.equal(parseEnv(`A=${encodeEnvValue(tricky)}\n`).A, tricky)
  assert.equal(parseEnv('A="x\\\\ny"\n').A, 'x\\ny')
})

test('env parser distinguishes escaped quotes from literal backslashes before closing quotes', () => {
  const unterminated = String.raw`A="tail\"` + '\nB=next\n'
  const closed = String.raw`A="ok\\"` + '\nB=1\n'
  assert.throws(() => parseEnv(unterminated), /never closed|unterminated/)
  assert.deepEqual(parseEnv(closed), { A: 'ok\\', B: '1' })
})

test('compose env rendering escapes dollar signs without changing source env encoding', () => {
  assert.equal(renderEnv({ A: 'pa$$word' }), 'A=pa$$$$word\n')
  assert.equal(renderEnv({ A: 'x$y"z' }), 'A="x$$y\\"z"\n')
  assert.equal(renderEnv({ B: 'plain' }), 'B=plain\n')
  assert.equal(encodeEnvValue('pa$$word'), 'pa$$word')
})

test('all fixed environment targets validate and RSA mismatch fails closed', () => {
  for (const env of Object.keys(TARGETS)) assert.equal(validateConfig(env, validConfig(env)), TARGETS[env])
  const config = validConfig('prod')
  config.NEXT_PUBLIC_RSA_PUBLIC_KEY = validConfig('prod').NEXT_PUBLIC_RSA_PUBLIC_KEY
  assert.throws(() => validateConfig('prod', config), /do not match/)
})

test('cloudbase identity keys must belong to the target environment', () => {
  const cases = [
    ['CLOUDBASE_ENV_ID', 'cloudBaseEnvId'],
    ['STAFF_ENV_ID', 'staffEnvId'],
    ['CDN_BASE', 'cdnBase'],
  ]
  for (const [key, field] of cases) {
    const config = validConfig('dev')
    config[key] = TARGETS.prod[field]
    assert.throws(() => validateConfig('dev', config), /does not belong/)
  }
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

test('shell deploy provenance fingerprints dirty worktrees instead of rejecting them', () => {
  const common = path.join(ROOT, '.claude/skills/remote-deploy/deploy-common.sh')
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-deploy-dirty-'))
  const runGit = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  runGit('init', '-q')
  runGit('config', 'user.email', 'test@example.com')
  runGit('config', 'user.name', 'Remote Deploy Test')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  runGit('add', 'tracked.txt')
  runGit('commit', '-qm', 'base')

  const capture = () => spawnSync('bash', ['-c', [
    'set -euo pipefail',
    'source "$1"',
    'REPO_ROOT="$2"',
    'capture_worktree_provenance',
    'printf "%s|%s" "$WORKTREE_STATE" "$WORKTREE_FINGERPRINT"',
  ].join('\n'), 'bash', common, repo], { encoding: 'utf8' })

  const clean = capture()
  assert.equal(clean.status, 0, clean.stderr)
  assert.equal(clean.stdout, 'clean|clean')

  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n')
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'one\n')
  const dirty = capture()
  assert.equal(dirty.status, 0, dirty.stderr)
  assert.match(dirty.stdout, /^dirty\|[0-9a-f]{12}$/)
  assert.match(dirty.stderr, /WARNING: deploying a dirty worktree as dirty\.[0-9a-f]{12}/)

  const sameDirty = capture()
  assert.equal(sameDirty.stdout, dirty.stdout)
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'two\n')
  const changedDirty = capture()
  assert.notEqual(changedDirty.stdout, dirty.stdout)
})

test('service environment rendering enforces isolation', () => {
  const services = buildServiceEnvs(validConfig('prod'))
  assert.equal(services.admin.STAFF_TENCENTCLOUD_SECRETID, 'staff-id')
  assert.equal(services.admin.NEXT_PUBLIC_ANALYST_ORIGIN, 'https://analyst.example.com')
  assert.equal(services.admin.MSSQL_CONNECTION_STRING.includes('workfine.example.com'), true)
  assert.equal(services['cron-worker'].LAKALA_APPID, 'OP12345678')
  assert.equal(services['cron-worker'].MSSQL_CONNECTION_STRING, undefined)
  assert.equal(services['export-worker'].RSA_PRIVATE_KEY, undefined)
  assert.equal(services.analyst.STAFF_TENCENTCLOUD_SECRETID, undefined)
  assert.equal(services.analyst.LAKALA_PRIVATE_KEY_PEM, undefined)
  assert.equal(services.analyst.MSSQL_CONNECTION_STRING, undefined)
})

test('legacy reconcile migrates all real env files before the strict gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-deploy-reconcile-'))
  const envDir = path.join(root, 'envs')
  const staffDir = path.join(root, 'fengyu-staff')
  fs.mkdirSync(envDir, { recursive: true })
  fs.mkdirSync(staffDir, { recursive: true })

  const dev = validConfig('dev')
  const testConfig = validConfig('test')
  const prod = validConfig('prod')
  dev.STAFF_TENCENTCLOUD_SECRETID = ''
  dev.STAFF_TENCENTCLOUD_SECRETKEY = ''
  testConfig.STAFF_TENCENTCLOUD_SECRETID = ''
  testConfig.STAFF_TENCENTCLOUD_SECRETKEY = ''
  prod.STAFF_TENCENTCLOUD_SECRETID = 'prod-staff-id'
  prod.STAFF_TENCENTCLOUD_SECRETKEY = 'prod-staff-key'
  prod.COOKIE_DOMAIN = ''

  fs.writeFileSync(path.join(envDir, 'dev.env.example'), renderEnv(validConfig('dev')))
  fs.writeFileSync(path.join(envDir, 'prod.env.example'), renderEnv(validConfig('prod')))
  for (const [env, config] of [['dev', dev], ['test', testConfig], ['prod', prod]]) {
    fs.writeFileSync(path.join(envDir, `${env}.env`), renderEnv(config), { mode: 0o644 })
  }
  fs.writeFileSync(path.join(staffDir, '.env'), 'TENCENTCLOUD_SECRETID=legacy-staff-id\nTENCENTCLOUD_SECRETKEY=legacy-staff-key\n')

  reconcileLegacyConfigFiles({ root })

  const migratedDev = parseEnv(fs.readFileSync(path.join(envDir, 'dev.env'), 'utf8'))
  const migratedTest = parseEnv(fs.readFileSync(path.join(envDir, 'test.env'), 'utf8'))
  const migratedProd = parseEnv(fs.readFileSync(path.join(envDir, 'prod.env'), 'utf8'))
  assert.equal(migratedDev.STAFF_TENCENTCLOUD_SECRETID, 'legacy-staff-id')
  assert.equal(migratedTest.STAFF_TENCENTCLOUD_SECRETID, 'prod-staff-id')
  assert.equal(migratedTest.COOKIE_DOMAIN, '')
  assert.equal(migratedProd.COOKIE_DOMAIN, '.example.com')
  for (const env of ['dev', 'test', 'prod']) {
    assert.equal(fs.statSync(path.join(envDir, `${env}.env`)).mode & 0o777, 0o600)
  }
  const firstPass = fs.readFileSync(path.join(envDir, 'prod.env'), 'utf8')
  reconcileLegacyConfigFiles({ root })
  assert.equal(fs.readFileSync(path.join(envDir, 'prod.env'), 'utf8'), firstPass)
  fs.rmSync(root, { recursive: true, force: true })
})

test('legacy reconcile preserves dollar signs in source env files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-deploy-reconcile-dollar-'))
  const envDir = path.join(root, 'envs')
  const staffDir = path.join(root, 'fengyu-staff')
  fs.mkdirSync(envDir, { recursive: true })
  fs.mkdirSync(staffDir, { recursive: true })

  const dev = validConfig('dev')
  const testConfig = validConfig('test')
  const prod = validConfig('prod')
  for (const config of [dev, testConfig, prod]) config.ADMIN_JWT_SECRET = 'jwt-$ecret$'
  dev.STAFF_TENCENTCLOUD_SECRETID = ''
  dev.STAFF_TENCENTCLOUD_SECRETKEY = ''
  testConfig.STAFF_TENCENTCLOUD_SECRETID = ''
  testConfig.STAFF_TENCENTCLOUD_SECRETKEY = ''
  prod.STAFF_TENCENTCLOUD_SECRETID = 'prod-staff-id'
  prod.STAFF_TENCENTCLOUD_SECRETKEY = 'prod-staff-key'
  prod.COOKIE_DOMAIN = ''

  const renderRawEnv = (values) => `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`
  fs.writeFileSync(path.join(envDir, 'dev.env.example'), renderEnv(validConfig('dev')))
  fs.writeFileSync(path.join(envDir, 'prod.env.example'), renderEnv(validConfig('prod')))
  for (const [env, config] of [['dev', dev], ['test', testConfig], ['prod', prod]]) {
    fs.writeFileSync(path.join(envDir, `${env}.env`), renderRawEnv(config), { mode: 0o644 })
  }
  fs.writeFileSync(path.join(staffDir, '.env'), 'TENCENTCLOUD_SECRETID=legacy-staff-id\nTENCENTCLOUD_SECRETKEY=legacy-staff-key\n')

  reconcileLegacyConfigFiles({ root })

  for (const env of ['dev', 'test', 'prod']) {
    const text = fs.readFileSync(path.join(envDir, `${env}.env`), 'utf8')
    assert.equal(text.includes('$$'), false)
    assert.equal(parseEnv(text).ADMIN_JWT_SECRET, 'jwt-$ecret$')
  }
  fs.rmSync(root, { recursive: true, force: true })
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

test('remote compose overrides base env_file and environment per service', (t) => {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    const reason = probe.error?.message || probe.stderr.trim() || `exit status ${probe.status}`
    t.skip(`docker is not available: ${reason}`)
    return
  }
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
  assert.equal(currentWithHistoricalExtra.ok, false)
  assert.match(currentWithHistoricalExtra.reason, /local journal is missing/)
  assert.equal(currentWithHistoricalExtra.latestTag, '0002_c')
  assert.equal(currentWithHistoricalExtra.historicalRowDelta, 1)

  const knownProdHistorical = KNOWN_PROD_HISTORICAL_MIGRATION_ROWS[0]
  const currentWithKnownProdHistorical = analyzeMigrationState(entries, [
    { hash: 'a', created_at: '100' },
    knownProdHistorical,
    { hash: 'b', created_at: '200' },
    { hash: 'c', created_at: '300' },
  ], hashes, { knownHistoricalRows: KNOWN_PROD_HISTORICAL_MIGRATION_ROWS })
  assert.equal(currentWithKnownProdHistorical.ok, true)
  assert.equal(currentWithKnownProdHistorical.latestTag, '0002_c')
  assert.equal(currentWithKnownProdHistorical.historicalRowDelta, 0)
  assert.equal(currentWithKnownProdHistorical.ignoredHistoricalRowCount, 1)

  const currentWithHistoricalGap = analyzeMigrationState(entries, [
    { hash: 'c', created_at: '300' },
  ], hashes)
  assert.equal(currentWithHistoricalGap.ok, false)
  assert.match(currentWithHistoricalGap.reason, /remote journal is missing/)
  assert.equal(currentWithHistoricalGap.historicalRowDelta, -2)
})
