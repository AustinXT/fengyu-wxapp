#!/usr/bin/env node
/**
 * #187 顾客分类跃迁：真实 PG 语义验证。
 *
 * 从 staffApi 源码里用**守护测试同款正则**提取真实的 CTE / CASE / 两段归因 SQL，
 * 替换参数后在临时 PG 上跑正负例，并**逐条核对期望值**——不符即非零退出。
 *
 * 跑法见同目录 README.md。只操作固定名字的 docker 容器，不读 DATABASE_URL，不碰任何业务库。
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
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
const upd = pick(/UPDATE sale_orders SET is_membership_upgrade[\s\S]*?LIMIT 1\s*\)/, 'is_membership_upgrade 归因').replace(CTE_REF, cte)
const bma = pick(/UPDATE client_wechat_users SET became_member_at[\s\S]*?LIMIT 1\s*\)[\s\S]{0,40}?WHERE user_id = \$\d+/, 'became_member_at 归因').replace(CTE_REF, cte)

const sub = (s, u) => s.replaceAll('$1', `'${u}'`).replaceAll('$2', String(THRESHOLD))
const psql = (file) => {
  execFileSync('docker', ['cp', file, `${CONTAINER}:/tmp/run.sql`])
  return execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-F', '|', '-f', '/tmp/run.sql'],
    { encoding: 'utf8' },
  )
}

const work = mkdtempSync(join(tmpdir(), 'fy187-'))

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
    `${sub(bma, ATTRIBUTION.user)};`,
    `${sub(upd, ATTRIBUTION.user)};`,
    `SELECT to_char(became_member_at, 'YYYY-MM-DD') FROM client_wechat_users WHERE user_id = '${ATTRIBUTION.user}';`,
    `SELECT string_agg(sale_order_id, ',' ORDER BY sale_order_id) FROM sale_orders WHERE is_membership_upgrade;`,
  ].join('\n\n'),
)
const [gotDate, gotOrders] = psql(attrFile).trim().split('\n').map((s) => s.trim())
for (const [label, actual, want] of [
  ['became_member_at', gotDate, ATTRIBUTION.becameDate],
  ['is_membership_upgrade 打标单', gotOrders, ATTRIBUTION.upgradeOrder],
]) {
  const ok = actual === want
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(26)} 期望 ${want} / 实际 ${actual}`)
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项不符`}（${USERS.length} 组判定 + 2 项归因）`)
process.exit(failed === 0 ? 0 : 1)
