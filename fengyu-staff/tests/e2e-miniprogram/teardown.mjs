// teardown.mjs — 显式清理 L3 命名空间 fixture（独立可跑）

import { cleanupL3TestData } from './helpers/fixtures.mjs';
import { closePool } from './helpers/pg.mjs';

async function main() {
  console.log('[L3 teardown] 清理 TEST_E2E_L3_* 命名空间...');
  await cleanupL3TestData();
  console.log('[L3 teardown] 完成');
  await closePool();
}

main().catch((e) => {
  console.error('[L3 teardown] FAILED:', e.message);
  closePool().finally(() => process.exit(1));
});
