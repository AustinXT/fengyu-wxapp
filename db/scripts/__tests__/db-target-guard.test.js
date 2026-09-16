'use strict'

/**
 * db-target-guard.test.js — 守护「连接串目标断言」的正确性与跨副本一致性（issue #151）。
 *
 * 权威实现：db/scripts/_lib/assert-db-target.js。
 * db/scripts 下的脚本直接 require 它；两个跨子项目的入口
 * （fengyu-staff 的 monitor 脚本、fengyu-admin 的 seed.ts）无法 require，内联了同义逻辑，
 * 本测试用**同一组正负例**验证它们行为一致——比比对字面量更本质（字面量可以写法不同而行为相同，
 * 也可以看着一样却因上下文差异而行为不同）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../../..')
const { isAllowedDbTarget, OVERRIDE_KEYS } = require('../_lib/assert-db-target')

// [连接串, 是否应放行, 说明]
const CASES = [
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp', true, 'dev 基本串'],
  ['postgres://fengyu:pw@101.34.242.103:5433/fengyu_wxapp', true, 'postgres:// 也是合法 scheme'],
  ['postgresql://fengyu:pw@118.178.196.26:5433/fengyu_wxapp', true, 'prod 基本串'],
  ['postgresql://fengyu:p%40ss@118.178.196.26:5433/fengyu_wxapp?sslmode=require', true, '密码编码 + 无害 query'],
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?connect_timeout=8&application_name=x', true, '多个无害 query'],

  ['', false, '空串'],
  ['   ', false, '纯空白'],
  ['not-a-url', false, '非 URL'],
  ['postgresql://fengyu:pw@47.113.202.7:5433/fengyu_wxapp', false, '已弃用的旧库（仍可连通，最危险）'],
  ['postgresql://fengyu:pw@101.34.242.103:5434/fengyu', false, '旧端口 + 旧库名'],
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_e2e', false, 'e2e 独立库不是业务库'],
  ['postgresql://fengyu:pw@101.34.242.103:5432/fengyu_wxapp', false, '错端口'],
  ['postgresql://fengyu:pw@localhost:5433/fengyu_wxapp', false, '本地库'],

  // libpq 的 query 参数优先级高于 authority（pg-connection-string：
  // "Only set the host if there is no equivalent query param"），两层绕过都必须挡住：
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?host=47.113.202.7', false, 'query 覆盖 host'],
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?sslmode=require&host=47.113.202.7', false, 'host 藏在第二个参数'],
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?hostaddr=1.2.3.4', false, 'hostaddr 覆盖'],
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?port=5434', false, 'port 覆盖'],
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?dbname=other', false, 'dbname 覆盖'],
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?options=-csearch_path%3Dx', false, 'options 覆盖'],
  // ⚠ 百分号编码：正则匹配字面 `host=` 挡不住，必须靠 searchParams 解码后判断
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?%68ost=47.113.202.7', false, '编码键 %68ost'],
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?h%6Fst=47.113.202.7', false, '编码键 h%6Fst'],
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?%70ort=5434', false, '编码键 %70ort'],
]

test('权威实现的行为符合预期（含 query 覆盖与百分号编码绕过）', () => {
  for (const [url, want, label] of CASES) {
    assert.equal(isAllowedDbTarget(url), want, `${label}：期望${want ? '放行' : '拒绝'} — ${url}`)
  }
})

test('放行的串经真实解析器解析后确实落在白名单内（交叉验证）', () => {
  let parse
  try {
    parse = require('pg-connection-string').parse
  } catch {
    return // 该依赖不在本目录时跳过；CI 的 admin/staff 侧另有覆盖
  }
  for (const [url, want] of CASES) {
    if (!want) continue
    const r = parse(url)
    assert.ok(
      ['101.34.242.103', '118.178.196.26'].includes(r.host) &&
        String(r.port) === '5433' &&
        r.database === 'fengyu_wxapp',
      `放行却解析到白名单外：${url} → ${r.host}:${r.port}/${r.database}`,
    )
  }
})

test('OVERRIDE_KEYS 覆盖 libpq 所有可改写连接目标的参数', () => {
  for (const key of ['host', 'hostaddr', 'port', 'dbname', 'database', 'options', 'service', 'passfile']) {
    assert.ok(OVERRIDE_KEYS.includes(key), `缺少覆盖键：${key}`)
  }
})

// ── 跨副本一致性 ────────────────────────────────────────────────────────────
// 无法 require 的两个入口内联了同义逻辑，这里把它们的实现抽出来跑同一组用例。

const INLINE_COPIES = [
  'fengyu-staff/scripts/manual-e2e/monitor-pk-conflicts.mjs',
  'fengyu-admin/src/db/seed.ts',
]

function extractInlineImpl(relPath) {
  const abs = path.join(ROOT, relPath)
  if (!fs.existsSync(abs)) return null
  const text = fs.readFileSync(abs, 'utf8')
  const re = text.match(/^const DB_TARGET_RE = (\/.*\/)\s*$/m)
  const keys = text.match(/^const DB_OVERRIDE_KEYS(?::\s*string\[\])? = (\[[^\]]*\])/m)
  if (!re || !keys) return null
  // eslint-disable-next-line no-new-func
  return new Function(
    'raw',
    `const DB_TARGET_RE = ${re[1]}
     const DB_OVERRIDE_KEYS = ${keys[1]}
     const s = String(raw ?? '').trim()
     if (!DB_TARGET_RE.test(s)) return false
     try { const u = new URL(s); return !DB_OVERRIDE_KEYS.some((k) => u.searchParams.has(k)) } catch { return false }`,
  )
}

test('跨子项目的内联副本与权威实现行为完全一致', () => {
  for (const rel of INLINE_COPIES) {
    const impl = extractInlineImpl(rel)
    assert.ok(impl, `${rel}：未能提取到内联实现（DB_TARGET_RE / DB_OVERRIDE_KEYS 缺失或格式变了）`)
    for (const [url, want, label] of CASES) {
      assert.equal(impl(url), want, `${rel} 在「${label}」上与权威实现不一致 — ${url}`)
    }
  }
})

test('db/scripts 下的连库入口都改用了权威实现，未各自内联正则', () => {
  const dir = path.join(ROOT, 'db/scripts')
  const offenders = []
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(js|mjs)$/.test(name)) continue
    const abs = path.join(dir, name)
    if (!fs.statSync(abs).isFile()) continue
    const text = fs.readFileSync(abs, 'utf8')
    if (/const DB_TARGET_RE = \//.test(text)) offenders.push(`db/scripts/${name}`)
  }
  assert.deepEqual(
    offenders,
    [],
    `以下脚本又自己内联了正则，应改为 require('./_lib/assert-db-target')：\n  ${offenders.join('\n  ')}`,
  )
})
