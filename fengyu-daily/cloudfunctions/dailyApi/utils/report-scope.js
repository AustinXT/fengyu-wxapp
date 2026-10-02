function reportStores(auth) {
  return auth?.availableWorkspaces?.includes("management")
    ? auth.scopedStores || []
    : auth?.managerStores || [];
}
function requireManagement(auth) {
  if (!auth?.availableWorkspaces?.includes("management"))
    throw Error("PERMISSION_DENIED: 无管理层日报查看权限");
}
module.exports = { reportStores, requireManagement };
