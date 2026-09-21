// 影子函数（*Dev）不变量守卫
//
// 背景：CloudBase 环境收缩到单个 prod env 后，dev/prod 的数据库隔离不再靠「两个环境」，
// 而是靠同一 env 内并存的两套函数：clientApi/staffApi/payNotify 连 prod 库，
// 对应的 *Dev 连 dev 库。小程序端按 envVersion（release vs develop/trial）选调哪一套。
//
// 这套隔离一旦破口，后果是开发版/体验版直接读写生产数据，且完全静默。
// 本测试守住模板层面的不变量——它只读 cloudbaserc.example.json 和云函数源码，
// 不需要 envs/*.env 里的任何密钥，因此可以在 CI 上跑。
//
// 渲染后的实际取值由 scripts/deploy-cloudfunctions.sh 的 assert_rc 再把一道关
// （逐函数断言 PG host，影子函数期望 dev、正式函数期望 prod，双向）。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const SHADOW_SUFFIX = 'Dev'
const isShadow = (name) => name.endsWith(SHADOW_SUFFIX)
const baseNameOf = (name) => name.slice(0, -SHADOW_SUFFIX.length)

function loadTemplate(side) {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, `fengyu-${side}`, 'cloudbaserc.example.json'), 'utf8')
  )
}

const SIDES = ['client', 'staff']
/** 每一侧期望存在的影子函数 —— 漏掉任何一个都意味着那条链路会落到生产库 */
const EXPECTED_SHADOWS = {
  client: ['clientApiDev', 'payNotifyDev'],
  staff: ['staffApiDev'],
}

for (const side of SIDES) {
  test(`fengyu-${side}: 每个正式函数都有配套影子函数`, () => {
    const fns = loadTemplate(side).functions
    const names = fns.map((f) => f.name)
    for (const shadow of EXPECTED_SHADOWS[side]) {
      assert.ok(names.includes(shadow), `缺少影子函数 ${shadow}`)
      assert.ok(
        names.includes(baseNameOf(shadow)),
        `影子函数 ${shadow} 找不到对应的正式函数 ${baseNameOf(shadow)}`
      )
    }
  })

  test(`fengyu-${side}: 影子函数复用正式函数的代码目录（dir）`, () => {
    for (const fn of loadTemplate(side).functions.filter((f) => isShadow(f.name))) {
      // tcb 解析代码目录的优先级是 --dir > 配置项 dir > functionRoot/<name>。
      // 不写 dir 就会去找不存在的 cloudfunctions/<name>Dev 目录，部署直接跳过。
      assert.equal(
        fn.dir,
        `cloudfunctions/${baseNameOf(fn.name)}`,
        `${fn.name} 的 dir 必须指向正式函数的代码目录，保证两者同源`
      )
    }
  })

  test(`fengyu-${side}: 影子函数连 dev 库、正式函数连宿主环境库`, () => {
    for (const fn of loadTemplate(side).functions) {
      const conn = fn.envVariables?.PG_CONNECTION_STRING
      assert.ok(conn, `${fn.name} 缺少 PG_CONNECTION_STRING`)
      if (isShadow(fn.name)) {
        assert.equal(
          conn,
          '${DEV_PG_CONNECTION_STRING}',
          `${fn.name} 必须引用 DEV_ 前缀变量，否则影子函数会连到生产库`
        )
      } else {
        assert.equal(
          conn,
          '${PG_CONNECTION_STRING}',
          `${fn.name} 是正式函数，不得引用 DEV_ 前缀变量`
        )
      }
    }
  })

  test(`fengyu-${side}: 影子函数的其余 env 引用不得回落到宿主（prod）值`, () => {
    // dev/prod 取值有差异的变量清单——影子函数必须走 DEV_ 前缀。
    // 少一项就意味着影子函数在那个维度上表现得像生产（如 SEC_CHECK_ENABLED、拉卡拉正式环境）。
    const MUST_BE_DEV = [
      'ALLOW_TEST_OPENID',
      'ALLOW_DIRECT_PHONE',
      'SEC_CHECK_ENABLED',
      'INVENTORY_LINKAGE_ENABLED',
      'WX_SHIPPING_ENABLED',
      'LAKALA_API_BASE',
      'WXACODE_ENV_VERSION',
    ]
    for (const fn of loadTemplate(side).functions.filter((f) => isShadow(f.name))) {
      for (const key of MUST_BE_DEV) {
        const v = fn.envVariables?.[key]
        if (v === undefined) continue // 该函数本来就不用这个变量
        assert.equal(v, `\${DEV_${key}}`, `${fn.name}.${key} 必须取 dev 值`)
      }
    }
  })

  test(`fengyu-${side}: 影子函数的 HTTP 入口指向自己的 Dev 路径`, () => {
    // 这两个 URL 刻意不从 dev.env 取：dev.env 里的 CLIENT_SERVICE_URL 指向已停服的 dev env 域名，
    // 而影子函数住在 prod env，必须是 prod 域名 + Dev 路径。
    for (const fn of loadTemplate(side).functions.filter((f) => isShadow(f.name))) {
      const { CLIENT_API_HTTP_URL: apiUrl, LAKALA_NOTIFY_URL: notifyUrl } = fn.envVariables ?? {}
      if (apiUrl !== undefined) {
        assert.equal(apiUrl, '${CLIENT_SERVICE_URL}/cloudfunctions/clientApiDev')
      }
      if (notifyUrl !== undefined) {
        assert.equal(notifyUrl, '${CLIENT_SERVICE_URL}/lakala/notify-dev')
      }
    }
  })

  test(`fengyu-${side}: PAYNOTIFY_FN_NAME 与函数自身归属一致`, () => {
    // 决定对账自调打向哪个 payNotify。影子函数若指向 'payNotify'，
    // 就会拿 dev 库查出的订单号去让生产函数写 prod 库。
    for (const fn of loadTemplate(side).functions) {
      const v = fn.envVariables?.PAYNOTIFY_FN_NAME
      if (v === undefined) continue
      assert.equal(v, isShadow(fn.name) ? 'payNotifyDev' : 'payNotify', `${fn.name}.PAYNOTIFY_FN_NAME`)
    }
  })
}

test('payNotifyDev 不得挂 timer 触发器', () => {
  // 正式 payNotify 的 wxShippingBackfill 每分钟跑对账，会 UPDATE sale_orders。
  // 两份同时跑会互抢 lakala_out_order_no 的释放。
  const fn = loadTemplate('client').functions.find((f) => f.name === 'payNotifyDev')
  assert.ok(fn, '找不到 payNotifyDev')
  const timers = (fn.triggers ?? []).filter((t) => t.type === 'timer')
  assert.deepEqual(timers, [], 'payNotifyDev 不应有 timer 触发器')
})

test('云函数源码中不得硬编码 payNotify 函数名', () => {
  // 影子函数与正式函数跑同一份代码，字面量函数名会让 Dev 实例调到生产 payNotify。
  // 正确写法：cloud.callFunction({ name: process.env.PAYNOTIFY_FN_NAME || 'payNotify' })
  const files = [
    'fengyu-client/cloudfunctions/payNotify/index.js',
    'fengyu-client/cloudfunctions/clientApi/routes/order.js',
  ]
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const offenders = [...src.matchAll(/name:\s*['"]payNotify['"]/g)]
    assert.deepEqual(
      offenders.map((m) => src.slice(0, m.index).split('\n').length),
      [],
      `${rel} 存在硬编码的 payNotify 函数名（上列为行号）`
    )
  }
})
