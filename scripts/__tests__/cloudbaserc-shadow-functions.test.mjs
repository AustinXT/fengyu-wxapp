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

/** 源码里会读 process.env.PAYNOTIFY_FN_NAME 的函数（运行时 fail-closed，配置必须齐） */
const NEEDS_PAYNOTIFY_FN_NAME = new Set(['clientApi', 'clientApiDev', 'payNotify', 'payNotifyDev'])

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
      // 不写 dir 就会去找不存在的 cloudfunctions/<name>Dev 目录，部署直接失败。
      assert.equal(
        fn.dir,
        `cloudfunctions/${baseNameOf(fn.name)}`,
        `${fn.name} 的 dir 必须指向正式函数的代码目录，保证两者同源`
      )
      assert.ok(
        fs.existsSync(path.join(ROOT, `fengyu-${side}`, fn.dir)),
        `${fn.name} 的 dir 指向了不存在的目录：${fn.dir}`
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

  test(`fengyu-${side}: 影子函数的 env 引用逐项反推自正式函数，不得回落到宿主值`, () => {
    // 这里刻意【不用硬编码清单】——那种写法有两个洞：
    //   ① 清单漏掉的变量永远测不到（曾漏了整组 LAKALA_*）
    //   ② 配 `if (v === undefined) continue` 的话，把变量从影子里整个删掉反而通过
    // 改为反推：正式函数凡是用 `${X}` 引用的键，影子函数必须是 `${DEV_X}`，
    // 例外只能走下面这份显式 allowlist。新增变量自动被纳入守护。
    const ALLOW_HOST_VALUE = new Set([
      'TZ',                   // 常量
      'CLIENT_APPSECRET',     // 客户端小程序固有 appsecret，dev/prod 本就同一份
      'TMAP_KEY',             // 腾讯地图 key，与环境无关
      'TMAP_SECRET',
      'CLIENT_API_HTTP_URL',  // 字面量拼 prod 域名 + Dev 路径（影子函数住 prod env）
      'LAKALA_NOTIFY_URL',    // 同上
      'PAYNOTIFY_FN_NAME',    // 字面量 payNotifyDev
      'DEPLOY_CHANNEL',       // 字面量 shadow
    ])
    const fns = loadTemplate(side).functions
    for (const shadow of fns.filter((f) => isShadow(f.name))) {
      const primary = fns.find((f) => f.name === baseNameOf(shadow.name))
      assert.ok(primary, `${shadow.name} 找不到对应正式函数`)
      for (const [key, primaryValue] of Object.entries(primary.envVariables ?? {})) {
        if (ALLOW_HOST_VALUE.has(key)) continue
        const ref = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(String(primaryValue))
        if (!ref) continue // 正式函数这一项本就是字面量，不作要求
        assert.equal(
          shadow.envVariables?.[key],
          `\${DEV_${ref[1]}}`,
          `${shadow.name}.${key} 必须取 dev 值（正式函数用的是 \${${ref[1]}}）`
        )
      }
    }
  })

  test(`fengyu-${side}: 影子函数不得少配正式函数有的变量`, () => {
    // 防「整个删掉一个变量」——删掉后上一条的逐项比对会因取到 undefined 而失败，
    // 这条再从键集层面兜一次，失败信息更直白。
    const fns = loadTemplate(side).functions
    for (const shadow of fns.filter((f) => isShadow(f.name))) {
      const primary = fns.find((f) => f.name === baseNameOf(shadow.name))
      const missing = Object.keys(primary.envVariables ?? {}).filter(
        (k) => !(k in (shadow.envVariables ?? {}))
      )
      assert.deepEqual(missing, [], `${shadow.name} 缺少正式函数持有的变量`)
    }
  })

  test(`fengyu-${side}: DEPLOY_CHANNEL 标明部署身份`, () => {
    // 云函数入口据此判断「调用方版本」与「本函数通道」是否匹配，
    // 错了会把开发版流量放进生产库而不报错。
    for (const fn of loadTemplate(side).functions) {
      assert.equal(
        fn.envVariables?.DEPLOY_CHANNEL,
        isShadow(fn.name) ? 'shadow' : 'primary',
        `${fn.name}.DEPLOY_CHANNEL`
      )
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
    // 就会拿 dev 库查出的订单号去让生产函数写 prod 库——唯一能把钱写错库的路径。
    // 运行时已改成 fail-closed（缺失即跳过对账），这里断言配置侧必须齐全：
    // 不能用 `if (v === undefined) continue`，那样把键整个删掉反而通过。
    for (const fn of loadTemplate(side).functions) {
      if (!NEEDS_PAYNOTIFY_FN_NAME.has(fn.name)) continue
      assert.equal(
        fn.envVariables?.PAYNOTIFY_FN_NAME,
        isShadow(fn.name) ? 'payNotifyDev' : 'payNotify',
        `${fn.name}.PAYNOTIFY_FN_NAME`
      )
    }
  })
}

test('deploy-cloudfunctions.sh 的 code update 必须显式传 --dir', () => {
  // CLI 3.0.1 的 `tcb fn code update` 不认 cloudbaserc 的配置项 `dir`：它会把配置里的
  // 目录打印出来，打包时却仍按 functionRoot/<函数名> 拼路径，于是影子函数报
  // 「路径不存在：…/cloudfunctions/clientApiDev」。三个 *Dev 建好之后每次部署都走这条路径，
  // 漏掉 --dir 就是每次 dev 发版必挂（2026-09-22 实发时踩到）。
  const src = fs.readFileSync(path.join(ROOT, 'scripts/deploy-cloudfunctions.sh'), 'utf8')
  const offenders = []
  for (const line of src.split('\n')) {
    if (line.trimStart().startsWith('#')) continue // 注释里复述命令不算
    if (!/\btcb fn code update\b/.test(line)) continue
    // 无 `dir` 字段的正式函数走不带 --dir 的分支，由紧邻的 [[ -n "$dir" ]] 判定守住
    if (/--dir\b/.test(line) || /"\$fn"\s*$/.test(line)) continue
    offenders.push(line.trim())
  }
  assert.deepEqual(offenders, [], '这些 code update 调用既没传 --dir 也不在 dir 判定分支内')
  assert.ok(
    /tcb fn code update "\$fn" --dir "\$dir"/.test(src),
    'deploy_one_fn 缺少「声明了 dir 就传 --dir」的分支'
  )
})

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
  // 正确写法：cloud.callFunction({ name: process.env.PAYNOTIFY_FN_NAME })（运行时 fail-closed）
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

test('e2e 助手不得硬编码云函数名', () => {
  // L3 e2e 用 automator 驱动开发者工具，被测页面走 getApiFnName() → *Dev（dev 库）。
  // 助手若在 miniProgram.evaluate 里写死 'staffApi'/'clientApi'，就会打到同一 env 的
  // 正式函数（prod 库）——断言的库和被测代码写入的库分裂，测试静默失真；
  // 更糟的是通用 invoke 助手会把下单之类的写操作直接打进生产库。
  const dirs = [
    'fengyu-staff/tests',
    'fengyu-client/tests',
  ]
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(full)
      } else if (/\.(mjs|js)$/.test(entry.name)) {
        const src = fs.readFileSync(full, 'utf8')
        for (const m of src.matchAll(/name:\s*['"](clientApi|staffApi|payNotify)['"]/g)) {
          offenders.push(`${path.relative(ROOT, full)}:${src.slice(0, m.index).split('\n').length}`)
        }
      }
    }
  }
  for (const d of dirs) {
    const abs = path.join(ROOT, d)
    if (fs.existsSync(abs)) walk(abs)
  }
  assert.deepEqual(offenders, [], '这些位置写死了云函数名，应按 envVersion 判定')
})
