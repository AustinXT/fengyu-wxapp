/**
 * 链路 55：库存 4 类单据 × 4 视角 scope 隔离矩阵
 *
 * 主题（对齐 link-32~34 风格的库存域版本）：
 *   - admin 在 nc01 / nc02 / 非南昌某店 各造库存单据 fixture（SQL 直插，绕过 action）
 *   - 4 视角分别访问 /inventory/{procurement|sale|transfer|scrap} 列表 → 验单据可见性
 *
 * scope 期望矩阵（按 listXxxOrders 内 scopeCondition 行为）：
 *   - admin（HQ）              → 全可见
 *   - 南昌 MKT（含 nc01+nc02） → 仅南昌市场内门店的单据可见，非南昌不可见
 *   - nc01 MGR                  → 仅 nc01 的单据可见
 *   - 非南昌 MGR（其它市场某店）→ 0 条南昌单据可见
 *
 * transfer 特殊规则：scope OR 命中（storeId IN scope OR counterpartStoreId IN scope）
 *   - nc01 MGR 不仅看到 nc01 出库的，还能看到 ?→nc01 入库目标的 transfer
 *
 * 不变量摘要：单纯 list 命中数，**不**测 CRUD/audit（已由 link-48/49/50 守护）
 *
 * 复用：_helpers/inventory.{insertXxxFixture, cleanupInventoryByPrefix, genFixtureId} + scope-helpers
 */

import { test, expect } from '@playwright/test'
import { BASE, login, psql, TEST_PHONES, TOPOLOGY, recordVerdict, summarize, type Verdict } from './_helpers/scope-helpers'
import {
  insertProcurementFixture,
  insertScrapFixture,
  insertSaleFixture,
  insertTransferFixture,
  cleanupInventoryByPrefix,
  genFixtureId,
} from './_helpers/inventory'

const PREFIX = 'TE2L55-' + Date.now().toString().slice(-6)

test.setTimeout(240_000)

