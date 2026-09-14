'use strict'

/**
 * db-target-guard.test.js — 守护「连接串目标断言」在各端副本间不漂移。
 *
 * 背景（issue #151）：已弃用的旧库 47.113.202.7 至今仍可连通、数据陈旧，误连不报错。
 * 因此 db/CLAUDE.md 规定运维脚本必须「显式传 DATABASE_URL 并断言 host/port/dbname」。
 * 该断言以正则字面量的形式内联在十几个脚本里——刻意不抽公共 helper：这些是独立的一次性
 * 运维工具，救火时可能被单独拷出来跑，多一个跨文件依赖就多一个失效点；且它们横跨
 * CJS / ESM / TS 三种模块系统，helper 本身也得维护三份。
 *
 * 代价是字面量重复，所以用本测试兜底：任何一处改了正则或白名单 IP，这里立刻失败。
 * （与本仓 cross-end-*-snapshot 守护四端副本是同一套思路。）
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../../..')

// 权威字面量：改这里必须同时改所有副本，否则本测试失败。
const CANONICAL =
  "/^postgres(?:ql)?:\\/\\/[^@/]*@(101\\.34\\.242\\.103|118\\.178\\.196\\.26):5433\\/fengyu_wxapp(?:\\?(?![^#]*\\b(?:host|hostaddr|port|dbname|database|options|service|passfile)=)[^#]*)?$/"

// 预期持有守卫的入口清单（显式列举，不用「数量 ≥ N」——那样漏改一个也不会失败）。
// 新增连库入口时请一并加进来；删除入口时同步删除。
const EXPECTED_HOLDERS = [
  'db/scripts/calc-monthly-activity.js',
  'db/scripts/import-workfine-legacy.js',
  'db/scripts/migrate-active-cards.js',
  'db/scripts/migrate-allocations.js',
  'db/scripts/migrate-history-orders.js',
  'db/scripts/migrate-jclsh-items.js',
  'db/scripts/migrate-missing-customers.js',
  'db/scripts/migrate-phantom-items.js',
  'db/scripts/migrate-prepaid-cards.js',
  'db/scripts/migrate-presale-services.js',
  'db/scripts/migrate-service-records.js',
  'db/scripts/seed-first-admin.js',
  'db/scripts/seed-recharge-virtual-product.js',
  'db/scripts/sync-workfine.js',
  'db/scripts/test-d4-trigger.mjs',
  'fengyu-admin/src/db/seed.ts',
  'fengyu-staff/scripts/manual-e2e/monitor-pk-conflicts.mjs',
]

function literalIn(relPath) {
  const abs = path.join(ROOT, relPath)
  if (!fs.existsSync(abs)) return null
  // 行尾可能带分号（ESM/TS 文件风格不同），一并容忍
  const m = fs.readFileSync(abs, 'utf8').match(/const DB_TARGET_RE = (\/.*\/);?\s*$/m)
  return m ? m[1] : null
}

test('每个预期入口都持有守卫，且字面量逐字节一致（防漏改 / 防漂移）', () => {
  const missing = []
  const drifted = []
  for (const rel of EXPECTED_HOLDERS) {
    const literal = literalIn(rel)
    if (literal === null) missing.push(rel)
    else if (literal !== CANONICAL) drifted.push(rel)
  }
  assert.deepEqual(missing, [], `以下入口缺少 DB_TARGET_RE 守卫（或文件被删/改名）：\n  ${missing.join('\n  ')}`)
  assert.deepEqual(drifted, [], `以下入口的 DB_TARGET_RE 与权威字面量不一致：\n  ${drifted.join('\n  ')}`)
})

test('DB_TARGET_RE 的行为符合预期（正负例）', () => {
  const re = new RegExp(CANONICAL.slice(1, -1))

  for (const ok of [
    'postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp',
    'postgres://fengyu:pw@101.34.242.103:5433/fengyu_wxapp',
    'postgresql://fengyu:pw@118.178.196.26:5433/fengyu_wxapp',
    'postgresql://fengyu:p%40ss@118.178.196.26:5433/fengyu_wxapp?sslmode=require',
    'postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?connect_timeout=8&application_name=x',
  ]) {
    assert.ok(re.test(ok), `应放行但被拒：${ok}`)
  }

  for (const bad of [
    '',
    '   ',
    'postgresql://fengyu:pw@47.113.202.7:5433/fengyu_wxapp', // 已弃用的旧库
    'postgresql://fengyu:pw@101.34.242.103:5434/fengyu', // 旧端口 + 旧库名
    'postgresql://fengyu:pw@101.34.242.103:5433/fengyu_e2e', // e2e 独立库，不是业务库
    // ⚠ libpq/pg 的 query 参数会**覆盖** URL authority 里的 host/port/dbname
    //（pg-connection-string 源码：Only set the host if there is no equivalent query param）。
    // 只比 authority 会被这类串整个绕过——实测 ?host= 后真实连的是 47.113.202.7。
    'postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?host=47.113.202.7',
    'postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?sslmode=require&host=47.113.202.7',
    'postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?hostaddr=1.2.3.4',
    'postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?port=5434',
    'postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?dbname=other',
    'postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?options=-csearch_path%3Dx',
    'postgresql://fengyu:pw@101.34.242.103:5432/fengyu_wxapp', // 错端口
    'postgresql://fengyu:pw@localhost:5433/fengyu_wxapp',
    'not-a-url',
  ]) {
    assert.ok(!re.test(bad), `应拒绝但被放行：${bad}`)
  }
})

test('白名单只含当前两套业务库，且不含已弃用地址', () => {
  assert.ok(CANONICAL.includes('101\\.34\\.242\\.103'), 'dev 库地址缺失')
  assert.ok(CANONICAL.includes('118\\.178\\.196\\.26'), 'prod 库地址缺失')
  assert.ok(!CANONICAL.includes('47.113.202.7'), '不得把已弃用的 ali-demo 地址放进白名单')
})
