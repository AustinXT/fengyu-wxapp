// run-all.mjs — 顺序跑全部 smoke 测试
//
// 跑法：bun tests/e2e-miniprogram/run-all.mjs
// 退出码：任一 smoke 失败即 1，全部通过为 0。
//
// **重要限制（IDE 单窗口约束）**：
//
// 微信开发者工具单窗口只能装载一个项目；不同 smoke 要求装载不同项目：
//   - smoke-client-* → fengyu-client/miniprogram
//   - smoke-staff-*  → fengyu-staff/miniprogram
//
// IDE 的 automation ws server 还需要满足：
//   1. IDE HTTP server 绑定到 9420（cli auto --port 9420 或"设置→安全→服务端口"）
//   2. IDE 已经把 ws server 在 IPv6 [::1]:9420 上 listen 起来（实测不稳定，
//      可能需要 cli auto 多次或在 IDE 中操作几下才会建）
//
// 由于切换 IDE 项目 + 等 ws ready 在 macOS 上不稳定，**run-all 默认不做自动
// 切换**——只在跑前 probe IDE 当前装的是哪个项目，匹配 smoke 才跑。
// 不匹配的 smoke 标 SKIP，提示用户用 IDE CLI 切换：
//
//   /Applications/wechatwebdevtools.app/Contents/MacOS/cli auto \
//     --project /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/miniprogram \
//     --port 9420
//
// （切完等 15~30s 让 IDE 把 ws 起来，然后再跑 run-all）
//
// 想跑全套的最稳姿势：
//   1. cli auto staff → bun run-all（staff smoke 跑，client smoke skip）
//   2. cli auto client → bun run-all（client smoke 跑，staff smoke skip）

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import automator from 'miniprogram-automator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTOMATOR_PORT = 9420;

const SMOKES = [
  {
    name: 'smoke-client-home',
    requiresTestOpenid: false,
    expectAppId: 'wx811eb4ded3dfba3f',
    label: 'client',
  },
  {
    name: 'smoke-staff-confirm-offline',
    requiresTestOpenid: true,
    expectAppId: 'wxe3f5d9ee6a94d22d',
    label: 'staff',
  },
];

function runOne(name) {
  return new Promise((resolve) => {
    const file = path.join(__dirname, `${name}.mjs`);
    const child = spawn(process.execPath, [file], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
  });
}

/**
 * 探测 IDE 当前装的是哪个项目（通过 automator.connect + evaluate 拿 appId）
 */
async function detectIdeAppId() {
  for (const host of ['localhost', '[::1]', '127.0.0.1']) {
    try {
      const mp = await automator.connect({ wsEndpoint: `ws://${host}:${AUTOMATOR_PORT}` });
      const appId = await mp.evaluate(() => getApp()?.globalData?.appId || wx.getAccountInfoSync?.()?.miniProgram?.appId);
      await mp.disconnect();
      return appId;
    } catch (e) {
      // try next host
    }
  }
  return null;
}

async function main() {
  console.log('[run-all] probe IDE current project...');
  const currentAppId = await detectIdeAppId();
  if (!currentAppId) {
    console.error('[run-all] 无法连接 IDE automation (ws://localhost:9420)。请先：');
    console.error('  1. 打开微信开发者工具');
    console.error('  2. 装载小程序项目');
    console.error('  3. 在 "设置→安全→服务端口" 启用 9420（或用 cli auto --port 9420）');
    console.error('  4. 等 15~30s 让 IDE 的 ws server 起来');
    process.exit(1);
  }
  console.log(`[run-all] IDE current appId = ${currentAppId}`);

  const results = [];
  for (const s of SMOKES) {
    console.log(`\n========== ${s.name} ==========`);
    if (s.expectAppId !== currentAppId) {
      console.log(`[run-all] SKIP — IDE 当前装的是 ${currentAppId}，需要 ${s.expectAppId} (${s.label})`);
      results.push({ ...s, ok: null, skipped: true });
      continue;
    }

    const ok = await runOne(s.name);
    results.push({ ...s, ok });
    if (!ok && s.requiresTestOpenid) {
      console.warn(`[run-all] ${s.name} 失败 — 可能远端 ALLOW_TEST_OPENID 未开启`);
    }
  }

  console.log('\n========== SUMMARY ==========');
  for (const r of results) {
    const tag = r.skipped ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL');
    console.log(`  ${tag}  ${r.name}${r.requiresTestOpenid ? '  (requires ALLOW_TEST_OPENID)' : ''}`);
  }
  console.log(`\n如有 SKIP：用以下命令切换 IDE 项目后再跑：`);
  console.log(`  /Applications/wechatwebdevtools.app/Contents/MacOS/cli auto \\`);
  console.log(`    --project <PROJECT_PATH> --port 9420`);
  console.log(`  # 等 ~20s，然后 bun tests/e2e-miniprogram/run-all.mjs`);

  const anyFail = results.some(r => r.ok === false);
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error('[run-all] fatal:', e);
  process.exit(1);
});