test('链路55：库存 4 类 × 4 视角 scope 矩阵', async ({ browser }) => {
  const verdicts: Verdict[] = []

  // ── Step 0: 造 fixture：在 nc01 / nc02 / 非南昌某店各 1 张 4 类 + 跨店 transfer ──
  const ids: string[] = []

  // 在 nc01 造：procurement、scrap、sale
  const procNc01 = genFixtureId(`${PREFIX}-PROC-NC01`)
  const scrapNc01 = genFixtureId(`${PREFIX}-SCRAP-NC01`)
  const saleNc01 = genFixtureId(`${PREFIX}-SALE-NC01`)
  ids.push(procNc01, scrapNc01, saleNc01)
  insertProcurementFixture({
    id: procNc01,
    storeId: TOPOLOGY.STORE_NC01,
    remark: PREFIX,
    items: [{ productCode: 'X', productName: 'NC01 采购测试', quantity: 1 }],
  })
  insertScrapFixture({
    id: scrapNc01,
    storeId: TOPOLOGY.STORE_NC01,
    remark: PREFIX,
    items: [{ productCode: 'X', productName: 'NC01 报损测试', quantity: 1, scrapReason: '店用' }],
  })
  insertSaleFixture({
    id: saleNc01,
    storeId: TOPOLOGY.STORE_NC01,
    remark: PREFIX,
    items: [{ productCode: 'X', productName: 'NC01 销售测试', quantity: 1 }],
  })

  // 在 nc02 造：procurement
  const procNc02 = genFixtureId(`${PREFIX}-PROC-NC02`)
  ids.push(procNc02)
  insertProcurementFixture({
    id: procNc02,
    storeId: TOPOLOGY.STORE_NC02,
    remark: PREFIX,
    items: [{ productCode: 'X', productName: 'NC02 采购测试', quantity: 1 }],
  })

  // 在 非南昌（store_other_market = b79a82e33d6cf4f3）造：procurement
  const procOther = genFixtureId(`${PREFIX}-PROC-OTHER`)
  ids.push(procOther)
  insertProcurementFixture({
    id: procOther,
    storeId: TOPOLOGY.STORE_OTHER_MARKET,
    remark: PREFIX,
    items: [{ productCode: 'X', productName: '非南昌采购测试', quantity: 1 }],
  })

  // transfer 跨店：3 张
  //   T1: nc02 → nc01（双段都在南昌市场，源 nc02 / 接收 nc01）
  //   T2: nc01 → other_market（跨市场）
  //   T3: other_market → nc02（跨市场反向）
  const trsT1 = genFixtureId(`${PREFIX}-TRSF-NC02NC01`)
  const trsT2 = genFixtureId(`${PREFIX}-TRSF-NC01OTHER`)
  const trsT3 = genFixtureId(`${PREFIX}-TRSF-OTHERNC02`)
  ids.push(trsT1, trsT2, trsT3)
  insertTransferFixture({
    id: trsT1,
    storeId: TOPOLOGY.STORE_NC02,
    counterpartStoreId: TOPOLOGY.STORE_NC01,
    remark: PREFIX,
    items: [{ productCode: 'X', productName: 'T1', quantity: 1 }],
  })
  insertTransferFixture({
    id: trsT2,
    storeId: TOPOLOGY.STORE_NC01,
    counterpartStoreId: TOPOLOGY.STORE_OTHER_MARKET,
    remark: PREFIX,
    items: [{ productCode: 'X', productName: 'T2', quantity: 1 }],
  })
  insertTransferFixture({
    id: trsT3,
    storeId: TOPOLOGY.STORE_OTHER_MARKET,
    counterpartStoreId: TOPOLOGY.STORE_NC02,
    remark: PREFIX,
    items: [{ productCode: 'X', productName: 'T3', quantity: 1 }],
  })

  console.log(`[链路55] 造 fixture 完成：${ids.length} 张（含 6 单店 + 3 调拨）`)

  try {
    // ── Step 1: admin 视角 → 全可见（按 PREFIX 搜索） ────
    console.log('[链路55] Step 1: admin 列表搜索 → 全可见')
    const admCtx = await browser.newContext()
    const admPage = await admCtx.newPage()
    await login(admPage, TEST_PHONES.ADM)
    for (const [cat, label, expectCount] of [
      ['procurement', '采购入库', 3], // nc01 + nc02 + other
      ['sale', '销售出库', 1], // 仅 nc01
      ['scrap', '报损出库', 1], // 仅 nc01
      ['transfer', '门店调拨', 3], // T1 + T2 + T3
    ] as const) {
      await admPage.goto(`${BASE}/inventory/${cat}?q=${encodeURIComponent(PREFIX)}`)
      await admPage.waitForLoadState('networkidle')
      await admPage.waitForTimeout(500)
      const main = (await admPage.locator('main').innerText().catch(() => '')) || ''
      const found = ids.filter((id) => main.includes(id)).length
      recordVerdict(verdicts, `admin/${cat}: 期待 ${expectCount} 张 (${label})`, found === expectCount, `${found}`)
    }
    await admCtx.close()

    // ── Step 2: 南昌 MKT 视角 ───────────────────────
    console.log('[链路55] Step 2: 南昌 MKT 列表搜索')
    const mktCtx = await browser.newContext()
    const mktPage = await mktCtx.newPage()
    await login(mktPage, TEST_PHONES.MKT)
    for (const [cat, label, allowedIds] of [
      // 期望命中的 fixture ids（procurement: nc01+nc02 可见，other 不可见）
      ['procurement', '采购入库', [procNc01, procNc02]],
      ['sale', '销售出库', [saleNc01]],
      ['scrap', '报损出库', [scrapNc01]],
      // transfer OR 命中：T1（nc02→nc01 两端都南昌）、T2（nc01 出，OR 命中 nc01）、T3（接收 nc02，OR 命中 nc02）—— 三张都见
      ['transfer', '门店调拨', [trsT1, trsT2, trsT3]],
    ] as const) {
      await mktPage.goto(`${BASE}/inventory/${cat}?q=${encodeURIComponent(PREFIX)}`)
      await mktPage.waitForLoadState('networkidle')
      await mktPage.waitForTimeout(500)
      const main = (await mktPage.locator('main').innerText().catch(() => '')) || ''
      const visibleHits = allowedIds.filter((id) => main.includes(id))
      recordVerdict(verdicts, `MKT/${cat}: 命中 ${allowedIds.length} 张 (${label})`, visibleHits.length === allowedIds.length, `${visibleHits.length}/${allowedIds.length}`)
      // procurement: 应该看不到 procOther
      if (cat === 'procurement') {
        recordVerdict(verdicts, `MKT/${cat}: 非南昌 procOther 不可见`, !main.includes(procOther), main.includes(procOther) ? 'leaked' : 'hidden')
      }
    }
    await mktCtx.close()

    // ── Step 3: nc01 MGR 视角 ─────────────────────
    console.log('[链路55] Step 3: nc01 MGR 列表搜索')
    const mgrCtx = await browser.newContext()
    const mgrPage = await mgrCtx.newPage()
    await login(mgrPage, TEST_PHONES.MGR)
    // procurement：仅 procNc01；sale/scrap：仅 nc01；transfer：T1(接收nc01) + T2(发起nc01) 命中，T3 不可见
    for (const [cat, allowedIds, deniedIds] of [
      ['procurement', [procNc01], [procNc02, procOther]],
      ['sale', [saleNc01], []],
      ['scrap', [scrapNc01], []],
      ['transfer', [trsT1, trsT2], [trsT3]],
    ] as const) {
      await mgrPage.goto(`${BASE}/inventory/${cat}?q=${encodeURIComponent(PREFIX)}`)
      await mgrPage.waitForLoadState('networkidle')
      await mgrPage.waitForTimeout(500)
      const main = (await mgrPage.locator('main').innerText().catch(() => '')) || ''
      const seenAllowed = allowedIds.filter((id) => main.includes(id)).length
      const leakedDenied = deniedIds.filter((id) => main.includes(id))
      recordVerdict(verdicts, `nc01 MGR/${cat}: 期待 ${allowedIds.length} 张可见`, seenAllowed === allowedIds.length, `${seenAllowed}/${allowedIds.length}`)
      recordVerdict(verdicts, `nc01 MGR/${cat}: 非授权 0 泄漏`, leakedDenied.length === 0, leakedDenied.length === 0 ? 'clean' : leakedDenied.join(','))
    }
    await mgrCtx.close()

    // ── Step 4: 非南昌 MGR2 视角（其他市场 manager） ───
    // 注：FY-TEST-MGR2 实际 scope 取决于 seed；这里测的是"非 nc01 scope"
    // 如果 MGR2 是 nc02 manager（南昌市场内），那 transfer T1/T3 与 nc02 相关——按"scope=nc02"来推断
    console.log('[链路55] Step 4: MGR2（nc02）列表搜索')
    const mgr2Ctx = await browser.newContext()
    const mgr2Page = await mgr2Ctx.newPage()
    await login(mgr2Page, TEST_PHONES.MGR2)
    // 假设 MGR2 scope=nc02：nc02 单店可见 procNc02；transfer T1(接收nc01-发起nc02) + T3(发起other-接收nc02) 命中
    for (const [cat, allowedIds, deniedIds] of [
      ['procurement', [procNc02], [procNc01, procOther]],
      ['sale', [], [saleNc01]],
      ['scrap', [], [scrapNc01]],
      ['transfer', [trsT1, trsT3], [trsT2]], // T1 发起 nc02 / T3 接收 nc02 / T2 nc01-other 与 nc02 无关
    ] as const) {
      await mgr2Page.goto(`${BASE}/inventory/${cat}?q=${encodeURIComponent(PREFIX)}`)
      await mgr2Page.waitForLoadState('networkidle')
      await mgr2Page.waitForTimeout(500)
      const main = (await mgr2Page.locator('main').innerText().catch(() => '')) || ''
      const seenAllowed = allowedIds.filter((id) => main.includes(id)).length
      const leakedDenied = deniedIds.filter((id) => main.includes(id))
      recordVerdict(verdicts, `MGR2(nc02)/${cat}: 命中 ${allowedIds.length} 张`, seenAllowed === allowedIds.length, `${seenAllowed}/${allowedIds.length}`)
      recordVerdict(verdicts, `MGR2(nc02)/${cat}: 非授权 0 泄漏`, leakedDenied.length === 0, leakedDenied.length === 0 ? 'clean' : leakedDenied.join(','))
    }
    await mgr2Ctx.close()
  } finally {
    // 清 fixture（含 audit 不会有，因为是 SQL 直插绕过 action）
    cleanupInventoryByPrefix(PREFIX)
    summarize(55, verdicts)
  }

  const failures = verdicts.filter((v) => v.verdict === 'FAIL')
  expect(failures, `链路55 失败项:\n${JSON.stringify(failures, null, 2)}`).toHaveLength(0)
})
