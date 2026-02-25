// pages/profile/profile.ts
import Toast from '@vant/weapp/toast/toast';

const app = getApp<IAppOption>();

function maskPhone(phone: string): string {
  if (!phone || phone.length < 7) return phone;
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}

Page({
  data: {
    maskedPhone: '',
    boundStoreName: '',
  },

  onLoad() {
    this.refreshData();
  },

  onShow() {
    this.refreshData();
  },

  refreshData() {
    const phone = wx.getStorageSync('phone') as string || '';
    this.setData({
      maskedPhone: maskPhone(phone),
      boundStoreName: app.globalData.boundStoreName,
    });
  },

  onOrders() {
    wx.navigateTo({ url: '/pages/orders/orders' });
  },

  onTreatmentCards() {
    wx.navigateTo({ url: '/pages/treatment-cards/treatment-cards' });
  },

  onBindPhone() {
    // 已废弃，改用 onGetPhoneNumber 通过 button open-type 实现
    wx.showToast({ title: '功能开发中', icon: 'none' });
  },

  /**
   * 处理微信手机号授权
   * 使用 CloudID 方式，云函数自动解密
   */
  async onGetPhoneNumber(e: WechatMiniprogram.TouchEvent) {
    const { cloudID, errMsg } = e.detail;

    // 用户拒绝授权
    if (!cloudID) {
      if (errMsg?.includes('auth deny')) {
        wx.showToast({ title: '您拒绝了授权', icon: 'none' });
      } else if (errMsg) {
        wx.showToast({ title: errMsg, icon: 'none' });
      }
      return;
    }

    try {
      wx.showLoading({ title: '绑定中...', mask: true });

      // 调用云函数绑定手机号，传入 CloudID
      const res = await wx.cloud.callFunction({
        name: 'clientApi',
        data: {
          action: 'auth.bindPhone',
          payload: {},
          phoneData: wx.cloud.CloudID(cloudID as string)
        }
      }) as any;

      wx.hideLoading();

      if (res.result?.code !== 0) {
        throw new Error(res.result?.message || '绑定失败');
      }

      const { phone } = res.result.data;

      // 更新本地存储
      wx.setStorageSync('phone', phone);

      // 刷新页面数据
      this.refreshData();

      const tips = res.result.data.updatedOrdersCount > 0
        ? `已同步 ${res.result.data.updatedOrdersCount} 笔历史订单`
        : '';

      wx.showToast({
        title: tips || '绑定成功',
        icon: 'success',
        duration: 2000
      });

    } catch (err: any) {
      wx.hideLoading();
      console.error('绑定手机号失败:', err);
      wx.showToast({
        title: err.message || '绑定失败，请重试',
        icon: 'none',
        duration: 2000
      });
    }
  },

  onSwitchStore() {
    wx.navigateTo({ url: '/pages/store-select/store-select' });
  },

  onShareAppMessage() {
    return { title: '凤御美容', path: '/pages/home/home' };
  },
});
