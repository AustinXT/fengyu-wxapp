const pg = require('../db/pg');
async function roster(query, auth) {
  const storeIds = auth.availableWorkspaces?.includes('management') ? (auth.scopedStores || []).map((s) => s.store_id)
    : [...new Set([auth.storeId, ...(auth.managerStores || []).map((s) => s.store_id)].filter(Boolean))];
  return query(`WITH RECURSIVE lineage AS (
    SELECT n.id,n.parent_id FROM org_nodes n JOIN stores s ON s.org_node_id=n.id WHERE s.store_id=ANY($1::text[])
    UNION SELECT n.id,n.parent_id FROM org_nodes n JOIN lineage l ON n.id=l.parent_id
  ) SELECT u.employee_id,u.name,u.position_name FROM staff_wechat_users u
    WHERE NOT u.is_resigned AND u.employee_id<>$2 AND (
      u.store_id=ANY($1::text[]) OR EXISTS(SELECT 1 FROM permission_roles r WHERE r.employee_id=u.employee_id
        AND r.scope_id IN (SELECT id FROM lineage))) ORDER BY u.name,u.employee_id`, [storeIds, auth.employeeId]);
}
async function validate(query, auth, mentorId, peerId) {
  if (!mentorId && !peerId) return { mentor: null, peer: null };
  const rows = await roster(query, auth);
  const byId = new Map(rows.map((row) => [row.employee_id, row]));
  for (const id of [mentorId, peerId]) if (id && !byId.has(id)) throw Error('PERMISSION_DENIED: 指导员或同事不在可选择范围');
  return { mentor: mentorId ? { employeeId: mentorId, name: byId.get(mentorId).name } : null,
    peer: peerId ? { employeeId: peerId, name: byId.get(peerId).name } : null };
}
async function list(ctx) { ctx.result = { contacts: await roster(pg.query, ctx.auth) }; }
module.exports = { roster, validate, list };
