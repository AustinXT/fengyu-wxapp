#!/usr/bin/env node
/**
 * 时区回归守护（staff 域）：staffApi pg `timestamp with time zone` (OID 1184) 读取必须 TZ 无关
 *
 * 范式背景（migration 0076 / commit 70f1a584，v1.3.3~v1.3.7）：业务时间列已从 `timestamp without
 * time zone` (1114) 统一改为 `timestamptz` (1184)。PG 在 server TZ=Asia/Shanghai（migration 0028
 * 锁定）下把 timestamptz 以带 +08 偏移的文本字面发到线上（如 "2026-06-16 08:00:00+08"），pg 内置
 * 1184 parser 按字面偏移 `new Date(value)` 正确解析为绝对 UTC 瞬时，与进程 TZ 解耦。
 *
 * 旧 1114 时代的显式 setTypeParser(1114, '+08:00') 补偿层已随范式转换彻底拆除（库已无 1114 列，
 * staffApi/db/pg.js 仅保留 20/1700 两个 OID 解析）。
 *
 * ⚠️ 必须 spawn TZ=UTC 子进程才有效：本机默认 TZ=Asia/Shanghai，默认 parser 在 Shanghai 下也正确，
 * 只有 UTC 进程能暴露「偏移字面被当本地时间」类的回归（如未来误注册无偏移 1114 自定义 parser、
 * 或误把列改回 without time zone）。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..') // monorepo 根（e2e-cloudfn→tests→fengyu-staff→root）

const INPUT = '2026-06-16 08:00:00+08' // timestamptz 线字面（server TZ=Shanghai → 带 +08 偏移）
const EXPECT = '2026-06-16T00:00:00.000Z' // 正确：UTC 0 点 → 前端北京设备还原为 8 点

const mod = path.join(ROOT, 'fengyu-staff/cloudfunctions/staffApi/db/pg.js')
const pgMod = path.join(ROOT, 'fengyu-staff/cloudfunctions/staffApi/node_modules/pg')

const code = `
  require(${JSON.stringify(mod)});
  const pg = require(${JSON.stringify(pgMod)});
  const parse = pg.types.getTypeParser(1184);
  process.stdout.write(parse(${JSON.stringify(INPUT)}).toISOString() + '|' + (parse(null) === null));
`
const r = spawnSync('node', ['-e', code], { env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' })
const [iso, nullOk] = (r.stdout || '').split('|')

let fail = 0
if (r.status === 0 && iso === EXPECT && nullOk === 'true') {
  console.log(`  ✓ staffApi/db/pg: [TZ=UTC] 1184("${INPUT}") → ${iso}（null 透传 ✓）`)
} else {
  console.log(`  ✗ staffApi/db/pg: 期望 ${EXPECT}，实得 ${iso || '(子进程异常)'}${r.stderr ? ' | ' + r.stderr.trim() : ''}`)
  fail = 1
}

console.log(`[smoke-timezone-parser] end | ${fail ? 0 : 1} passed / ${fail} failed`)
process.exit(fail)
