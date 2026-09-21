// diag-shopinit.mjs — 一次性诊断：远程 product.shopInit 是否间歇返空
// 连续多次直调远程 staffApi.product.shopInit，记录 code/message + categories/groupedCategories/skuList 计数。
// 目的：区分「云函数 PG 冷启 flaky（时空时6）」vs「确定性返空（远程故障/部署问题）」。
import { launchStaff, disconnect } from './helpers/automator.mjs';
import { loginStaffWithTestOpenid } from './helpers/login.mjs';
import { query, closePool } from './helpers/pg.mjs';
import { createTestManager, createTestClient, cleanupL3TestData } from './helpers/fixtures.mjs';
import { TEST_OPENID_MANAGER, NAMESPACE } from './helpers/constants.mjs';

const L3_KIND_CATEGORY_ID = `${NAMESPACE}KIND_BS01`;
const L3_KIND_NAME = 'L3护理项目';
const L3_CATEGORY_ID = `${NAMESPACE}CAT_BS01`;

async function setupFixture() {
  await query(
    `INSERT INTO product_categories (category_id, category_name, product_kind, sales_category, sort_order, is_valid)
     VALUES ($1, $2, NULL, '他销自耗', 999, true)
     ON CONFLICT (category_id) DO UPDATE SET is_valid = true, product_kind = NULL`,
    [L3_KIND_CATEGORY_ID, L3_KIND_NAME],
  );
  await query(
    `INSERT INTO product_categories (category_id, category_name, product_kind, sales_category, sort_order, is_valid)
     VALUES ($1, 'L3 BS01 护理类', $2, '他销自耗', 0, true)
     ON CONFLICT (category_id) DO UPDATE SET is_valid = true, product_kind = EXCLUDED.product_kind`,
    [L3_CATEGORY_ID, L3_KIND_NAME],
  );
  await query(
    `INSERT INTO product_skus (sku_id, category_id, product_type, spec_name, price, session_count, sort_order, service_fee, is_experience, is_enabled)
     VALUES ($1, $2, '疗程卡', 'L3 BS01 单品 600', 600, 1, 0, 0, false, true)
     ON CONFLICT (sku_id) DO UPDATE SET is_enabled = true`,
    [`${NAMESPACE}SKU_BS01_A`, L3_CATEGORY_ID],
  );
}

async function cleanup() {
  for (const sql of [
    `DELETE FROM product_skus WHERE sku_id LIKE '${NAMESPACE}%'`,
    `DELETE FROM product_categories WHERE category_id LIKE '${NAMESPACE}%'`,
  ]) { try { await query(sql); } catch (e) { console.warn(e.message); } }
}

async function callShopInitRaw(mp, testOpenid) {
  return mp.evaluate((openid) => new Promise((resolve) => {
    wx.cloud.callFunction({
      // 单 env 内并存 staffApi(prod 库) 与 staffApiDev(dev 库)：写死会让断言库与被测页面写入库分裂
      name: (() => { try { const v = wx.getAccountInfoSync().miniProgram.envVersion; return v === 'release' || v === 'trial' ? 'staffApi' : 'staffApiDev' } catch (e) { return 'staffApiDev' } })(),
      data: { action: 'product.shopInit', payload: { _testOpenid: openid } },
      success: (res) => resolve({ ok: true, result: res.result }),
      fail: (err) => resolve({ ok: false, errMsg: err && err.errMsg ? err.errMsg : String(err) }),
    });
  }), testOpenid);
}

async function main() {
  let mp = null;
  try {
    await cleanupL3TestData().catch(() => {});
    await createTestManager();
    await createTestClient();
    await setupFixture();

    mp = await launchStaff();
    await loginStaffWithTestOpenid(mp, TEST_OPENID_MANAGER);

    console.log('[diag] 连续 6 次直调远程 product.shopInit：');
    for (let i = 1; i <= 6; i++) {
      const t0 = Date.now();
      const r = await callShopInitRaw(mp, TEST_OPENID_MANAGER);
      const ms = Date.now() - t0;
      if (!r.ok) {
        console.log(`  #${i} (${ms}ms) ❌ callFunction fail: ${r.errMsg}`);
      } else {
        const d = r.result || {};
        const data = d.data || {};
        const cats = (data.categories || []).length;
        const groups = (data.groupedCategories || []).length;
        const skus = (data.skuList || []).length;
        const hasL3 = (data.groupedCategories || []).some(
          (g) => (g.items || []).some((c) => c.id === L3_CATEGORY_ID));
        console.log(`  #${i} (${ms}ms) code=${d.code} msg="${d.message || ''}" | categories=${cats} groupedCategories=${groups} skuList=${skus} L3=${hasL3}`);
      }
      await new Promise((res) => setTimeout(res, 800));
    }
  } catch (e) {
    console.error('[diag] FATAL', e.message);
    if (e.stack) console.error(e.stack);
  } finally {
    await cleanup().catch(() => {});
    await cleanupL3TestData().catch(() => {});
    await disconnect(mp).catch(() => {});
    await closePool().catch(() => {});
  }
}

main();
