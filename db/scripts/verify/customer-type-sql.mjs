#!/usr/bin/env node
/**
 * #187 判据层：把 staffApi 源码里的真实 CTE + CASE 提取出来，在临时 PG 上跑正负例。
 * 提取正则与守护测试 recalc-customer-type-sql.test.js 一致 ⇒ 验的就是线上那段 SQL。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const SRC = 'fengyu-staff/cloudfunctions/staffApi/routes/order.js'
const src = readFileSync(SRC, 'utf8')

const cte = src.match(/WITH refund_by_item AS \([\s\S]*?GROUP BY o\.sale_order_id, o\.received\s*\)/m)?.[0]
const caseSql = src.match(/SELECT CASE[\s\S]*?END AS computed_type/m)?.[0]
if (!cte || !caseSql) throw new Error('提取失败：CTE 或 CASE 未命中')

const CTE_REF = '${RECALC_CUSTOMER_TYPE_CTE}'
const upd = src.match(/UPDATE sale_orders SET is_membership_upgrade[\s\S]*?LIMIT 1\s*\)/)[0].replace(CTE_REF, cte)
const bma = src.match(/UPDATE client_wechat_users SET became_member_at[\s\S]*?LIMIT 1\s*\)[\s\S]{0,40}?WHERE user_id = \$\d+/)[0].replace(CTE_REF, cte)

const USERS = [
  ['U_mix', '小美客', '混合订单 体验500+非体验1600=2100，只按非体验部分判'],
  ['U_pure', '会员客', '纯非体验 2000 ≥ 1980'],
  ['U_trial', '体验客', '只买体验卡 680'],
  ['U_small', '小美客', '非体验 500 < 1980'],
  ['U_refund', '会员客', '付清2000后退1500，毛实收仍 2000（退款不扣减）'],
  ['U_partial', '流量客', '部分支付单已收2500但未结清，不参与判定'],
  ['U_none', '流量客', '无订单'],
  ['U_zero', '流量客', '已结清但 received=0（行为变化：旧口径判小美客）'],
  ['U_legacy', '会员客', 'WorkFine 历史单无明细行，回退订单级 received=3000'],
  ['U_overrefund', '小美客', '退款 note 记 9999 > 行毛额 500，LEAST 封顶后 non_trial=500 <1980'],
  ['U_badjson', '会员客', 'note 以 { 开头但非合法 JSON，不得抛 22P02'],
  ['U_truncjson', '会员客', '截断 JSON {"items": —— 旧 LIKE 守门会放行并抛 22P02，try_jsonb 降级为 NULL'],
  ['U_badnum', '会员客', 'refundAmount="abc" —— 旧 ::numeric 抛 22P02，try_numeric 降级为 NULL'],
  ['U_xorder', '小美客', '跨单错配：A 单的退款 note 写了 B 单的 item id，不得加到 B 的毛实收（旧写法会把 B 推到 2500 满额→会员客）'],
  ['U_exitonly', '流量客', '只含退出方向明细：不得走回退分支拿订单级 received 3000（会绕过 LEAST 封顶误升）'],
]
const THRESHOLD = 1980
const sub = (s, u) => s.replaceAll('$1', `'${u}'`).replaceAll('$2', String(THRESHOLD))

const parts = [`\\echo '=== 1. 三档判定（期望值见注释）==='`]
for (const [u, expect, why] of USERS) {
  parts.push(`\\echo '--- ${u} 期望=${expect}  (${why})'`)
  parts.push(`SELECT '${u}' AS user_id, (${sub(`${cte}\n${caseSql}`, u)}) AS computed;`)
}

parts.push(`\\echo '=== 2. 订单金额明细 ==='`)
for (const u of ['U_xorder', 'U_legacy', 'U_exitonly']) {
  parts.push(`${sub(cte, u)} SELECT '${u}' AS scope, sale_order_id, non_trial, trial FROM order_amounts ORDER BY 2;`)
}

parts.push(`\\echo '=== 3. 归因 UPDATE 实跑（U_pure）==='`)
parts.push(`${sub(bma, 'U_pure')};`)  // 提取正则已含 WHERE user_id
parts.push(`${sub(upd, 'U_pure')};`)
parts.push(`SELECT user_id, became_member_at FROM client_wechat_users WHERE user_id = 'U_pure';`)
parts.push(`SELECT sale_order_id, is_membership_upgrade FROM sale_orders WHERE is_membership_upgrade;`)

writeFileSync('_tmp/issue-187/verify-run.sql', parts.join('\n\n'))
execSync('docker cp _tmp/issue-187/verify-run.sql pg-187-verify:/tmp/r.sql')
console.log(
  execSync('docker exec pg-187-verify psql -U postgres -d fy187 -v ON_ERROR_STOP=1 -q -t -A -F " | " -f /tmp/r.sql', {
    encoding: 'utf8',
  }),
)
