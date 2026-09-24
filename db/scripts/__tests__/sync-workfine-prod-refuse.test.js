'use strict'

/**
 * sync-workfine 对**生产库**硬拒绝（issue #318）。
 *
 * 业务方 2026-04-16 已决定「上线后不再执行 WorkFine 同步」，但那只是流程约定 ——
 * 代码层面谁都能对着生产库跑，而该脚本的 `staff_wechat_users` UPSERT 直接写 `is_resigned`、
 * 既不取 `admin:active_count` 也不复核「至少留一名在职超级管理员」。#318 收紧认证之后，
 * 把最后一名超管标成离职的后果是**没人能登录管理后台**。
 *
 * 所以要挡在门口。这条测试真的 `spawn` 脚本 —— 断言的是「进程被拒绝并退出」，
 * 而不是「源码里有某段文本」。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { isProdDbTarget, PROD_DB_HOST } = require('../_lib/assert-db-target')

const SCRIPT = path.resolve(__dirname, '..', 'sync-workfine.js')
const PROD_URL = `postgresql://u:pw@${PROD_DB_HOST}:5433/fengyu_wxapp`
const DEV_URL = 'postgresql://u:pw@101.34.242.103:5433/fengyu_wxapp'

/** 跑脚本、只看是否在「拒绝」这一步退出 —— 用 --dry-run 避免真去连 MSSQL */
function run(env) {
  return spawnSync(process.execPath, [SCRIPT, '--dry-run'], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  })
}

test('isProdDbTarget 只认生产 host', () => {
  assert.equal(isProdDbTarget(PROD_URL), true)
  assert.equal(isProdDbTarget(DEV_URL), false)
  assert.equal(isProdDbTarget(''), false)
  assert.equal(isProdDbTarget(undefined), false)
})

test('指向生产库 → 退出码 1 且写清后果', () => {
  const r = run({ DATABASE_URL: PROD_URL })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /拒绝对生产库运行 WorkFine 同步/)
  // 必须写清后果，否则下一个人只会想办法绕过它
  assert.match(r.stderr, /无法登录管理后台/)
})

/**
 * **无条件**拒绝：不留环境变量阀门。
 *
 * 第一版留了 `ALLOW_PROD_WORKFINE_SYNC=1`，codex 第 6 轮指出那等于没关 ——
 * 「生产只剩一名超管时设置该变量运行同步」这条反例照样能把后台锁死。
 * 一个环境变量不构成决策成本；真要跑就改代码、走 review。
 * 这条用例遍历几个看起来像阀门的变量名，任何一个能放行都算退步。
 */
test('没有任何环境变量能放行（无条件拒绝）', () => {
  for (const key of [
    'ALLOW_PROD_WORKFINE_SYNC',
    'ALLOW_PROD_SYNC',
    'FORCE',
    'FORCE_PROD',
  ]) {
    const r = run({ DATABASE_URL: PROD_URL, [key]: '1' })
    assert.equal(r.status, 1, `${key}=1 竟然放行了`)
    assert.match(r.stderr, /拒绝对生产库运行 WorkFine 同步/)
  }
})

test('指向 dev 库 → 不受这道闸影响', () => {
  const r = run({ DATABASE_URL: DEV_URL })
  assert.doesNotMatch(r.stderr, /拒绝对生产库运行 WorkFine 同步/)
})
