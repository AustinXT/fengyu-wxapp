

const pg = require('../db/pg')


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
