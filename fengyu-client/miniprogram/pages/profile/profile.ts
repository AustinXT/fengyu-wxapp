// pages/profile/profile.ts
import { maskPhone } from '../../utils/format';
import { callClientApi } from '../../utils/cloud';
import { APP_VERSION } from '../../utils/version';

const app = getApp<IAppOption>();

Page({
  data: {
    userName: '',
    maskedPhone: '',
    memberLevel: '',
    boundStoreName: '',
    avatarUrl: '',
    unreadCount: 0,
    appVersion: APP_VERSION,
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

  onMemberBenefits() {
    wx.navigateTo({ url: '/pagesProfile/member-benefits/member-benefits' });
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
