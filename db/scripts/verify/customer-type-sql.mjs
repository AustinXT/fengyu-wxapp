#!/usr/bin/env node
/**
 * #187 顾客分类跃迁：真实 PG 语义验证。
 *
 * 从 staffApi 源码里用**守护测试同款正则**提取真实的 CTE / CASE / 两段归因 SQL，
 * 替换参数后在临时 PG 上跑正负例，并**逐条核对期望值**——不符即非零退出。
 *
 * 跑法见同目录 README.md。只操作固定名字的 docker 容器，不读 DATABASE_URL，不碰任何业务库。
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CONTAINER = 'pg-187-verify'
const DB = 'fy187'
const THRESHOLD = 1980
const SRC = 'fengyu-staff/cloudfunctions/staffApi/routes/order.js'

// ── 期望表：每组都对应一个真实存在过、或被评审指出的缺陷 ──
const USERS = [
  ['U_mix', '小美客', '混合订单 体验500+非体验1600=2100，只按非体验部分判（本 issue 核心口径）'],
  ['U_pure', '会员客', '纯非体验 2000 ≥ 1980'],
  ['U_trial', '体验客', '只买体验卡 680'],
  ['U_small', '小美客', '非体验 500 < 1980'],
  ['U_refund', '会员客', '付清 2000 后退 1500，毛实收仍 2000（退款不扣减）'],
  ['U_partial', '流量客', '部分支付已收 2500 未结清，不参与判定'],
  ['U_none', '流量客', '无订单'],
  ['U_zero', '流量客', '已结清但 received=0（相对旧口径是行为变化）'],
  ['U_legacy', '会员客', 'WorkFine 历史单无明细行，回退订单级 received=3000'],
  ['U_overrefund', '小美客', '退款 note 记 9999 > 行毛额 500，LEAST 封顶后 non_trial=500'],
  ['U_badjson', '会员客', 'note={手工备注} 非法 JSON，不得抛 22P02'],
  ['U_truncjson', '会员客', 'note={"items": 截断，LIKE 守门挡不住，靠 try_jsonb'],
  ['U_badnum', '会员客', 'refundAmount="abc"，靠 try_numeric'],
  ['U_xorder', '小美客', 'A 单退款 note 错写 B 单 item id，复合键 JOIN 拦掉（单键会把 B 推满额）'],
  ['U_exitonly', '流量客', '整单只含退出方向明细，不得走回退分支拿订单级 received'],
]
// 归因断言：首次跃迁为会员客后，两段 UPDATE 必须选同一单
const ATTRIBUTION = { user: 'U_pure', becameDate: '2026-01-11', upgradeOrder: 'O_pure' }

const src = readFileSync(SRC, 'utf8')
const pick = (re, what) => {
  const m = src.match(re)
  if (!m) throw new Error(`提取失败：${what}。源码结构变了？请同步本脚本与守护测试的正则。`)
  return m[0]
}
const cte = pick(/WITH refund_by_item AS \([\s\S]*?GROUP BY o\.sale_order_id, o\.received\s*\)/m, '金额 CTE')
const caseSql = pick(/SELECT CASE[\s\S]*?END AS computed_type/m, '三档 CASE')
const CTE_REF = '${RECALC_CUSTOMER_TYPE_CTE}'
const upd = pick(/UPDATE sale_orders SET is_membership_upgrade[\s\S]*?LIMIT 1\s*\)/, 'is_membership_upgrade 归因').replace(CTE_REF, () => cte)
const bma = pick(/UPDATE client_wechat_users SET became_member_at[\s\S]*?LIMIT 1\s*\)[\s\S]{0,40}?WHERE user_id = \$\d+/, 'became_member_at 归因').replace(CTE_REF, () => cte)

// 按**完整占位符**一次性替换：不能用 replaceAll('$1', …)，那样 `$10` 会被当成 `$1`+`0`
// 替出 `'U_pure'0`，`$20` 更会静默替成 `19800`（合法但错误的 SQL）——codex 闸门 2 指出的盲区。
const PARAMS = { 1: (u) => `'${u}'`, 2: () => String(THRESHOLD) }
const sub = (s, u) =>
  s.replace(/\$(\d+)/g, (m, n) => {
    const f = PARAMS[n]
    if (!f) throw new Error(`SQL 里出现未知参数 ${m}（源码参数布局变了？）——本脚本只认 $1=顾客 / $2=阈值`)
    return f(u)
  })
const psql = (file) => {
  execFileSync('docker', ['cp', file, `${CONTAINER}:/tmp/run.sql`])
  return execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-F', '|', '-f', '/tmp/run.sql'],
    { encoding: 'utf8' },
  )
}

const work = mkdtempSync(join(tmpdir(), 'fy187-'))
// 异常路径（sub/docker cp/psql 抛错）也要报出现场路径，否则 README 承诺的「失败保留并打印」不成立
process.on('uncaughtException', (e) => {
  console.error(`\n❌ ${e.message}`)
  console.error(`   生成的 SQL 保留在 ${work}`)
  process.exit(2)
})

// ── 1. 三档判定 ──
const typeSql = USERS.map(([u]) => `SELECT '${u}', (${sub(`${cte}\n${caseSql}`, u)});`).join('\n\n')
const typeFile = join(work, 'type.sql')
writeFileSync(typeFile, typeSql)
const got = new Map(
  psql(typeFile).trim().split('\n').filter(Boolean).map((l) => {
    const [u, v] = l.split('|')
    return [u.trim(), (v || '').trim()]
  }),
)

let failed = 0
console.log('=== 三档判定 ===')
for (const [u, want, why] of USERS) {
  const actual = got.get(u)
  const ok = actual === want
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${u.padEnd(13)} 期望 ${want} / 实际 ${actual ?? '(无结果)'}  — ${why}`)
}

// ── 2. 归因 UPDATE 实跑 + 核对两段选同一单 ──
console.log('\n=== 归因 UPDATE ===')
const attrFile = join(work, 'attr.sql')
writeFileSync(
  attrFile,
  [
    // ⚠️ 先重置：两段归因是 UPDATE，写入后会留在库里。不重置的话第二次跑读到的是上次的结果，
    // 即使本次 UPDATE 一行没命中也照样"通过"——断言会退化成只在首次跑有效。
    `UPDATE client_wechat_users SET became_member_at = NULL WHERE user_id = '${ATTRIBUTION.user}';`,
    `UPDATE sale_orders SET is_membership_upgrade = false WHERE is_membership_upgrade;`,
    `${sub(bma, ATTRIBUTION.user)};`,
    `${sub(upd, ATTRIBUTION.user)};`,
    // 带标签列 + COALESCE：两个 SELECT 都可能返回 NULL（UPDATE 没命中时），
    // -t -A 下 NULL 是空行，裸解析会被 trim 吞掉导致行错位、把「日期」显示成订单号。
    `SELECT 'date', COALESCE(to_char(became_member_at, 'YYYY-MM-DD'), '<NULL>') FROM client_wechat_users WHERE user_id = '${ATTRIBUTION.user}';`,
    `SELECT 'orders', COALESCE(string_agg(sale_order_id, ',' ORDER BY sale_order_id), '<无打标单>') FROM sale_orders WHERE is_membership_upgrade;`,
  ].join('\n\n'),
)
const attrRows = new Map(
  psql(attrFile).split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf('|')
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }),
)
const gotDate = attrRows.get('date')
const gotOrders = attrRows.get('orders')
for (const [label, actual, want] of [
  ['became_member_at', gotDate, ATTRIBUTION.becameDate],
  ['is_membership_upgrade 打标单', gotOrders, ATTRIBUTION.upgradeOrder],
]) {
  const ok = actual === want
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(26)} 期望 ${want} / 实际 ${actual}`)
}

// ── 3. 三个全库批量脚本的 SQL 可执行性 ──
// 本脚本原先只提取 staffApi 的运行时 SQL，批量脚本一行没跑过——于是
// `recalc-all-customer-types.js` 引用已 DROP 的 paid_amount 列（跑一次必炸）一直没被发现，
// 直到闸门 2 codex 静态审出来。这里把三个脚本的建表 SQL 也在临时库上真跑一遍（事务内回滚）。
console.log('\n=== 全库批量脚本 SQL 可执行性 ===')
const SCRIPTS = [
  ['recalc-all-customer-types.js', /const BUILD_TARGET_TABLE_SQL = `([\s\S]*?)`/],
  ['recalc-became-member-at.js', /const BUILD_TARGET_SQL = `([\s\S]*?)`/],
  ['backfill-membership-upgrade-doc-type.js', /const BUILD_TARGET_SQL = `([\s\S]*?)`/],
]
for (const [name, re] of SCRIPTS) {
  const body = readFileSync(`db/scripts/${name}`, 'utf8').match(re)?.[1]
  if (!body) {
    console.log(`✗ ${name.padEnd(40)} 提取建表 SQL 失败（结构变了？）`)
    failed++
    continue
  }
  const f = join(work, `${name}.sql`)
  // $1 = 阈值；事务内跑完即回滚，不留痕
  // 同样按完整占位符替换（不能 replaceAll('$1', …)，`$10` 会被静默替成 19800）。
  // 批量脚本只应有 $1=阈值这一个参数；出现别的一律报错，防口径漂移后静默跑出错误结果。
  const bodySql = body.replace(/\$(\d+)/g, (m, n) => {
    if (n !== '1') throw new Error(`${name} 出现未知参数 ${m}（批量脚本只应有 $1=阈值）`)
    return String(THRESHOLD)
  })
  writeFileSync(f, `BEGIN;\n${bodySql};\nROLLBACK;\n`)
  try {
    psql(f)
    console.log(`✓ ${name.padEnd(40)} SQL 可执行`)
  } catch (e) {
    const msg = String(e.stderr || e.message).split('\n').filter(Boolean).slice(-2).join(' / ')
    console.log(`✗ ${name.padEnd(40)} ${msg}`)
    failed++
  }
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项不符`}（${USERS.length} 组判定 + 2 项归因 + ${SCRIPTS.length} 个批量脚本）`)
if (failed === 0) {
  rmSync(work, { recursive: true, force: true })
} else {
  // 失败时保留现场：生成的 SQL 就在这里，可直接贴进 psql 复现
  console.log(`   生成的 SQL 保留在 ${work}`)
}
process.exitCode = failed === 0 ? 0 : 1
