// utils/auth.ts — 员工端登录与手机号绑定

import { callStaffApi, sanitizeErrorMessage } from './cloud';

/** 调用 auth.login，同步员工信息到 globalData */
export async function syncLogin(): Promise<void> {
  const app = getApp<IAppOption>();
  const data = await callStaffApi<{
    staffWfId: string;
    staffName: string;
    position: string;
    roles: string[];
    phone: string;
    boundStoreName: string;
    boundStoreId: string;
  }>('auth.login');
  app.setStaffInfo(data);
}

/** 绑定手机号（CloudID 安全解密方式） */
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
  await syncLogin();
}
