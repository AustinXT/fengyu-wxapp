#!/usr/bin/env bun
/**
 * 时区回归守护（client 域）：云函数 pg `timestamp without time zone` (OID 1114) parser 必须 TZ 无关
 *
 * 背景：库里业务时间列存的是北京墙钟字面（如 "2026-06-16 08:00:00"）。node-postgres 默认
 * parser 按**进程 TZ**解析该字面；CloudBase 运行时 process.env.TZ 不可靠（V8/ICU 时区在
 * spawn 期已锁 UTC），TZ=UTC 时北京墙钟被当 UTC → 序列化给前端再 +8h → 「北京 8 点显示 16 点」。
 * 修复：三端 pg 初始化注册显式 +08:00 的 setTypeParser(1114)，与进程 TZ 解耦。
 *
 * ⚠️ 为什么必须 spawn TZ=UTC 子进程：本机默认 TZ=Asia/Shanghai，删了修复后默认 parser 在
 * Shanghai 下「碰巧也对」，只有 UTC 进程能暴露回归。故本 spec 在 TZ=UTC 子进程里 require 真实
 * pg 模块、验证注册后的 1114 parser 行为，无论宿主 TZ 都能守护。
 *
 * 覆盖 client 域三处副本中的两个独立 pg 实例：
 *   - clientApi/db/pg.js
 *   - payNotify/config.js（与 payNotify/index.js getPg 注册同一进程 pg.types，等价，故代表 payNotify 包）
 * staffApi/db/pg.js 由 fengyu-staff/tests/e2e-cloudfn/timezone/ 对应 spec 守护（test-colocation）。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../../..') // monorepo 根（timezone→e2e-cloudfn→tests→fengyu-client→root）

const INPUT = '2026-06-16 08:00:00' // 北京墙钟 8 点（库存字面）
const EXPECT = '2026-06-16T00:00:00.000Z' // 正确：UTC 0 点 → 前端北京设备还原为 8 点

// [标签, 触发 setTypeParser 注册的模块, 该包 node_modules/pg]
const PKGS = [
  ['clientApi/db/pg', 'fengyu-client/cloudfunctions/clientApi/db/pg.js', 'fengyu-client/cloudfunctions/clientApi/node_modules/pg'],
  ['payNotify/config', 'fengyu-client/cloudfunctions/payNotify/config.js', 'fengyu-client/cloudfunctions/payNotify/node_modules/pg'],
]

let pass = 0
let fail = 0

for (const [label, modRel, pgRel] of PKGS) {
  const mod = path.join(ROOT, modRel)
  const pgMod = path.join(ROOT, pgRel)
  const code = `
    require(${JSON.stringify(mod)});
    const pg = require(${JSON.stringify(pgMod)});
    const parse = pg.types.getTypeParser(1114);
    process.stdout.write(parse(${JSON.stringify(INPUT)}).toISOString() + '|' + (parse(null) === null));
  `
  const r = spawnSync('node', ['-e', code], { env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' })
  const [iso, nullOk] = (r.stdout || '').split('|')
  if (r.status === 0 && iso === EXPECT && nullOk === 'true') {
    console.log(`  ✓ ${label}: [TZ=UTC] 1114("${INPUT}") → ${iso}（null 透传 ✓）`)
    pass++
  } else {
    console.log(`  ✗ ${label}: 期望 ${EXPECT}，实得 ${iso || '(子进程异常)'}${r.stderr ? ' | ' + r.stderr.trim() : ''}`)
    fail++
  }
}

console.log(`[timezone/pg-timezone-parser.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
