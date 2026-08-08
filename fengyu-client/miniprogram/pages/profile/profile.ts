// pages/profile/profile.ts
import { maskPhone } from '../../utils/format';
import { callClientApi } from '../../utils/cloud';
import { APP_VERSION } from '../../utils/version';
import { ORDERS_ENTRY_ENABLED } from '../../utils/feature-flags';
import { getMemberLevelBadgeClass } from '../../utils/member-level-badge';

const app = getApp<IAppOption>();

Page({
  data: {
    userName: '',
    maskedPhone: '',
    memberLevel: '',
    memberLevelBadgeClass: 'member-level-badge--default',
    boundStoreName: '',
    avatarUrl: '',
    unreadCount: 0,
    appVersion: APP_VERSION,
    isLoggedOut: false,
    // 临时开关：订单主动查看入口（业务平稳后恢复）。见 utils/feature-flags.ts
    ordersEntryEnabled: ORDERS_ENTRY_ENABLED,
    // 客服热线（admin 系统配置 → 基础配置下发；空串时 wxml 显示占位「-」并禁用拨号）
    servicePhone: '',
  },

  onLoad() {
    this.refreshData();
    // 客服热线几乎不变，onLoad 拉一次即可（profile 作为 tab 页 onLoad 全生命周期仅触发一次）
    this.loadServicePhone();
  },

  async onShow() {
    // 个人中心是顾客查看会员等级/资料的入口：每次进入都从后端同步最新会员态，
    // 经 app.setMemberFlag 刷新 storage('isMember')/memberLevel，供商城与服务详情会员价分流
    // （开通会员后立即生效，不必杀进程重启小程序）。
    await app.syncLoginState();
    this.refreshData();
    if (app.isLoggedOut()) {
      this.setData({ unreadCount: 0 });
      return;
    }
    this.loadUnreadCount();
  },

  refreshData() {
    const isLoggedOut = app.isLoggedOut();
    const phone = isLoggedOut ? '' : (wx.getStorageSync('phone') as string || '');
    const userName = isLoggedOut ? '' : (wx.getStorageSync('userName') as string || '');
    const avatarUrl = isLoggedOut ? '' : (wx.getStorageSync('avatarUrl') as string || '');
    const memberLevel = isLoggedOut ? '' : (wx.getStorageSync('memberLevel') as string || '');
    this.setData({
      userName,
      maskedPhone: maskPhone(phone),
      memberLevel,
      memberLevelBadgeClass: getMemberLevelBadgeClass(memberLevel),
      boundStoreName: isLoggedOut ? '' : app.globalData.boundStoreName,
      avatarUrl,
      isLoggedOut,
    });
  },

  onEditProfile() {
    wx.navigateTo({ url: '/pagesProfile/profile-edit/profile-edit' });
  },

  async onLogout() {
    const res = await wx.showModal({
      title: '退出登录',
      content: '退出后将清除本机的手机号、昵称、头像、会员与门店信息，需要时可重新登录。',
      cancelText: '取消',
      confirmText: '退出',
      confirmColor: '#C0322A',
    });
    if (!res.confirm) return;

    app.clearLoginState();
    this.refreshData();
    this.setData({ unreadCount: 0 });
    wx.showToast({ title: '已退出', icon: 'success' });
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

  async loadServicePhone() {
    try {
      const data = await callClientApi<{ phone: string }>('config.serviceHotline', {});
      this.setData({ servicePhone: data?.phone || '' });
    } catch (_err) {
      // 静默失败：保留占位「-」，不阻塞页面
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
    const phone = this.data.servicePhone;
    if (!phone) {
      wx.showToast({ title: '客服热线未配置', icon: 'none' });
      return;
    }
    wx.makePhoneCall({
      phoneNumber: phone,
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
