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
 * 当前身份是否为门店店长
 * 语义变化：原基于 roles.includes('manager')；新基于归并后的 staffLevel。
 * 对单店店长等价；对"HQ admin + 门店 manager"组合会判为 headquarters，不再走店长分支。
 */
export function isManager(): boolean {
  return getStaffLevel() === 'store_manager';
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
