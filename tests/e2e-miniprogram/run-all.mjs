// run-all.mjs — 顺序跑全部 smoke 测试
//
// 跑法：bun tests/e2e-miniprogram/run-all.mjs
// 退出码：任一 smoke 失败即 1，全部通过为 0。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SMOKES = [
  // 顺序：先跑不依赖远端配置的，再跑需要 ALLOW_TEST_OPENID 的
  { name: 'smoke-client-home', requiresTestOpenid: false },
  { name: 'smoke-staff-confirm-offline', requiresTestOpenid: true },
];

function runOne(name) {
  return new Promise((resolve) => {
    const file = path.join(__dirname, `${name}.mjs`);
    const child = spawn(process.execPath, [file], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function main() {
  const results = [];
  for (const s of SMOKES) {
    console.log(`\n========== RUN ${s.name} ==========`);
    const ok = await runOne(s.name);
    results.push({ ...s, ok });
    if (!ok && s.requiresTestOpenid) {
      console.warn(`[run-all] ${s.name} 失败 — 可能是远端 ALLOW_TEST_OPENID 未开启，继续后续`);
    } else if (!ok) {
      console.error(`[run-all] ${s.name} 失败，停止后续`);
      break;
    }
  }

  console.log('\n========== SUMMARY ==========');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.requiresTestOpenid ? '  (requires ALLOW_TEST_OPENID)' : ''}`);
  }
  const anyFail = results.some(r => !r.ok);
  process.exit(anyFail ? 1 : 0);
}

main();
