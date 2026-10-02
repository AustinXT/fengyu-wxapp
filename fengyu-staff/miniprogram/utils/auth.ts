// utils/auth.ts — 员工端登录与手机号绑定

import { callStaffApi, sanitizeErrorMessage } from './cloud';
import { getApiFnName } from './cloud-env';

interface LoginPayload {
  staffWfId: string;
  staffName: string;
  position: string;
  roles: string[];
  skills?: string[];
  phone: string;
  boundStoreName: string;
  boundStoreId: string;
  staffLevel?: StaffLevel;
  roleBindings?: RoleBinding[];
  availableLoginLevels?: LoginLevel[];
  scopedStores?: ScopedStore[];
  inventoryStoreIds?: string[];
  inventoryOperateStoreIds?: string[];
}

/** 把云函数返回的登录数据写入 globalData，并推导 loginLevel / currentStoreId */
function applyLoginPayload(data: LoginPayload): void {
  const app = getApp<IAppOption>();
  app.setStaffInfo(data);
  // loginLevel：若本地已有且在 available 内保留，否则取 available[0]
  const levels = data.availableLoginLevels || [];
  const existing = app.globalData.loginLevel;
  if (!existing || !levels.includes(existing)) {
    if (levels.length > 0) app.setLoginLevel(levels[0]);
  }
  // currentStoreId：若本地已有且在 scope 内保留，否则取第一个
  const scoped = data.scopedStores || [];
  const curr = app.globalData.currentStoreId;
  const inScope = !!curr && scoped.some((s) => s.storeId === curr);
  if (!inScope && scoped.length > 0) {
    app.setCurrentStoreId(scoped[0].storeId);
  }
}

/** 调用 auth.login，同步员工信息到 globalData */
export async function syncLogin(): Promise<void> {
  const data = await callStaffApi<LoginPayload>('auth.login');
  applyLoginPayload(data);
}

/** 绑定手机号（CloudID 安全解密方式）
 *  bindPhone 云函数已经返回完整的权限与门店数据（见 routes/auth.js::buildLevelPayload），
 *  直接复用，不再冗余调用 auth.login。
 */
export async function bindPhone(cloudID: string): Promise<void> {
  const res = await wx.cloud.callFunction({
    name: getApiFnName(),
    data: {
      action: 'auth.bindPhone',
      payload: {},
      phoneData: wx.cloud.CloudID(cloudID)
    }
  }) as any;
  if (res.result?.code !== 0) {
    throw new Error(sanitizeErrorMessage(res.result?.message, '手机号绑定失败'));
  }
  applyLoginPayload(res.result.data as LoginPayload);
}
