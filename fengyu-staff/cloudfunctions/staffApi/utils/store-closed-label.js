// utils/store-closed-label.js — 范围下拉「（已关店）」展示标记（#422，staffApi 内部）
//
// **只做展示，不参与任何取数范围。** 数据中心的统计范围只看门店组织节点 is_active（utils/store-status.js，#401）；
// 只关店、节点仍启用的门店照常出现在下拉里、照常有关店前的历史数据，这里仅给它打个标，
// 免得选中后看到关店后区间 0 业绩误判成数据异常。
//
// 为什么单独成文件：#401 的闭集守护禁止数据中心消费方（routes/mgmt-dashboard.js 等）出现 is_closed token，
// 以免「当前是否关店」被偷渡进统计范围。展示标记是唯一合法用途，集中在这里，由
// __tests__/routes/cross-end-store-status-snapshot.test.js 钉死全文，消费方只拿到一个 Set。
//
// ⚠️ 禁跨端共享目录：admin 独立副本 fengyu-admin/src/lib/store-closed-label.ts，改这里须同步那边。

/**
 * 给定门店中「已关店」的 store_id 集合（stores.is_closed，当前状态）。
 * @param {{ query: Function }} pg
 * @param {string[]} storeIds
 * @returns {Promise<Set<string>>}
 */
async function loadClosedStoreIds(pg, storeIds) {
  if (storeIds.length === 0) return new Set()
  const rows = await pg.query(
    'SELECT store_id FROM stores WHERE is_closed = TRUE AND store_id = ANY($1::text[])',
    [storeIds],
  )
  return new Set((rows || []).map((row) => row.store_id))
}

module.exports = { loadClosedStoreIds }
