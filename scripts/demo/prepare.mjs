import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const secretFile = resolve(root, 'envs/demo.env')
if (!existsSync(secretFile)) {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  const config = {
    DEMO_DB_PASSWORD: randomBytes(32).toString('hex'),
    JWT_SECRET: randomBytes(48).toString('hex'),
    RSA_PRIVATE_KEY: Buffer.from(pair.privateKey).toString('base64'),
    NEXT_PUBLIC_RSA_PUBLIC_KEY: Buffer.from(pair.publicKey).toString('base64'),
    DEMO_LOGIN_PHONE: '19900000001',
    DEMO_LOGIN_PASSWORD: `LXdemo-${randomBytes(6).toString('hex')}`,
  }
  writeFileSync(secretFile, Object.entries(config).map(([k,v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 })
}
chmodSync(secretFile, 0o600)
const config = Object.fromEntries(readFileSync(secretFile, 'utf8').trim().split('\n').map(line => {
  const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]
}))
const dir = resolve(root, '.tmp/lxcoding-demo-release')
mkdirSync(dir, { recursive: true, mode: 0o700 })
function envFile(name, values) {
  writeFileSync(resolve(dir, name), Object.entries(values).map(([k,v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 })
}
const revision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
if (status) throw Error('部署前请提交演示环境修改，镜像必须对应可追踪的提交')
envFile('compose.env', { DEMO_IMAGE: `lxcoding-demo:${revision}` })
envFile('postgres.env', { POSTGRES_USER: 'lxcoding_demo', POSTGRES_DB: 'lxcoding_demo', POSTGRES_PASSWORD: config.DEMO_DB_PASSWORD, TZ: 'Asia/Shanghai' })
envFile('admin.env', {
  DEMO_MODE: '1', ENV_PROFILE: 'demo', NODE_ENV: 'production', TZ: 'Asia/Shanghai',
  DATABASE_URL: `postgresql://lxcoding_demo:${config.DEMO_DB_PASSWORD}@demo-postgres:5432/lxcoding_demo`,
  JWT_SECRET: config.JWT_SECRET, RSA_PRIVATE_KEY: config.RSA_PRIVATE_KEY,
  DEMO_PUBLIC_ORIGIN: 'http://101.34.242.103:8094', DEMO_UPLOAD_DIR: '/var/lib/lxcoding/uploads',
  COOKIE_SECURE: 'false', LAKALA_CLIENT_MODE: 'mock', LAKALA_ENV: 'test', ALIYUN_OCR_MODE: 'mock',
  SYSTEM_RUNTIME_DIR: '/var/lib/lxcoding/runtime', PRIVATE_UPLOAD_DIR: '/var/lib/lxcoding/private-uploads',
  CDN_BASE: 'http://101.34.242.103:8094',
})
console.log(`已准备演示配置：${revision}，秘密未输出`)
