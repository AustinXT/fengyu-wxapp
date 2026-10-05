async function targetScope(auth, payload, query) {
  const scope = payload.scope || 'personal';
  if (scope === 'personal') {
    if (payload.scopeId && payload.scopeId !== auth.employeeId)
      throw Error('PERMISSION_DENIED: 只能设置本人目标');
    return { scope, scopeId: auth.employeeId };
  }
  if (scope === 'store') {
    const scopeId = payload.scopeId || auth.managerStores?.[0]?.store_id;
    if (!auth.managerStores?.some((s) => s.store_id === scopeId))
      throw Error('PERMISSION_DENIED: 无此门店目标权限');
    return { scope, scopeId };
  }
  if (scope === 'market' && auth.availableWorkspaces?.includes('management') &&
      auth.scopeOrgNodeIds?.includes(payload.scopeId)) {
    const [node] = await query("SELECT id FROM org_nodes WHERE id=$1 AND type='市场'", [payload.scopeId]);
    if (node) return { scope, scopeId: node.id };
  }
  throw Error('PERMISSION_DENIED: 无此目标范围权限');
}
module.exports = { targetScope };
