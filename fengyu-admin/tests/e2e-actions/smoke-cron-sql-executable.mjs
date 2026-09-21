#!/usr/bin/env bun
/**
 * cron STEP 的 SQL 可执行性冒烟（issue #146 AC4 的真正落地）
 *
 * 为什么要有这个：#146 的根因是 `audit-payment-invariants.ts` 里 I1 的 WHERE 写在了
 * LEFT JOIN 前面 —— PG 语法错，r1 在函数最前面，一抛就整步退出，被 run.ts 的
 * per-STEP try/catch 吞掉，**I1~I5 静默停摆近两个月没人发现**。
 *
 * 而为此新增的单测 `cron/__tests__/audit-payment-invariants.test.ts` 用
 * `vi.mock('@/db')` 把 `db.execute` 整个替换掉了 —— SQL 从不发往 PG，
 * **同样的语法错今天再犯一次，那个单测依然全绿**。补这个脚本就是补这个洞。
 *
 * 做法：直接读 STEP 源文件，抽出每个 `db.execute(sql`...`)` 里的 SQL 文本，
 * 把编译期常量插值还原成字面量，然后逐块 `EXPLAIN`。
 *   - 不调用 STEP 函数本身：它命中违规时会写 operation_logs + 推企微机器人，
 *     冒烟不该有这种副作用（I3 目前真有违规，一跑就会打扰运维）
 *   - 不在测试里抄一份 SQL 副本：抄本会和源码各自漂移，那就退化成"守护一个假的"
 *   - `EXPLAIN` 只做解析 + 计划，不执行，对生产库也安全
 *
 * 用法：
 *   DATABASE_URL=... bun fengyu-admin/tests/e2e-actions/smoke-cron-sql-executable.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

/** 被检查的 STEP 源文件；新增只读巡检 STEP 时往这里加一行。 */
const TARGETS = [
  'fengyu-admin/src/cron/steps/audit-payment-invariants.ts',
  'fengyu-admin/src/cron/steps/audit-points-balance.ts',
  'fengyu-admin/src/cron/steps/audit-role-type-nulls.ts',
  'fengyu-admin/src/cron/steps/audit-store-unbind-orphans.ts',
]

/** 源码里的编译期常量 → EXPLAIN 时的字面量替身。 */
const CONST_SUBSTITUTIONS = {
  MONEY_EPSILON: '0.01',
  SAMPLE_LIMIT: '100',
}

/**
 * 抽出 `sql\`...\`` 模板里的 SQL 文本。
 * 这些 STEP 的 SQL 全是静态模板（只插编译期常量），所以按反引号配对切分足够；
 * 一旦有人写出带嵌套反引号的动态 SQL，下面的 sanity 检查会让它响亮失败而不是被跳过。
 */
function extractSqlBlocks(source) {
  const blocks = []
  const re = /sql`([\s\S]*?)`/g
  let m
  while ((m = re.exec(source)) !== null) {
    const raw = m[1]
    let substituted = 0
    // ${MONEY_EPSILON} 这类编译期常量还原成真值；`${row.user_id}` 这类运行期值
    // 只能塞 NULL —— 它可能让 PG 推不出类型，那种块下面会标成 SKIP 而不是失败，
    // 因为"推不出类型"证明不了 SQL 有错，不该拿它去制造假红。
    const text = raw.replace(/\$\{([^}]+)\}/g, (_, expr) => {
      const key = expr.trim()
      if (CONST_SUBSTITUTIONS[key]) return CONST_SUBSTITUTIONS[key]
      substituted += 1
      return 'NULL'
    })
    if (text.trim()) blocks.push({ sql: text.trim(), dynamic: substituted })
  }
  return blocks
}

/** PG 对「塞了 NULL 导致推不出类型」的固定说法，这类块无法静态校验。 */
function isTypeInferenceFailure(message) {
  return /could not determine data type|is of type .* but expression is of type/i.test(message)
}

async function main() {
  const url = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING
  if (!url) throw new Error('需要 DATABASE_URL 或 PG_CONNECTION_STRING')
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  const { rows: [{ db, host }] } = await client.query(
    `SELECT current_database() AS db, COALESCE(inet_server_addr()::text,'local') AS host`,
  )
  console.log(`[cron-sql-executable] 库: ${db} @ ${host}`)

  let total = 0
  let skipped = 0
  const failures = []

  for (const rel of TARGETS) {
    const source = readFileSync(path.join(REPO_ROOT, rel), 'utf8')
    const blocks = extractSqlBlocks(source)
    if (blocks.length === 0) {
      failures.push({ file: rel, index: -1, message: '未抽到任何 SQL 块（正则失配或文件重构）' })
      continue
    }
    console.log(`\n[${rel}] 抽到 ${blocks.length} 块 SQL`)
    for (let i = 0; i < blocks.length; i += 1) {
      total += 1
      const { sql: text, dynamic } = blocks[i]
      try {
        await client.query(`EXPLAIN ${text}`)
        console.log(`  ✓ #${i + 1} 可执行${dynamic ? `（${dynamic} 处运行期值以 NULL 代入）` : ''}`)
      } catch (e) {
        if (dynamic && isTypeInferenceFailure(e.message)) {
          skipped += 1
          console.log(`  ⏭ #${i + 1} 跳过：含运行期参数，NULL 代入后 PG 推不出类型`)
          continue
        }
        console.log(`  ✗ #${i + 1} ${e.message}`)
        failures.push({ file: rel, index: i + 1, message: e.message })
      }
    }
  }

  await client.end()
  console.log(`\n[cron-sql-executable] 共 ${total} 块，失败 ${failures.length} 块，跳过 ${skipped} 块`)
  if (failures.length) {
    console.log('失败明细：')
    failures.forEach((f) => console.log(`  ${f.file} #${f.index}: ${f.message}`))
    process.exit(1)
  }
  console.log('✅ 全部 SQL 在真库上通过语法与计划校验')
}

main().catch((e) => {
  console.error('[cron-sql-executable] 失败:', e.message)
  process.exit(1)
})
