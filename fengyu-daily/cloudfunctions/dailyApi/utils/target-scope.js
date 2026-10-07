async function targetScope(auth, payload, query) {
  const scope = payload.scope || 'personal';
  if (scope === 'personal') {
    const isStoreManager = (auth.managerStores || []).length > 0 ||
      (auth.roleBindings || []).some((role) => role.isStoreManager);
    if (isStoreManager)
      throw Error('PERMISSION_DENIED: 店长无需设置个人经营目标，请在店长工作台设置本店目标');
    if (payload.scopeId && payload.scopeId !== auth.employeeId)
      throw Error('PERMISSION_DENIED: 只能设置本人目标');
    return { scope, scopeId: auth.employeeId, regionId: await require('./../routes/period').marketForStore(query, auth.storeId), storeId: auth.storeId || null };
  }
  if (scope === 'store') {
    const scopeId = payload.scopeId || auth.managerStores?.[0]?.store_id;
    if (!auth.managerStores?.some((s) => s.store_id === scopeId))
      throw Error('PERMISSION_DENIED: 无此门店目标权限');
    return { scope, scopeId, regionId: await require('./../routes/period').marketForStore(query, scopeId), storeId: scopeId };
  }
  if (scope === 'market' && auth.availableWorkspaces?.includes('management') &&
      auth.roleBindings?.some(r=>r.scopeType==='市场'&&r.scopeId===payload.scopeId&&r.actions?.includes('data_center:dashboard'))) {
    const [node] = await query("SELECT id FROM org_nodes WHERE id=$1 AND type='市场'", [payload.scopeId]);
      if (node) return { scope, scopeId: node.id, regionId: node.id, storeId: null };
  }
  throw Error('PERMISSION_DENIED: 无此目标范围权限');
}
module.exports = { targetScope };
