// helpers/screenshot.mjs — 截图收集（H4）
//
// 写到 tests/e2e-miniprogram/test-results/screenshots/<scenario>-<step>-<ts>.png
// 失败时把最近 3 张路径打到 stderr 便于回放。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'test-results', 'screenshots');

let _recentSnapshots = [];

export async function snapshot(miniProgram, label = 'unnamed') {
  if (!miniProgram) return null;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  const file = path.join(SCREENSHOT_DIR, `${safeLabel}-${Date.now()}.png`);
  try {
    if (typeof miniProgram.screenshot === 'function') {
      await miniProgram.screenshot({ path: file, fullPage: true });
    } else {
      // automator <0.10 没 screenshot API；fallback page.callMethod
      const page = await miniProgram.currentPage();
      if (typeof page.screenshot === 'function') {
        await page.screenshot({ path: file });
      } else {
        return null;
      }
    }
    _recentSnapshots.push(file);
    if (_recentSnapshots.length > 10) _recentSnapshots.shift();
    return file;
  } catch (e) {
    console.warn(`[snapshot] ${label} 失败：${e.message}`);
    return null;
  }
}

/**
 * 失败时打印最近 N 张截图路径。
 */
export function dumpRecentSnapshots(n = 3) {
  if (_recentSnapshots.length === 0) return;
  console.error(`[L3 E2E] 最近 ${Math.min(n, _recentSnapshots.length)} 张截图：`);
  for (const f of _recentSnapshots.slice(-n)) {
    console.error(`  ${f}`);
  }
}

/**
 * 清空 recent 列表（每个 scenario 起始调用）。
 */
export function resetSnapshots() {
  _recentSnapshots = [];
}
