// run-scenarios.mjs — 业务场景 E2E 独立入口
//
// 用法：
//   bun fengyu-staff/tests/e2e-miniprogram/run-scenarios.mjs
//   bun fengyu-staff/tests/e2e-miniprogram/run-scenarios.mjs --filter bs01
//   bun fengyu-staff/tests/e2e-miniprogram/run-scenarios.mjs --bail   # 任一失败立即停
//
// 设计：
// - 自动发现 scenarios/bs*.spec.mjs
// - probe IDE 当前 appId，若非 staff 则 SKIP（用 run-staff-l3.sh 一键脚本自动切）
// - 每个 spec 独立 spawn bun 子进程，失败 log 写 test-results/
// - 与 run-all.mjs 平行，但只跑 scenarios/，不跑 smoke-*

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import automator from 'miniprogram-automator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const STAFF_APPID = 'wxe3f5d9ee6a94d22d';
const PORT = 9420;

const args = process.argv.slice(2);
const bail = args.includes('--bail');
const filterIdx = args.indexOf('--filter');
const filters = filterIdx >= 0 && args[filterIdx + 1]
  ? args[filterIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
  : [];

if (!fs.existsSync(SCENARIOS_DIR)) {
  console.error(`[run-scenarios] scenarios/ 目录不存在: ${SCENARIOS_DIR}`);
  process.exit(2);
}

const allSpecs = fs.readdirSync(SCENARIOS_DIR)
  .filter(f => /\.spec\.mjs$/.test(f))
  .sort();

const specs = filters.length === 0
  ? allSpecs
  : allSpecs.filter(s => filters.some(f => s.includes(f)));

if (specs.length === 0) {
  console.error(`[run-scenarios] 无匹配 spec。filters=${JSON.stringify(filters)}`);
  process.exit(1);
}

// IDE appId probe
async function probeAppId() {
  for (const host of ['localhost', '[::1]', '127.0.0.1']) {
    try {
      const mp = await automator.connect({ wsEndpoint: `ws://${host}:${PORT}` });
      const appId = await mp.evaluate(() => getApp()?.globalData?.appId || wx.getAccountInfoSync?.()?.miniProgram?.appId);
      await mp.disconnect();
      return appId;
    } catch (e) { /* try next */ }
  }
  return null;
}

console.log('[run-scenarios] probe IDE...');
const currentAppId = await probeAppId();
if (!currentAppId) {
  console.error('[run-scenarios] 无法连接 IDE automation (ws://localhost:9420)。');
  console.error('  请先用 ./fengyu-staff/tests/run-staff-l3.sh 一键脚本（自动切 IDE）');
  process.exit(2);
}
console.log(`[run-scenarios] IDE appId = ${currentAppId}`);

if (currentAppId !== STAFF_APPID) {
  console.error(`[run-scenarios] IDE 当前装的是 ${currentAppId}，需要 staff (${STAFF_APPID})`);
  console.error('  请用 ./fengyu-staff/tests/run-staff-l3.sh 一键脚本切换');
  process.exit(2);
}

// 失败 log 目录
const resultsDir = path.join(__dirname, 'test-results');
fs.mkdirSync(resultsDir, { recursive: true });

const PER_SPEC_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟硬上限，防 finally(disconnect/closePool) 死锁
function run(spec) {
  return new Promise((resolve) => {
    const start = Date.now();
    const buf = [];
    const child = spawn(process.execPath, [path.join(SCENARIOS_DIR, spec)], {
      env: process.env,
    });
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      buf.push(`\n[run-scenarios] ⏰ ${spec} 超出 ${PER_SPEC_TIMEOUT_MS / 1000}s，SIGKILL 子进程\n`);
      process.stderr.write(`\n[run-scenarios] ⏰ TIMEOUT ${spec} → SIGKILL\n`);
      try { child.kill('SIGKILL'); } catch {}
    }, PER_SPEC_TIMEOUT_MS);
    child.stdout.on('data', d => { process.stdout.write(d); buf.push(d.toString()); });
    child.stderr.on('data', d => { process.stderr.write(d); buf.push(d.toString()); });
    child.on('exit', (code) => {
      clearTimeout(watchdog);
      const out = buf.join('');
      const finalCode = timedOut ? 124 : (code ?? 1);
      let logPath = null;
      if (finalCode !== 0) {
        logPath = path.join(resultsDir, spec.replace(/\.spec\.mjs$/, '.scenario.log'));
        fs.writeFileSync(logPath, out.split('\n').slice(-80).join('\n'));
      }
      resolve({ spec, code: finalCode, elapsedMs: Date.now() - start, logPath, timedOut });
    });
  });
}

const results = [];
for (let i = 0; i < specs.length; i++) {
  const s = specs[i];
  console.log(`\n========== ${s} ==========`);
  const r = await run(s);
  results.push(r);
  if (bail && r.code !== 0) {
    console.error(`\n[run-scenarios] --bail 触发，跳过剩余 ${specs.length - i - 1} 个 spec`);
    break;
  }
  if (i < specs.length - 1) await new Promise(r => setTimeout(r, 1500));
}

console.log('\n========== SUMMARY ==========');
let passed = 0, failed = 0;
for (const r of results) {
  const tag = r.code === 0 ? 'PASS' : 'FAIL';
  console.log(`  ${tag}  ${r.spec.padEnd(38)} ${(r.elapsedMs / 1000).toFixed(2)}s`);
  if (r.code === 0) passed++; else failed++;
}
console.log(
  `\n${failed === 0 ? '✅ ALL PASS' : `❌ ${failed} FAILED`} | ${passed} pass / ${results.length} ran / ${specs.length} total | ` +
  `${(results.reduce((s, r) => s + r.elapsedMs, 0) / 1000).toFixed(1)}s`
);

if (failed > 0) {
  console.log(`\n失败日志（末尾 80 行）：`);
  for (const r of results.filter(r => r.code !== 0)) {
    console.log(`  ${r.spec} → ${r.logPath}`);
  }
  console.log(`\n截图：fengyu-staff/tests/e2e-miniprogram/test-results/screenshots/`);
}

process.exit(failed === 0 ? 0 : 1);
