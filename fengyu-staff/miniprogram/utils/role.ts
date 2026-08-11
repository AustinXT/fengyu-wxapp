// utils/role.ts — 员工层级 / 登录模式判定 + 兼容旧 API

function app() {
  return getApp<IAppOption>();
}

export function getStaffLevel(): StaffLevel {
  return app().globalData.staffLevel ?? null;
}

export function getLoginLevel(): LoginLevel {
  return app().globalData.loginLevel ?? 'store';
}

export function isManagementMode(): boolean {
  return getLoginLevel() === 'management';
}

export function isHeadquartersLevel(): boolean {
  return getStaffLevel() === 'headquarters';
}

export function isMarketLevel(): boolean {
  return getStaffLevel() === 'market';
}

export function canAccessManagement(): boolean {
  return (app().globalData.availableLoginLevels || []).includes('management');
}

export function canAccessStore(): boolean {
  const levels = app().globalData.availableLoginLevels || [];
  return levels.includes('store');
}

/**
 * 当前身份是否可执行当前门店的店长操作。
 *
 * `managerStores` 是 auth.login 下发的 manager 角色管辖门店；`managerStoreIds`
 * 用于兼容缓存或后端直接下发 id 列表的场景。两者均不命中时一律按非店长处理，
 * 避免切换到非管辖门店后继续显示门店写操作。
 */
export function isManager(): boolean {
  if (getLoginLevel() !== 'store') return false;

  const currentStoreId = getCurrentStoreId();
  if (!currentStoreId) return false;

  const g = app().globalData;
  const scopedIds = new Set([
    ...(Array.isArray(g.managerStoreIds) ? g.managerStoreIds : []),
    ...(Array.isArray(g.managerStores)
      ? g.managerStores.map((store) => store.storeId).filter(Boolean)
      : []),
  ]);
  return scopedIds.has(currentStoreId);
}

/**
 * 当前身份是否为门店美容师 / 门店其他角色
 */
export function isBeautician(): boolean {
  return getStaffLevel() === 'store_staff';
}

/**
 * 判定当前用户是否拥有任一指定角色。
 * roles 来源：globalData.roles（permission_roles 表 + 后端 staffApi.auth.login 下发）。
 *
 * 与 isManager() 的区别：isManager() 还会校验当前门店是否在 manager 角色管辖范围；
 * hasRole 用于"按角色字符串数组"判定的场景（如菜单显隐、跨角色复合权限）。
 *
 * @example
 *   hasRole('manager')             // 单角色
 *   hasRole('manager', 'finance')  // 任一即可
 */
export function hasRole(...roleNames: string[]): boolean {
  const roles = app().globalData.roles ?? [];
  return roleNames.some(r => roles.includes(r));
}

/**
 * 要求店长身份，否则 toast 提示
 */
export function requireManager(tipMsg = '该操作仅限店长'): boolean {
  if (!isManager()) {
    wx.showToast({ title: tipMsg, icon: 'none' });
    return false;
  }
  return true;
}

export function getStaffWfId(): string {
  return app().globalData.staffWfId;
}

/**
 * 当前生效的门店 id（供业务查询 / 下拉切换用）
 * 门店模式：globalData.currentStoreId（未设置回退到 boundStoreId）
 * 管理层模式：空串（业务 API 不应依赖）
 */
export function getCurrentStoreId(): string {
  const g = app().globalData;
  if (g.loginLevel === 'management') return '';
  return g.currentStoreId || g.boundStoreId || '';
}

/** 是否同时拥有两种视图权限。口径与登录页 radio 一致：单一事实来源 = availableLoginLevels。 */
export function canSwitchLoginLevel(): boolean {
  return (app().globalData.availableLoginLevels?.length || 0) > 1;
}
