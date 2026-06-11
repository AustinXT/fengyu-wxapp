/**
 * 市场归属解析工具
 *
 * 以门店为权威反查市场名（org 树：store 节点 → parent 市场节点）。
 * 取代「开单人登录态 ctx.auth.marketName 快照」这一错误口径——
 * 市场归属是门店属性而非开单人属性，开单人快照可能为空或与下单门店市场不一致，
 * 会导致按市场算提成 / 选员工的逻辑失效（候选员工为空、提成率归 0）。
 *
 * 与 admin getMarketStoreIds（fengyu-admin/src/actions/stores.ts）同源 JOIN。
 */

const pg = require('../db/pg')

/**
 * 反查门店所属市场名。
 * @param {string} storeId 门店 ID
 * @returns {Promise<string>} 市场名；门店缺失 / 无 org 链时返回 ''（保守降级，调用方按空兜底）
 */
async function resolveMarketNameByStore(storeId) {
  if (!storeId) return ''
  const rows = await pg.query(`
    SELECT m.name AS market_name
    FROM stores s
    JOIN org_nodes so ON s.org_node_id = so.id
    JOIN org_nodes m  ON so.parent_id = m.id
    WHERE s.store_id = $1
  `, [storeId])
  return rows.length > 0 ? (rows[0].market_name || '') : ''
}

module.exports = { resolveMarketNameByStore }
