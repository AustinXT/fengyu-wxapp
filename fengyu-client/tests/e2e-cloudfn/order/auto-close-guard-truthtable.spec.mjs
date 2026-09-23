#!/usr/bin/env bun
/**
 * clientApi.order — 自动关闭判据的真值表（issue #215）
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/order.js
 *   `PENDING_AUTO_CLOSE_GUARD_SQL`
 *   = `o.status = '待支付' AND o.opened_by IS NULL AND o.lakala_out_order_no IS NULL`
 *
 * **为什么非得有这条 L2**：判据是 SQL，由 PostgreSQL 求值。L1 的 pg mock 喂什么有什么，
 * 根本测不到谓词语义；order.test.js 里的字面同源断言只防「两侧漂移」，不防「两侧一起
 * 改错」。空串在 SQL 里不是 NULL、纯空白也不是 —— 这些正是当初逼着我们不要在 JS 里
 * 镜像这个谓词的原因，必须在真库上钉一次。
 *
 * **本 spec 零写入**：只用 `VALUES` 构造行，不碰任何真实表、不建也不删任何数据，
 * 因此不受 `TE2L2_` 命名空间并发污染影响，可以随时单跑。
 */
import '../setup.mjs'
import { closePool, pgQuery } from '../setup.mjs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ORDER_JS = path.resolve(
  __dirname, '..', '..', '..', 'cloudfunctions', 'clientApi', 'routes', 'order.js',
)

/** 从 routes/order.js 里**原样取出**判据，避免这里抄一份又漂移 */
function readGuardSql() {
  const src = readFileSync(ORDER_JS, 'utf8')
  const at = src.indexOf('const PENDING_AUTO_CLOSE_GUARD_SQL')
  if (at < 0) throw new Error('未找到 PENDING_AUTO_CLOSE_GUARD_SQL')
  const open = src.indexOf('`', at)
  const close = src.indexOf('`', open + 1)
  if (open < 0 || close < 0) throw new Error('判据常量的反引号未闭合')
  return src.slice(open + 1, close)
}

const CASES = [
  ['待支付',   null,   null,      true,  '自助单 + 无在途意图 → 会被关'],
  ['待支付',   'E001', null,      false, '员工开单 → 关不掉（issue #27）'],
  ['待支付',   null,   'FY_1750', false, '有在途支付意图 → 关不掉'],
  ['待支付',   '',     null,      false, 'opened_by 空串：SQL 里不是 NULL → 关不掉'],
  ['待支付',   '   ',  null,      false, 'opened_by 纯空白 → 关不掉'],
  ['待支付',   null,   '',        false, '单号空串：SQL 里不是 NULL → 关不掉'],
  ['待支付',   null,   '   ',     false, '单号纯空白 → 关不掉'],
  ['部分支付', null,   null,      false, '非待支付 → 关不掉'],
  ['已支付',   null,   null,      false, '已支付 → 关不掉'],
  ['已关闭',   null,   null,      false, '已关闭 → 关不掉'],
]

let failed = 0
function check(ok, desc) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${desc}`)
  if (!ok) failed++
}

async function main() {
  const guard = readGuardSql()
  console.log(`判据（取自 routes/order.js）：${guard}`)

  const params = []
  const tuples = CASES.map(([status, openedBy, outTradeNo], i) => {
    params.push(i, status, openedBy, outTradeNo)
    const n = params.length
    return `($${n - 3}::int, $${n - 2}::text, $${n - 1}::varchar(30), $${n}::varchar(64))`
  })

  const rows = await pgQuery(
    `SELECT idx, (${guard}) AS auto_close_eligible
       FROM (VALUES ${tuples.join(', ')})
            AS o(idx, status, opened_by, lakala_out_order_no)
      ORDER BY idx`,
    params,
  )

  if (rows.length !== CASES.length) {
    console.log(`  ✗ 期望 ${CASES.length} 行，实得 ${rows.length}`)
    failed++
  }
  for (const r of rows) {
    const [, , , want, desc] = CASES[r.idx]
    check(r.auto_close_eligible === want, `${desc}（实得 ${r.auto_close_eligible}）`)
  }

  await closePool()
  if (failed > 0) {
    console.log(`\n✗ ${failed} 项未通过`)
    process.exit(1)
  }
  console.log('\n✓ 判据真值表全部通过')
}

main().catch(async (err) => {
  console.error(err)
  await closePool()
  process.exit(1)
})
