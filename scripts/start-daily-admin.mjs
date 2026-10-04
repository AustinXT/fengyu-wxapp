import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants, publicEncrypt, privateDecrypt } from 'node:crypto';
import { ROOT, devConnection } from './daily-dev-config.mjs';
const cwd = path.join(ROOT, 'fengyu-admin');
const baseFile = path.join(cwd, '.env.local');
const base = fs.existsSync(baseFile) ? parseEnv(fs.readFileSync(baseFile, 'utf8')) : {};
const daily = parseEnv(fs.readFileSync(path.join(ROOT, 'envs/daily.env'), 'utf8'));
const connection = devConnection();
const env = { ...process.env, ...base, ...daily, DATABASE_URL: connection, DAILY_ISOLATED: '1', PORT: '3010' };
delete env.E2E_DATABASE_URL;
if (!env.NEXT_PUBLIC_RSA_PUBLIC_KEY || !env.RSA_PRIVATE_KEY) {
  throw Error('日报后台缺少登录密码加密配置，请在 envs/daily.env 配置 NEXT_PUBLIC_RSA_PUBLIC_KEY 和 RSA_PRIVATE_KEY');
}
try {
  const probe = Buffer.from('daily-login-config-check');
  const encrypted = publicEncrypt({ key: Buffer.from(env.NEXT_PUBLIC_RSA_PUBLIC_KEY, 'base64'), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, probe);
  const decrypted = privateDecrypt({ key: Buffer.from(env.RSA_PRIVATE_KEY, 'base64'), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, encrypted);
  if (!decrypted.equals(probe)) throw Error('mismatch');
} catch {
  throw Error('日报后台登录加密密钥无效或不配对，请检查 envs/daily.env');
}
const require = createRequire(path.join(ROOT, 'db/package.json'));
const { Client } = require('pg');
const client = new Client({ connectionString: connection, connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  const { rows: [row] } = await client.query("SELECT current_database() AS name, (SELECT count(*) FROM information_schema.columns WHERE table_name='daily_operating_targets' AND column_name IN ('visits','new_customers','projects','counts_month_confirmed')) AS columns");
  if (row.name !== 'fengyu_daily_dev' || Number(row.columns) !== 4) throw Error('日报库身份或五项目标结构不匹配，拒绝启动');
} finally { await client.end(); }
console.log('日报独立调试：localhost:3010 → 101.34.242.103:8151/fengyu_daily_dev；仅启动后台，不启动 worker');
const child = spawn('npm', ['run', 'dev', '--', '--port', '3010', '--hostname', 'localhost'], { cwd, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });
