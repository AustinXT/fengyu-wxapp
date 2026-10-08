import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, devConnection } from './daily-dev-config.mjs';

const source = new URL(devConnection());
if (source.username !== 'daily_app') throw Error('日报临时库测试要求 daily_app 账号');
const name = 'daily_regression_' + randomUUID().replaceAll('-', '').slice(0, 24);
const databaseEnv = {
  ...process.env,
  PGHOST: source.hostname, PGPORT: source.port,
  PGUSER: decodeURIComponent(source.username), PGPASSWORD: decodeURIComponent(source.password),
  PGDATABASE: source.pathname.slice(1), PGCONNECT_TIMEOUT: '10',
};
function run(command, args, env = process.env, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    // 不转发可能包含连接信息的工具错误输出。
    let diagnostics = '';
    child.stderr.on('data', chunk => { if (command === process.execPath) diagnostics += chunk; });
    child.on('error', () => reject(Error(`${command} 无法启动`)));
    child.on('close', code => {
      if (code === 0) resolve(output);
      else {
        if (command === process.execPath) console.log((output + diagnostics).replace(/postgres(?:ql)?:\/\/[^\s'"]+/g, '[数据库连接已隐藏]').replaceAll(decodeURIComponent(source.password), '[密码已隐藏]'));
        reject(Error(`${command} 失败，退出码 ${code}`));
      }
    });
  });
}
const adminSql = sql => run('ssh', ['-o', 'BatchMode=yes', 'lx-test',
  `sudo -n docker exec fengyu-daily-postgres psql -v ON_ERROR_STOP=1 -U daily_owner -d fengyu_daily_dev -c '${sql}'`]);
async function copyStructure() {
  // 使用服务器同版本 pg_dump，避免本机新版导出不兼容的会话参数。
  const dump = spawn('ssh', ['-o', 'BatchMode=yes', 'lx-test',
    'sudo -n docker exec fengyu-daily-postgres pg_dump -U daily_owner -d fengyu_daily_dev --schema-only --no-owner --no-acl'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  const restore = spawn('psql', ['-v', 'ON_ERROR_STOP=1', '--single-transaction'], {
    env: { ...databaseEnv, PGDATABASE: name }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  dump.stderr.resume();
  let restoreError = '';
  restore.stderr.on('data', chunk => { restoreError += chunk; });
  const finished = child => new Promise((resolve, reject) => {
    child.on('error', () => reject(Error('复制数据库结构的工具无法启动')));
    child.on('close', code => code === 0 ? resolve() : reject(Error(`复制数据库结构失败，退出码 ${code}：${restoreError.slice(-1200)}`)));
  });
  // 只传输表结构，不复制任何员工、订单、日报或绑定数据。
  dump.stdout.pipe(restore.stdin);
  restore.stdin.on('error', () => {});
  await Promise.all([finished(dump), finished(restore)]);
}
let created = false;
try {
  await adminSql(`CREATE DATABASE ${name} OWNER daily_app`);
  created = true;
  console.log(`临时库已创建：${name}；从日报开发库复制结构`);
  await copyStructure();
  if (process.argv.includes('--cycle-full')) {
    await run('psql', ['-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', path.join(ROOT, 'db/rollout/requests/daily-cycle-full.sql')], { ...databaseEnv, PGDATABASE: name })
    console.log('完整周期候选约束已应用到独立临时库')
  }
  const target = new URL(source); target.pathname = '/' + name;
  const tests = (process.argv.includes('--calendar') ? ['calendar-auto.pg.test.js'] : ['integration.test.js', 'targets.pg.test.js', 'five-targets.pg.test.js'])
    .map(file => path.join(ROOT, 'fengyu-daily/cloudfunctions/dailyApi/tests', file));
  const admin = process.argv.includes('--admin') || process.argv.includes('--admin-auto');
  const args = admin ? [path.join(ROOT, 'fengyu-admin/node_modules/vitest/vitest.mjs'), 'run', process.argv.includes('--admin-auto') ? 'src/actions/daily-calendar-save.pg.test.ts' : 'src/actions/daily-config.pg.test.ts'] : ['--test', '--test-concurrency=1', ...tests];
  const output = await run(process.execPath, args, {
    ...process.env, DAILY_CYCLE_FULL: process.argv.includes('--cycle-full') ? '1' : '0', DAILY_ISOLATED: '0', DAILY_TEST_DATABASE_URL: target.toString(), DAILY_TEST_TEMP_DB: name,
  }, admin ? path.join(ROOT, 'fengyu-admin') : ROOT);
  console.log(output);
} finally {
  if (created) {
    await adminSql(`DROP DATABASE ${name} WITH (FORCE)`);
    console.log(`临时库已删除：${name}`);
  }
}
