function hasManagementScope(roleBindings = []) {
  return Array.isArray(roleBindings) && roleBindings.some((role) =>
    (role.scopeType === '总部' || role.scopeType === '市场') &&
    Array.isArray(role.actions) && role.actions.includes('data_center:dashboard'));
}

function resolveWorkspaces(managerStores = [], roleBindings = []) {
  const management = hasManagementScope(roleBindings);
  return {
    management,
    availableWorkspaces: [
      'employee',
      ...(managerStores.length || management ? ['manager'] : []),
      ...(management ? ['management'] : []),
    ],
  };
}

function managerViewStores(managerStores = [], scopedStores = [], management = false) {
  return managerStores.length ? managerStores : management ? scopedStores : [];
}

module.exports = { hasManagementScope, resolveWorkspaces, managerViewStores };
