'use strict'
const fs = require('node:fs')
const { isAllowedDbTarget } = require('../db/scripts/_lib/assert-db-target')
const { Client } = require('../db/node_modules/pg')

// CI 将该兼容阈值与真实路由导出的默认页大小对照，防止静默契约漂移。
const LEGACY_EXPERIENCE_LIMIT = 20

async function checkExperiencePaginationCompat(db) {
  const result = await db.query(`SELECT count(*)::int AS count FROM product_skus
    WHERE is_experience = true AND is_enabled = true AND deleted_at IS NULL`)
  const count = result.rows[0]?.count
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('体验卡数量核验结果无效，拒绝部署')
  if (count > LEGACY_EXPERIENCE_LIMIT) throw new Error(`有效体验卡 ${count} 条，旧前端只能显示${LEGACY_EXPERIENCE_LIMIT}条；先完成兼容发布方案，再部署正式clientApi`)
  return count
}
async function main(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const connectionString = config.functions?.find(fn => fn.name === 'clientApi')?.envVariables?.PG_CONNECTION_STRING
  const target = new URL(connectionString)
  if (!isAllowedDbTarget(connectionString) || target.hostname !== '118.178.196.26' || target.port !== '5433' || target.pathname !== '/fengyu_wxapp') throw new Error('正式clientApi数据库目标不符，拒绝部署')
  const db = new Client({ connectionString, connectionTimeoutMillis: 8000, statement_timeout: 8000, query_timeout: 8000 })
  try {
    await db.connect()
    await db.query('BEGIN READ ONLY')
    const count = await checkExperiencePaginationCompat(db)
    console.log(`✓ 旧前端体验卡兼容核验：${count}/${LEGACY_EXPERIENCE_LIMIT}`)
    await db.query('COMMIT')
  } finally { await db.end() }
}
if (require.main === module) main(process.argv[2]).catch(() => {
  // 不打印驱动错误或连接串；业务数量超限通过独立明确提示保留。
  console.error('ERROR: 正式clientApi体验卡兼容核验未通过（数量超过20、目标不符或数据库不可用），拒绝部署。')
  process.exitCode = 1
})
module.exports = { checkExperiencePaginationCompat, LEGACY_EXPERIENCE_LIMIT }
