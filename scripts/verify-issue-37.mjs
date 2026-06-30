#!/usr/bin/env node
// scripts/verify-issue-37.mjs
// issue #37（client 支付完成后订单状态不更新 + 详情页频闪）修复的 red-green verify。
//
// 根因：payNotify 异步回调偶发丢失（生产 FY-XSD-WX-2606300001 为证：received=0、payments 空、钱已扣），
//       系统把回调当唯一真理来源、无补偿；前端支付成功立即跳转不等回调。
// 修复：新增 order.confirmPayment（拉卡拉 queryTrade 主动对账 → SUCCESS 则 callFunction payNotify
//       触发同款幂等入账），对账决策由纯函数 decideReconcile 承担。
//
// base（未修复）：order.js 未 export confirmPayment / decideReconcile → red
// fix：export 存在 + decideReconcile 决策正确 → green
import { createRequire } from 'node:module'
import assert from 'node:assert'

const require = createRequire(import.meta.url)
const orderPath = require.resolve('../fengyu-client/cloudfunctions/clientApi/routes/order.js')

let bad = 0
const check = (name, fn) => {
  try {
    fn()
    console.log('✓ ' + name)
  } catch (e) {
    bad++
    console.error('✗ ' + name + ' — ' + e.message)
  }
}

let order
try {
  order = require(orderPath)
} catch (e) {
  console.error('✗ 无法加载 order.js：' + e.message)
  process.exit(1)
}

// === 修复存在性（base red / fix green）===
check('order.confirmPayment 已实现（对账 + 补偿入账接口）', () => {
  assert.strictEqual(typeof order.confirmPayment, 'function')
})
check('order.decideReconcile 已实现（对账决策纯函数）', () => {
  assert.strictEqual(typeof order.decideReconcile, 'function')
})

// === decideReconcile 决策正确性（issue #37 核心逻辑，测真实项目函数）===
const { decideReconcile } = order
check('已支付终态 → skip（不动已到账单）', () =>
  assert.strictEqual(decideReconcile('已支付', true, 'SUCCESS'), 'skip'))
check('已完成/已关闭/支付失败 → skip', () => {
  assert.strictEqual(decideReconcile('已完成', true, null), 'skip')
  assert.strictEqual(decideReconcile('已关闭', true, 'SUCCESS'), 'skip')
  assert.strictEqual(decideReconcile('支付失败', true, 'SUCCESS'), 'skip')
})
check('无拉卡拉单（全额储值卡 / 线下单）→ skip（无需对账）', () => {
  assert.strictEqual(decideReconcile('待支付', false, null), 'skip')
  assert.strictEqual(decideReconcile('部分支付', false, 'SUCCESS'), 'skip')
})
check('待支付/部分支付 + 拉卡拉 SUCCESS → reconcile（触发补偿入账）', () => {
  assert.strictEqual(decideReconcile('待支付', true, 'SUCCESS'), 'reconcile')
  assert.strictEqual(decideReconcile('部分支付', true, 'SUCCESS'), 'reconcile')
})
check('待支付/部分支付 + 拉卡拉未 SUCCESS → wait（前端继续轮询）', () => {
  assert.strictEqual(decideReconcile('待支付', true, 'INIT'), 'wait')
  assert.strictEqual(decideReconcile('部分支付', true, null), 'wait')
  assert.strictEqual(decideReconcile('待支付', true, 'CLOSE'), 'wait')
})

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`)
process.exit(bad > 0 ? 1 : 0)
