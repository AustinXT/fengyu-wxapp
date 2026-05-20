#!/usr/bin/env bun
/**
 * card.rechargeConfig + card.recharge + order.confirmOffline 充值卡全链冒烟
 *
 * 2026-05-21 充值卡剥离 SKU 化后：
 *   - rechargeConfig 返回 {tiers,minAmount,maxAmount} 由 system_configs.recharge.* 驱动
 *   - recharge payload {clientUserId, faceValue, paymentMethod}，不再走 SKU
 *
 * 2026-05-21 回归（充值卡全额支付仍判「部分支付」）：
 *   充值卡 total_amount=面额(如1000) ≠ payable_amount=实付(如980)。
 *   confirmOffline 结清判定须以 payable_amount 为基准，否则实付 980 永远 < 面额 1000
 *   → 卡在「部分支付」且储值卡永不入账。本测试用**有折扣的档位**（payAmount < faceValue）
 *   建单 → confirmOffline → 断言 status='已支付' + card_transactions 有 type='充值' amount=面额。
 */
import './setup.mjs'
import {
  NS, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, createTestClient, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-card-recharge] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  const errors = []
  // 1. rechargeConfig（system_configs 驱动）
  const r1 = await invokeStaffApi('card.rechargeConfig', { _testOpenid: TEST_MANAGER_OPENID })
  if (r1.code !== 0) errors.push(`rechargeConfig code=${r1.code} msg=${r1.message}`)
  else {
    const tiers = Array.isArray(r1.data?.tiers) ? r1.data.tiers : []
    if (!tiers.length) errors.push(`rechargeConfig.tiers 为空（system_configs.recharge.tiers 未配置？）`)
    else rec(`  ✓ rechargeConfig OK tiers=${tiers.length} min=¥${r1.data.minAmount} max=¥${r1.data.maxAmount}`)
  }

  // 2. recharge — 优先选有折扣的档位（payAmount < faceValue）以覆盖 面额≠实付 回归；否则取首档
  const tiers = r1.data?.tiers || []
  const tier = tiers.find(t => Number(t.payAmount) < Number(t.faceValue)) || tiers[0]
  const faceValue = tier?.faceValue || 500
  const r2 = await invokeStaffApi('card.recharge', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    faceValue,
    paymentMethod: '线下',
  })
  let saleOrderId = null
  let payAmount = null
  if (r2.code !== 0) {
    errors.push(`recharge code=${r2.code} msg=${r2.message}`)
  } else {
    saleOrderId = r2.data?.saleOrderId
    payAmount = Number(r2.data?.payAmount)
    rec(`  ✓ recharge OK saleOrderId=${saleOrderId} face=¥${faceValue} pay=¥${payAmount}`)
  }

  // 3. confirmOffline（默认确认全额剩余应付 = 实付）→ 4. 断言全额结清 + 储值卡入账
  if (saleOrderId) {
    const r3 = await invokeStaffApi('order.confirmOffline', {
      _testOpenid: TEST_MANAGER_OPENID,
      saleOrderId,
    })
    rec(`  confirmOffline: ${JSON.stringify(r3)}`)
    if (r3.code !== 0) {
      errors.push(`confirmOffline code=${r3.code} msg=${r3.message}`)
    } else if (r3.data?.status !== '已支付') {
      // ← 修复前此处必失败：实付(payAmount) < 面额(faceValue) → '部分支付'
      errors.push(`[回归] 充值卡实付全额后 status 应='已支付'，实际='${r3.data?.status}'（面额${faceValue}/实付${payAmount}）`)
    }

    // 4.1 DB 订单状态
    const ord = (await pgQuery(
      `SELECT status, total_amount, payable_amount, received FROM sale_orders WHERE sale_order_id = $1`,
      [saleOrderId],
    ))[0]
    if (ord?.status !== '已支付') {
      errors.push(`[回归] sale_orders.status 应='已支付'，实际='${ord?.status}'`)
    }

    // 4.2 储值卡入账：card_transactions 有 type='充值' amount=面额（仅结清才入账）
    const topup = await pgQuery(
      `SELECT type, amount FROM card_transactions WHERE ref_order_id = $1 AND type = '充值'`,
      [saleOrderId],
    )
    if (topup.length !== 1) {
      errors.push(`[回归] card_transactions 充值入账应 1 行，实际 ${topup.length}（status 没翻到已支付则不入账）`)
    } else if (Math.abs(Number(topup[0].amount) - Number(faceValue)) > 0.001) {
      errors.push(`[回归] 充值入账面值应=${faceValue}，实际=${topup[0].amount}`)
    } else {
      rec(`  ✓ 储值卡入账 OK：充值 ¥${topup[0].amount}（面额）`)
    }
  }

  if (errors.length) { rec(`  ✗ FAIL`); for (const e of errors) rec(`    - ${e}`); return }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — rechargeConfig + recharge + confirmOffline 全额结清 + 储值卡入账`)
}
try { await main() } catch (e) { console.error('EXCEPTION:', e.message) }
finally { try { await cleanupTestData(NS) } catch {} ; await closePool(); console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`); process.exit(exitCode) }
