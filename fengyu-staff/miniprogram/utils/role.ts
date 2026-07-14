

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
  
  
  return lv === 'headquarters' || lv === 'market' || lv === 'store_manager';
}

export function canAccessStore(): boolean {
  const levels = app().globalData.availableLoginLevels || [];
  return levels.includes('store');
}


export function isManager(): boolean {
  if (getStaffLevel() === 'store_manager') return true;
  return getLoginLevel() === 'store' && hasRole('manager');
}


export function isBeautician(): boolean {
  return getStaffLevel() === 'store_staff';
}


export function hasRole(...roleNames: string[]): boolean {
  const roles = app().globalData.roles ?? [];
  return roleNames.some(r => roles.includes(r));
}


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


export function getCurrentStoreId(): string {
  const g = app().globalData;
  if (g.loginLevel === 'management') return '';
  return g.currentStoreId || g.boundStoreId || '';
}


export function canSwitchLoginLevel(): boolean {
  return (app().globalData.availableLoginLevels?.length || 0) > 1;
}
