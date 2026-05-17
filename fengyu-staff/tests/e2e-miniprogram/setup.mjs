// setup.mjs — 全局预检（独立可跑）
// 用途：在跑任何 smoke 前确认环境就绪（IDE 端口 + PG 可连）

import { ensureIdeReady } from './helpers/automator.mjs';
import { query, closePool } from './helpers/pg.mjs';
import { ensureBaseFixtures } from './helpers/fixtures.mjs';

async function main() {
  console.log('[L3 setup] === 预检开始 ===');

  // 1. IDE 端口（先试默认 9420，失败时自动扫描 IDE 监听端口）
  console.log('[L3 setup] 检测微信开发者工具自动化端口...');
  const port = await ensureIdeReady(); // 失败会抛带指引的错误
  console.log(`[L3 setup]   OK — 自动化端口 = ${port}`);

  // 2. PG 连通性
  console.log('[L3 setup] 检测 PG 连接...');
  const rows = await query('SELECT 1 AS ok');
  if (rows[0]?.ok !== 1) throw new Error('PG 健康检查失败');
  console.log('[L3 setup]   OK — PG 可连接');

  // 3. 命名空间基础 fixture
  console.log('[L3 setup] 准备基础 fixture（org/stores）...');
  await ensureBaseFixtures();
  console.log('[L3 setup]   OK — 基础 fixture 已就绪');

  console.log('[L3 setup] === 预检通过 ===');
  await closePool();
}

main().catch((e) => {
  console.error('[L3 setup] FAILED:', e.message);
  closePool().finally(() => process.exit(1));
});
