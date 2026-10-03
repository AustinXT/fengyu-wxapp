const { expandScopeStoreIds } = require('./scope');
async function visibleStores(auth, pg) {
  const own = [auth.storeId, ...(auth.managerStores || []).map(s=>s.store_id)].filter(Boolean);
  if (!auth.availableWorkspaces?.includes('management')) return [...new Set(own)];
  // 数据查看范围绑定授予该动作的角色，不能与其他角色的总部范围拼接。
  const roles = (auth.roleBindings || []).filter(r=>r.actions?.includes('data_center:dashboard'));
  const managed = await expandScopeStoreIds(roles, pg);
  return [...new Set([...own, ...managed])];
}
module.exports = { visibleStores };
