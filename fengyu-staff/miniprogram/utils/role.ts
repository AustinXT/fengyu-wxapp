// utils/role.ts — 角色判断

export function isManager(): boolean {
  return getApp<IAppOption>().globalData.role === 'manager';
}

export function isBeautician(): boolean {
  return getApp<IAppOption>().globalData.role === 'beautician';
}

export function requireManager(tipMsg = '该操作仅限店长'): boolean {
  if (!isManager()) {
    wx.showToast({ title: tipMsg, icon: 'none' });
    return false;
  }
  return true;
}

export function getStaffWfId(): string {
  return getApp<IAppOption>().globalData.staffWfId;
}
