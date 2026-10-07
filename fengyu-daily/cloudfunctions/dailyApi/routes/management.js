const pg = require("../db/pg");
const v = require("../utils/validation");
const { requireManagement } = require("../utils/report-scope");
const submissions = require('../utils/submission-range');
async function read(ctx) {
  requireManagement(ctx.auth);
  const nodes = await pg.query(
    'SELECT id,name,type,parent_id FROM org_nodes WHERE id=ANY($1::text[]) ORDER BY sort_order,name',
    [ctx.auth.scopeOrgNodeIds]);
  const nodeId = ctx.event.payload?.nodeId;
  if (nodeId && !nodes.some((n) => n.id === nodeId)) throw Error('PERMISSION_DENIED: 无权查看该组织范围');
  const descendants = new Set(nodeId ? [nodeId] : nodes.map((n) => n.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) if (n.parent_id && descendants.has(n.parent_id) && !descendants.has(n.id)) {
      descendants.add(n.id); changed = true;
    }
  }
  const scopedStores = ctx.auth.scopedStores.filter((s) => !nodeId || descendants.has(s.org_node_id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const nodeRegion = (id) => {
    let current = nodeById.get(id), visited = new Set();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.type === '市场') return current.id;
      current = nodeById.get(current.parent_id);
    }
    return null;
  };
  const selectedRegion = nodeId ? nodeRegion(nodeId) : null;
  const allowedRegions = [...new Set((nodeId ? [selectedRegion] : nodes.filter((n) => n.type === '市场').map((n) => n.id)).filter(Boolean))];
  const rangeRegion = selectedRegion || (allowedRegions.length === 1 ? allowedRegions[0] : null);
  if ((ctx.event.payload?.period === 'week' || ctx.event.payload?.period === 'month') && !rangeRegion)
    throw Error('INVALID_PARAMS: 按周或按月查看时，请先选择一个区域');
  const range = await submissions.range(pg.query, ctx.event.payload, ctx.auth, rangeRegion);
  const date = range.date;
  const employees = await submissions.people(pg.query, scopedStores.map((s) => s.store_id), range);
  const stores = scopedStores.map((s) => {
    const people = employees.filter((e) => e.store_id === s.store_id);
    return {
      ...s,
      ...submissions.summary(people),
    };
  });
  const markets = nodes.filter((n) => n.type === '市场').map((market) => {
    const ids = new Set([market.id]);
    let growing = true;
    while (growing) {
      growing = false;
      for (const n of nodes) if (ids.has(n.parent_id) && !ids.has(n.id)) { ids.add(n.id); growing = true; }
    }
    const storeIds = new Set(stores.filter((s) => ids.has(s.org_node_id)).map((s) => s.store_id));
    return { id: market.id, name: market.name, ...submissions.summary(employees.filter((e) => storeIds.has(e.store_id))) };
  }).filter((m) => m.due > 0);
  ctx.result = {
    date,
    range,
    selectedNodeId: nodeId || null,
    nodes, markets,
    stores,
    employees,
    summary: submissions.summary(employees),
  };
}
module.exports = { read };
