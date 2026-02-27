// utils/role.ts — 角色判断

export function isManager(): boolean {
  return getApp<IAppOption>().globalData.position === '门店经理';
}

export function isBeautician(): boolean {
  const position = getApp<IAppOption>().globalData.position;
  return position !== '门店经理' && position !== '';
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
