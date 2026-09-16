#!/usr/bin/env node
const fs = require('fs')
const { OVERRIDE_KEYS: DB_OVERRIDE_KEYS } = require('./_lib/assert-db-target')
const { Client } = require('pg')

const BATCH = 'repair-deposit-refund-service-remarks-20260907'
const TARGET = '寄存单退款专用 — 老系统寄存疗程卡退款核销，不计消耗业绩'
const LEGACY = [
  '录多了3次无消耗', '非正常护理 消耗作废 从新录', '寄存错了，作废', '寄存金额录错了',
  '录错了单，重新录', '入错了', '入多了', '多录20次不算消耗', '次数寄存多了', '非正常护理，划卡纠错',
]
const APPLY = process.argv.includes('--apply')
const CONFIRM = process.argv.includes(`--confirm-prod=${BATCH}`)
const COMM_REASON = `${BATCH}: 历史寄存错误服务单提成作废`
const AUDIT = 'service.repairDepositRefundRemark'
const POINT_PREFIX = `${BATCH}:visit-points:`

function fail(m) { throw new Error(`断言失败：${m}`) }
function assert(x, m) { if (!x) fail(m) }
function n(x) { return Number(x || 0) }
function money(x) { return Math.round(n(x) * 100) / 100 }
function dateOnly(x) { return x instanceof Date ? x.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) : String(x).slice(0, 10) }

