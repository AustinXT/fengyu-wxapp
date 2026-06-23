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
  const lv = getStaffLevel();
  return lv === 'headquarters' || lv === 'market';
}

export function canAccessStore(): boolean {
  const levels = app().globalData.availableLoginLevels || [];
  return levels.includes('store');
}

/**
 * 当前身份是否可执行门店店长操作。
 * - 门店店长（staffLevel='store_manager'）始终为真；
 * - 总部 / 市场 manager 切到门店模式后等同店长（管理层模式走独立 mgmt 导航，
 *   不暴露门店店长 UI，故用 loginLevel==='store' 收口）。
 * 与后端 requireManager 对齐：后端按 managerStoreIds 把高层 manager 精确限定到管辖门店。
 */
export function isManager(): boolean {
  if (getStaffLevel() === 'store_manager') return true;
  return getLoginLevel() === 'store' && hasRole('manager');
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
 * 与 isManager() 的区别：isManager() 基于 staffLevel（store_manager），与 roles 解耦；
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
