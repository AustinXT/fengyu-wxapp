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
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?host=1.1.1.1&host=47.113.202.7', false, '重复 host 键（libpq 取末值）'],

  // 以下形态经实测「解析器不会真的覆盖目标」，故放行是正确的；列在这里把「碰巧安全」
  // 锁成「被验证的安全」——将来若 URL/解析器行为变化导致它们能覆盖目标，本测试会立刻红。
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?HOST=47.113.202.7', true, '大写 HOST（libpq 键名大小写敏感，不生效）'],
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?Dbname=other', true, '大写 Dbname（同上）'],
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?%2568ost=47.113.202.7', true, '双重编码（单次解码得 %68ost，非 host）'],
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?a=1;host=47.113.202.7', true, '分号夹带（& 才是分隔符，; 在值内）'],
  ['postgresql://fengyu:pw@101.34.242.103:5433/fengyu_wxapp?host%3D47.113.202.7', true, '编码等号（整段成为键名）'],
]

test('权威实现的行为符合预期（含 query 覆盖与百分号编码绕过）', () => {
  for (const [url, want, label] of CASES) {
    assert.equal(isAllowedDbTarget(url), want, `${label}：期望${want ? '放行' : '拒绝'} — ${url}`)
  }
})

test('放行的串经真实解析器解析后确实落在白名单内（交叉验证）', (t) => {
  // 「依赖没装」与「行为不符」必须分开处理，否则两边都失真：
  //   - 解析不到模块 = 环境没装依赖（裸 checkout、或把 HEAD 导出到临时目录做提交态验证），
  //     此时报红是假红，显式 skip 并说明怎么拿回这层覆盖；
  //   - 解析得到之后的任何失败（加载报错 / 断言不符）都是真问题，照常抛，绝不吞。
  try {
    require.resolve('pg-connection-string')
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err
    t.skip('未安装 pg-connection-string（pg 的传递依赖）；在 db/ 跑 npm ci 后可获得这层交叉验证')
    return
  }
  const parse = require('pg-connection-string').parse
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

test('跨子项目的内联副本结构完整（trim / URL / searchParams 缺一不可）', () => {
  for (const rel of INLINE_COPIES) {
    const abs = path.join(ROOT, rel)
    assert.ok(fs.existsSync(abs), `${rel} 不存在`)
    const body = fs.readFileSync(abs, 'utf8')
    // extractInlineImpl 只取两个字面量、函数体由测试模板提供，检不出函数体被改坏；
    // 这里对源码本身做结构断言补上这个缺口。
    for (const token of ['isAllowedDbTarget', 'searchParams', '.trim()', 'new URL(']) {
      assert.ok(body.includes(token), `${rel} 的内联实现缺少 ${token}`)
    }
  }
})

test('跨子项目的内联副本与权威实现行为完全一致', () => {
  for (const rel of INLINE_COPIES) {
    const impl = extractInlineImpl(rel)
    assert.ok(impl, `${rel}：未能提取到内联实现（DB_TARGET_RE / DB_OVERRIDE_KEYS 缺失或格式变了）`)
    for (const [url, want, label] of CASES) {
      assert.equal(impl(url), want, `${rel} 在「${label}」上与权威实现不一致 — ${url}`)
    }
  }
})

// CI workflow 的 paths 过滤器本身也是一种「静默跳过」：漏一条路径，改坏守卫也不触发 CI、照样全绿。
// 最容易漏的就是 db/ 之外的两个内联副本（`db/scripts/**` 覆盖不到它们），这里反向锁住。
const CI_WORKFLOW = '.github/workflows/db-script-tests.yml'

/** 取 `on.pull_request.paths` 下的条目；注释行不算数，避免被注释掉的路径骗过。 */
function workflowTriggerPaths(text) {
  const block = text.match(/^\s*paths:\n((?:[ \t]*(?:#.*)?\n|[ \t]*-[ \t]*'[^']*'[ \t]*\n)+)/m)
  if (!block) return null
  return [...block[1].matchAll(/^[ \t]*-[ \t]*'([^']*)'/gm)].map((m) => m[1])
}

test('CI workflow 确实跑本套件，且 paths 覆盖所有跨子项目内联副本', () => {
  const abs = path.join(ROOT, CI_WORKFLOW)
  assert.ok(fs.existsSync(abs), `${CI_WORKFLOW} 不存在——本套件将退回「只靠人手动跑」`)
  const text = fs.readFileSync(abs, 'utf8')
  assert.match(text, /npm run db:test/, `${CI_WORKFLOW} 没有实际运行 db:test`)

  const paths = workflowTriggerPaths(text)
  assert.ok(paths, `${CI_WORKFLOW} 的 paths 块解析失败（格式变了？）`)
  assert.ok(paths.includes('db/scripts/**'), `${CI_WORKFLOW} 的 paths 缺少 db/scripts/**`)
  for (const rel of INLINE_COPIES) {
    assert.ok(
      paths.includes(rel),
      `${CI_WORKFLOW} 的 paths 未覆盖 ${rel}：改坏这份内联守卫不会触发 CI`,
    )
  }
})

test('db:test 的 glob 能覆盖 __tests__ 下的每个测试文件', () => {
  // Node 22 的 `node --test <目录>` **不展开目录**，会把目录名当模块 require 然后整体失败；
  // 本地 Node 26 会展开，于是这个坑在接入 CI 之前一直被掩盖（实测 node:22.23.2 容器复现）。
  // 故 db:test 改用 shell glob：跨 Node 版本行为一致，且零匹配时 sh 会把字面量交给 node、
  // node 找不到文件直接报错 —— fail-closed，不会静默跑 0 个用例后绿灯。
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'db/package.json'), 'utf8'))
  assert.match(
    pkg.scripts['db:test'],
    /node --test scripts\/__tests__\/\*\.test\.js/,
    'db:test 必须用 shell glob，不能退回目录参数（Node 22 下会直接挂）',
  )

  // glob 只认 *.test.js：__tests__ 下任何别的 .js/.mjs 都会被静默漏掉
  const dir = path.join(ROOT, 'db/scripts/__tests__')
  const missed = fs.readdirSync(dir).filter((f) => /\.(js|mjs)$/.test(f) && !f.endsWith('.test.js'))
  assert.deepEqual(
    missed,
    [],
    `以下文件不匹配 db:test 的 glob、会被静默跳过（改名为 *.test.js 或移出本目录）：\n  ${missed.join('\n  ')}`,
  )
})

// 使用权威实现的入口清单。反向的「禁止内联」扫描挡不住「守卫被整个删掉」——
// 那种情况下既没有内联正则、也没有 require，反向扫描照样全绿。故这里再做一次正向断言。
const EXPECTED_HELPER_USERS = [
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
  'db/scripts/sync-workfine.js',
  'db/scripts/seed-recharge-virtual-product.js',
  'db/scripts/seed-first-admin.js',
  'db/scripts/test-d4-trigger.mjs',
  'db/scripts/migrate-lakala-test-data-to-prod.js',
  'db/scripts/repair-deposit-refund-service-remarks-20260824.js',
  'db/scripts/repair-cancel-conversion-order-2608130108.js',
  'db/scripts/repair-bundle-conversion-2608160038.js',
  'db/scripts/repair-unconfirm-conversion-2608050125.js',
  'db/scripts/repair-deposit-refund-service-remarks-20260907.js',
]

test('每个预期入口都确实引用了权威实现（防守卫被整个删掉）', () => {
  const missing = []
  for (const rel of EXPECTED_HELPER_USERS) {
    const abs = path.join(ROOT, rel)
    if (!fs.existsSync(abs)) { missing.push(`${rel}（文件不存在）`); continue }
    const text = fs.readFileSync(abs, 'utf8')
    const usesHelper = /_lib\/assert-db-target/.test(text)
    const callsGuard = /assertDbTargetOrExit|isAllowedDbTarget|DB_OVERRIDE_KEYS/.test(text)
    if (!usesHelper || !callsGuard) missing.push(rel)
  }
  assert.deepEqual(missing, [], `以下入口未引用/未调用权威实现：\n  ${missing.join('\n  ')}`)
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
