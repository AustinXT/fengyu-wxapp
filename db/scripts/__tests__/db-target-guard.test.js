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
  "/^postgres(?:ql)?:\\/\\/[^@/]*@(101\\.34\\.242\\.103|118\\.178\\.196\\.26):5433\\/fengyu_wxapp(\\?.*)?$/"

const SCAN_DIRS = [
  'db/scripts',
  'fengyu-staff/scripts/manual-e2e',
  'fengyu-admin/src/db',
]

function collectFiles() {
  const out = []
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir)
    if (!fs.existsSync(abs)) continue
    for (const name of fs.readdirSync(abs)) {
      if (!/\.(js|mjs|ts)$/.test(name)) continue
      const file = path.join(abs, name)
      if (!fs.statSync(file).isFile()) continue
      out.push(file)
    }
  }
  return out
}

test('DB_TARGET_RE 在所有副本中字面量一致（防漂移）', () => {
  const holders = []
  for (const file of collectFiles()) {
    const text = fs.readFileSync(file, 'utf8')
    const m = text.match(/const DB_TARGET_RE = (\/.*\/)\s*$/m)
    if (m) holders.push([path.relative(ROOT, file), m[1]])
  }

  assert.ok(
    holders.length >= 14,
    `只找到 ${holders.length} 处 DB_TARGET_RE，预期 ≥14；若确实删减了脚本请同步调整本断言`,
  )

  for (const [rel, literal] of holders) {
    assert.equal(literal, CANONICAL, `${rel} 的 DB_TARGET_RE 与权威字面量不一致`)
  }
})

test('DB_TARGET_RE 的行为符合预期（正负例）', () => {
  const re = new RegExp(CANONICAL.slice(1, -1))

  for (const ok of [
    'postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp',
    'postgres://fengyu:pw@101.34.242.103:5433/fengyu_wxapp',
    'postgresql://fengyu:pw@118.178.196.26:5433/fengyu_wxapp',
    'postgresql://fengyu:p%40ss@118.178.196.26:5433/fengyu_wxapp?sslmode=require',
  ]) {
    assert.ok(re.test(ok), `应放行但被拒：${ok}`)
  }

  for (const bad of [
    '',
    '   ',
    'postgresql://fengyu:pw@47.113.202.7:5433/fengyu_wxapp', // 已弃用的旧库
    'postgresql://fengyu:pw@101.34.242.103:5434/fengyu', // 旧端口 + 旧库名
    'postgresql://fengyu:pw@101.34.242.103:5433/fengyu_e2e', // e2e 独立库，不是业务库
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
