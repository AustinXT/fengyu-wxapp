#!/usr/bin/env node
/**
 * 时区回归守护（staff 域）：staffApi pg `timestamp without time zone` (OID 1114) parser 必须 TZ 无关
 *
 * 完整背景见 fengyu-client/tests/e2e-cloudfn/timezone/pg-timezone-parser.spec.mjs。
 * 一句话：库存北京墙钟字面，CloudBase 进程 TZ 不可靠 → 默认 parser 在 TZ=UTC 下偏 +8h
 * （北京 8 点显示 16 点）。修复 = staffApi/db/pg.js 注册显式 +08:00 的 setTypeParser(1114)。
 *
 * ⚠️ 必须 spawn TZ=UTC 子进程才有效：本机默认 TZ=Asia/Shanghai，删了修复在 Shanghai 下默认
 * parser 碰巧也对，只有 UTC 进程能暴露回归。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..') // monorepo 根（e2e-cloudfn→tests→fengyu-staff→root）

const INPUT = '2026-06-16 08:00:00' // 北京墙钟 8 点（库存字面）
const EXPECT = '2026-06-16T00:00:00.000Z' // 正确：UTC 0 点 → 前端北京设备还原为 8 点

const mod = path.join(ROOT, 'fengyu-staff/cloudfunctions/staffApi/db/pg.js')
const pgMod = path.join(ROOT, 'fengyu-staff/cloudfunctions/staffApi/node_modules/pg')

const code = `
  require(${JSON.stringify(mod)});
  const pg = require(${JSON.stringify(pgMod)});
  const parse = pg.types.getTypeParser(1114);
  process.stdout.write(parse(${JSON.stringify(INPUT)}).toISOString() + '|' + (parse(null) === null));
`
const r = spawnSync('node', ['-e', code], { env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' })
const [iso, nullOk] = (r.stdout || '').split('|')

let fail = 0
if (r.status === 0 && iso === EXPECT && nullOk === 'true') {
  console.log(`  ✓ staffApi/db/pg: [TZ=UTC] 1114("${INPUT}") → ${iso}（null 透传 ✓）`)
} else {
  console.log(`  ✗ staffApi/db/pg: 期望 ${EXPECT}，实得 ${iso || '(子进程异常)'}${r.stderr ? ' | ' + r.stderr.trim() : ''}`)
  fail = 1
}

console.log(`[smoke-timezone-parser] end | ${fail ? 0 : 1} passed / ${fail} failed`)
process.exit(fail)