async function main() {
  const raw = fs.readFileSync('envs/prod.env', 'utf8')
  const line = raw.split(/\r?\n/).find(x => x.startsWith('ADMIN_DATABASE_URL='))
  assert(line, 'envs/prod.env 缺少 ADMIN_DATABASE_URL')
  const url = line.slice('ADMIN_DATABASE_URL='.length).replace(/^['"]|['"]$/g, '')
  const parsed = new URL(url)
  // query 参数（含百分号编码形式）优先级高于 URL authority，只比 hostname/port/pathname
  // 会被 `?host=<旧库>` 整个绕过 —— 而本脚本 --apply 直接写生产数据。
  {
    const overriding = DB_OVERRIDE_KEYS.filter((k) => parsed.searchParams.has(k))
    if (overriding.length) {
      console.error(`FATAL: 连接串 query 试图覆盖连接目标（${overriding.join(', ')}），拒绝执行`)
      process.exit(1)
    }
  }

  assert(parsed.hostname === '118.178.196.26' && parsed.port === '5433' && parsed.pathname === '/fengyu_wxapp', '连接目标不是 prod 118.178.196.26:5433/fengyu_wxapp')
  if (APPLY) assert(CONFIRM, `提交必须追加 --confirm-prod=${BATCH}`)

  const c = new Client({ connectionString: url }); await c.connect()
  try {
    await c.query('BEGIN')
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('${BATCH}'))`)
    const shape = await c.query(`SELECT to_regclass('service_orders') so, to_regclass('service_items') si, to_regclass('service_commissions') sc, to_regclass('point_transactions') pt, to_regclass('client_wechat_users') cu, to_regclass('operation_logs') ol`)
    const s = shape.rows[0]; assert(s.so && s.si && s.sc && s.pt && s.cu && s.ol, '缺少必要表')

    const candidates = (await c.query(`SELECT service_order_id, client_user_id, service_date, status, commission_status, remark FROM service_orders WHERE remark=ANY($1::text[]) ORDER BY service_order_id FOR UPDATE`, [LEGACY])).rows
    if (!candidates.length) {
      const applied = (await c.query(`SELECT target_id FROM operation_logs WHERE action=$1 AND source='maintenance' AND detail->>'batchId'=$2 ORDER BY target_id`, [AUDIT, BATCH])).rows
      assert(applied.length === 12, `无旧备注命中且审计记录不是 12 条（${applied.length}）`)
      console.log('本批次已完成，无需重复执行'); await c.query('ROLLBACK'); return
    }
    assert(candidates.length === 12, `命中 ${candidates.length} 张，不是 12 张`)
    assert(candidates.every(x => x.status === '已完成'), '存在非已完成目标服务单')
    const ids = candidates.map(x => x.service_order_id)
    const impact = (await c.query(`SELECT COALESCE(SUM(session_used),0)::int sessions, COALESCE(SUM(unit_real_price::numeric*session_used),0)::numeric(14,2) amount FROM service_items WHERE service_order_id=ANY($1::varchar[])`, [ids])).rows[0]
    assert(n(impact.sessions) === 151 && money(impact.amount) === 73728.17, `消耗基线不符：${impact.sessions} 次/${impact.amount} 元`)
    const comm = (await c.query(`SELECT COUNT(*) FILTER(WHERE sc.is_void=false)::int rows, COALESCE(SUM(sc.commission_amount::numeric) FILTER(WHERE sc.is_void=false),0)::numeric(14,2) amount FROM service_commissions sc JOIN service_items si USING(service_item_id) WHERE si.service_order_id=ANY($1::varchar[])`, [ids])).rows[0]
    assert(n(comm.rows) === 33 && money(comm.amount) === 3346, `提成基线不符：${comm.rows} 条/${comm.amount} 元`)
    const points = (await c.query(`WITH co AS (SELECT client_user_id,service_date FROM service_orders WHERE service_order_id=ANY($1::varchar[])), m AS (SELECT DISTINCT pt.id,pt.user_id,pt.amount,pt.external_ref,c.service_date FROM co c JOIN point_transactions pt ON pt.external_ref='visit-points:'||c.client_user_id||':'||c.service_date::text) SELECT m.*, EXISTS(SELECT 1 FROM service_orders o WHERE o.client_user_id=m.user_id AND o.service_date=m.service_date AND o.service_order_id<>ALL($1::varchar[]) AND o.status='已完成' AND o.service_order_type='售后' AND o.remark IS DISTINCT FROM $2 AND EXISTS(SELECT 1 FROM service_items i WHERE i.service_order_id=o.service_order_id AND i.unit_real_price::numeric>0)) has_other FROM m ORDER BY m.id`, [ids, TARGET])).rows
    assert(points.length === 9 && points.reduce((a, x) => a + n(x.amount), 0) === 180, `到店积分基线不符：${points.length} 笔/${points.reduce((a,x)=>a+n(x.amount),0)} 分`)
    const reversible = points.filter(x => !x.has_other)
    assert(reversible.length === 3 && reversible.reduce((a, x) => a + n(x.amount), 0) === 60, '应冲销积分基线不符')
    const users = [...new Set(reversible.map(x => x.user_id))]
    const balances = (await c.query(`SELECT user_id,points_balance,COALESCE((SELECT SUM(amount) FROM point_transactions p WHERE p.user_id=c.user_id),0) ledger FROM client_wechat_users c WHERE user_id=ANY($1::text[]) FOR UPDATE`, [users])).rows
    assert(balances.length === users.length && balances.every(x => n(x.points_balance) === n(x.ledger) && n(x.points_balance) >= 20), '积分余额校验失败')

    await c.query(`UPDATE service_orders SET remark=$1, commission_status='已分配', updated_at=NOW() WHERE service_order_id=ANY($2::varchar[]) AND remark=ANY($3::text[])`, [TARGET, ids, LEGACY])
    const voided = await c.query(`UPDATE service_commissions sc SET is_void=true, voided_at=NOW(), voided_reason=$1, updated_at=NOW() FROM service_items si WHERE si.service_item_id=sc.service_item_id AND si.service_order_id=ANY($2::varchar[]) AND sc.is_void=false RETURNING sc.id`, [COMM_REASON, ids])
    assert(voided.rowCount === 33, `实际作废提成 ${voided.rowCount} 条`)
    const byUser = new Map(); for (const p of reversible) byUser.set(p.user_id, (byUser.get(p.user_id) || 0) + n(p.amount))
    for (const p of reversible) { const r = await c.query(`INSERT INTO point_transactions(user_id,type,amount,ref_order_id,external_ref,created_at) VALUES($1,'消费冲销',$2,NULL,$3,NOW()) ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING RETURNING id`, [p.user_id, -n(p.amount), `${POINT_PREFIX}${p.id}`]); assert(r.rowCount === 1, `积分 ${p.id} 冲销流水写入失败`) }
    for (const [uid, amount] of byUser) { const r = await c.query(`UPDATE client_wechat_users SET points_balance=points_balance-$1, points_updated_at=NOW(), updated_at=NOW() WHERE user_id=$2 AND points_balance >= $1 RETURNING user_id`, [amount, uid]); assert(r.rowCount === 1, `顾客 ${uid} 积分扣减失败`) }
    for (const x of candidates) await c.query(`INSERT INTO operation_logs(action,target_type,target_id,detail,source,created_at) SELECT $1,'service_order',$2,$3::jsonb,'maintenance',NOW() WHERE NOT EXISTS(SELECT 1 FROM operation_logs WHERE action=$1 AND target_id=$2 AND detail->>'batchId'=$4)`, [AUDIT, x.service_order_id, JSON.stringify({_v:1,batchId:BATCH,reason:'历史寄存错误/非服务服务单收敛为寄存单退款专用口径',before:{remark:x.remark},after:{remark:TARGET},commission:{voidedRows:33,voidedAmount:3346,commissionStatusBefore:x.commission_status,commissionStatusAfter:'已分配'}}), BATCH])
    await c.query(`INSERT INTO operation_logs(action,target_type,target_id,detail,source,created_at) SELECT $1,'datafix_batch',$2,$3::jsonb,'maintenance',NOW() WHERE NOT EXISTS(SELECT 1 FROM operation_logs WHERE action=$1 AND target_id=$2)`, ['datafix.repairDepositRefundServiceRemarks', BATCH, JSON.stringify({_v:1,batchId:BATCH,targetRemark:TARGET,serviceOrders:12,voidedCommissionRows:33,voidedCommissionAmount:3346,reversedVisitPointRows:3,reversedVisitPoints:60})])
    const final = (await c.query(`SELECT (SELECT COUNT(*) FROM service_orders WHERE remark=ANY($1::text[])) legacy, (SELECT COUNT(*) FROM service_orders WHERE remark=$2) standard, (SELECT COUNT(*) FROM service_commissions WHERE voided_reason=$3) voided, (SELECT COUNT(*) FROM point_transactions WHERE external_ref LIKE $4) reversals, (SELECT COUNT(*) FROM operation_logs WHERE action=$5 AND detail->>'batchId'=$6) audits`, [LEGACY, TARGET, COMM_REASON, `${POINT_PREFIX}%`, AUDIT, BATCH])).rows[0]
    assert(n(final.legacy) === 0 && n(final.standard) === 38 && n(final.voided) === 33 && n(final.reversals) === 3 && n(final.audits) === 12, `后置断言失败：${JSON.stringify(final)}`)
    if (APPLY) { await c.query('COMMIT'); console.log('生产修复已提交 ✓') } else { await c.query('ROLLBACK'); console.log('DRY-RUN 全部通过，已回滚 ✓') }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { await c.end() }
}
main().catch(e => { console.error(e.message); process.exit(1) })
