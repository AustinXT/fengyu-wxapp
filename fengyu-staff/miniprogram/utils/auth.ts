

import { callStaffApi, sanitizeErrorMessage } from './cloud';

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
}


function applyLoginPayload(data: LoginPayload): void {
  const app = getApp<IAppOption>();
  app.setStaffInfo(data);
  
  const levels = data.availableLoginLevels || [];
  const existing = app.globalData.loginLevel;
  if (!existing || !levels.includes(existing)) {
    if (levels.length > 0) app.setLoginLevel(levels[0]);
  }
  
  const scoped = data.scopedStores || [];
  const curr = app.globalData.currentStoreId;
  const inScope = !!curr && scoped.some((s) => s.storeId === curr);
  if (!inScope && scoped.length > 0) {
    app.setCurrentStoreId(scoped[0].storeId);
  }
}


export async function syncLogin(): Promise<void> {
  const data = await callStaffApi<LoginPayload>('auth.login');
  applyLoginPayload(data);
}


export async function bindPhone(cloudID: string): Promise<void> {
  const res = await wx.cloud.callFunction({
    name: 'staffApi',
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
