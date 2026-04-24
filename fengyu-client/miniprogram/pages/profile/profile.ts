// pages/profile/profile.ts
import Toast from '@vant/weapp/toast/toast';
import { maskPhone } from '../../utils/format';
import { callClientApi, bindPhoneWithCloudID } from '../../utils/cloud';

const app = getApp<IAppOption>();

Page({
  data: {
    userName: '',
    maskedPhone: '',
    memberLevel: '',
    boundStoreName: '',
    avatarUrl: '',
    unreadCount: 0,
  },

  onLoad() {
    this.refreshData();
  },

  onShow() {
    this.refreshData();
    this.loadUnreadCount();
  },

  refreshData() {
    const phone = wx.getStorageSync('phone') as string || '';
    const userName = wx.getStorageSync('userName') as string || '';
    const avatarUrl = wx.getStorageSync('avatarUrl') as string || '';
    const memberLevel = wx.getStorageSync('memberLevel') as string || '';
    this.setData({
      userName,
      maskedPhone: maskPhone(phone),
      memberLevel,
      boundStoreName: app.globalData.boundStoreName,
      avatarUrl,
    });
  },

  onEditProfile() {
    wx.navigateTo({ url: '/pagesProfile/profile-edit/profile-edit' });
  },

  onOrders() {
    wx.navigateTo({ url: '/pagesOrder/orders/orders' });
  },

  onOrdersByStatus(e: WechatMiniprogram.TouchEvent) {
    const { status } = e.currentTarget.dataset as { status: string };
    wx.navigateTo({ url: `/pagesOrder/orders/orders?status=${encodeURIComponent(status)}` });
  },

  onTreatmentCards() {
    wx.navigateTo({ url: '/pagesOrder/treatment-cards/treatment-cards' });
  },

  onAppointments() {
    wx.switchTab({ url: '/pages/appointment/appointment' });
  },

  onCoupons() {
    wx.navigateTo({ url: '/pagesCoupon/my-coupons/my-coupons' });
  },

  onServiceRecords() {
    wx.navigateTo({ url: '/pagesOrder/service-records/service-records' });
  },

  async loadUnreadCount() {
    try {
      const data = await callClientApi<{ count: number }>('message.unreadCount', {});
      this.setData({ unreadCount: data?.count || 0 });
    } catch (_err) {
      // silently fail for unread count
    }
  },

  onPoints() {
    wx.navigateTo({ url: '/pagesProfile/points/points' });
  },

  onMessages() {
    wx.navigateTo({ url: '/pagesProfile/messages/messages' });
  },

  onPrepaidCards() {
    wx.navigateTo({ url: '/pagesProfile/prepaid-cards/prepaid-cards' });
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
        Toast.fail('您拒绝了授权');
      } else if (errMsg) {
        Toast.fail(errMsg);
      }
      return;
    }

    try {
      const { updatedOrdersCount } = await bindPhoneWithCloudID(cloudID as string);
      this.refreshData();

      const tips = updatedOrdersCount > 0
        ? `已同步 ${updatedOrdersCount} 笔历史订单`
        : '';

      Toast.success(tips || '绑定成功');

    } catch (err: any) {
      console.error('绑定手机号失败:', err);
      Toast.fail(err.message || '绑定失败，请重试');
    }
  },

  onSwitchStore() {
    wx.navigateTo({ url: '/pagesStore/store-select/store-select' });
  },

  onAbout() {
    wx.switchTab({ url: '/pages/cart/cart' });
  },

  onCallService() {
    wx.makePhoneCall({
      phoneNumber: '400-000-0000',
      fail: () => {},
    });
  },

  onShareAppMessage() {
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return { title: '凤御美容', path: `/pages/home/home${invSuffix}` };
  },
});
