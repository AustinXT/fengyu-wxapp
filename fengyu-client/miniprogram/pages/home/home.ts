// pages/home/home.ts
import Toast from '@vant/weapp/toast/toast';

const app = getApp<IAppOption>();

interface Banner {
  id: string;
  title: string;
  desc: string;
  bgColor: string;
  link: string;
}

interface TcCard {
  orderNo: string;
  itemFlowNo: string;
  spuName: string;
  skuDisplayName: string;
  sessionCount: number;
  remainingSessions: number;
  percent: number;
  expireFmt: string;
}

interface HotItem {
  spu_id: string;
  name: string;
  category: string;
  big_category: string;
  cover_image: string;
  priceFrom: number;
}

Page({
  data: {
    boundStoreName: '',
    isLoggedIn: false,
    banners: [
      { id: '1', title: '新客专享', desc: '首次体验仅需68元', bgColor: 'linear-gradient(135deg, #1A1A1A 0%, #2D2D2D 100%)', link: '' },
      { id: '2', title: '面部护理季', desc: '补水保湿套餐优惠中', bgColor: 'linear-gradient(135deg, #D4A76A 0%, #B8935A 100%)', link: '' },
    ] as Banner[],
    currentBanner: 0,
    tcLoading: false,
    tcCards: [] as TcCard[],
    hotLoading: false,
    hotList: [] as HotItem[],
  },

  onLoad() {
    const storeName = app.globalData.boundStoreName || '';
    const userId = app.globalData.userId || '';
    this.setData({
      boundStoreName: storeName,
      isLoggedIn: !!userId,
    });

    if (storeName) {
      this.loadHotList();
    }
  },

  onShow() {
    const storeName = app.globalData.boundStoreName || '';
    const userId = app.globalData.userId || '';
    const storeChanged = storeName !== this.data.boundStoreName;
    const loginChanged = !!userId !== this.data.isLoggedIn;

    this.setData({
      boundStoreName: storeName,
      isLoggedIn: !!userId,
    });

    if (storeName) {
      if (storeChanged) {
        this.loadHotList();
      }
      if (this.data.isLoggedIn) {
        this.loadTreatmentCards();
      }
    }
  },

  onPullDownRefresh() {
    Promise.all([
      this.data.isLoggedIn ? this.loadTreatmentCards() : Promise.resolve(),
      this.loadHotList(),
    ]).finally(() => wx.stopPullDownRefresh());
  },

  // 加载热门推荐
  async loadHotList() {
    this.setData({ hotLoading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'clientApi',
        data: {
          action: 'product.hotList',
          payload: { limit: 6 },
        },
      }) as any;
      const hotList: HotItem[] = res.result?.data?.spuList || [];
      this.setData({
        hotList: hotList.map((item: any) => ({
          ...item,
          priceFrom: item.priceFrom ? Math.floor(item.priceFrom) : 0,
        })),
      });
    } catch (err) {
      console.error('loadHotList error:', err);
    } finally {
      this.setData({ hotLoading: false });
    }
  },

  // 加载疗程卡
  async loadTreatmentCards() {
    this.setData({ tcLoading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'clientApi',
        data: { action: 'order.appointableItems', payload: {} },
      }) as any;
      const orders: any[] = res.result?.data?.orders || [];

      const cards: TcCard[] = [];
      for (const order of orders) {
        for (const item of order.items) {
          const percent = item.sessionCount > 0
            ? Math.round(((item.sessionCount - item.remainingSessions) / item.sessionCount) * 100)
            : 0;
          cards.push({
            orderNo: order.orderNo,
            itemFlowNo: item.itemFlowNo,
            spuName: item.spuName,
            skuDisplayName: item.skuDisplayName,
            sessionCount: item.sessionCount,
            remainingSessions: item.remainingSessions,
            percent,
            expireFmt: item.expireDate ? item.expireDate.slice(0, 10) : '',
          });
        }
      }

      // 只显示前 5 张疗程卡
      this.setData({ tcCards: cards.slice(0, 5) });
    } catch (err) {
      console.error('loadTreatmentCards error:', err);
    } finally {
      this.setData({ tcLoading: false });
    }
  },

  // ===== 事件处理 =====

  onSelectStore() {
    wx.navigateTo({ url: '/pages/store-select/store-select' });
  },

  onScanPay() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (res) => {
        // 小程序码扫描结果在 res.path 中（含 scene 参数）
        if (res.path) {
          wx.navigateTo({ url: '/' + res.path });
        } else if (res.result) {
          // 普通二维码，result 可能是 orderNo
          wx.navigateTo({ url: `/pages/scan-pay/scan-pay?orderNo=${encodeURIComponent(res.result)}` });
        }
      },
      fail: () => {
        // 用户取消扫码，不提示
      },
    });
  },

  onBannerChange(e: WechatMiniprogram.CustomEvent<number>) {
    this.setData({ currentBanner: e.detail.current });
  },

  onBannerTap(e: WechatMiniprogram.TouchEvent) {
    const url = e.currentTarget.dataset.url;
    if (url) {
      // TODO: 处理跳转
    }
  },

  onLoginTap() {
    // TODO: 跳转到登录流程
    wx.showToast({ title: '请先绑定手机号', icon: 'none' });
  },

  onViewAllCards() {
    wx.navigateTo({ url: '/pages/treatment-cards/treatment-cards' });
  },

  onBrowseServices() {
    wx.switchTab({ url: '/pages/shop/shop' });
  },

  onBookAppointment() {
    wx.switchTab({ url: '/pages/appointment/appointment' });
  },

  onViewAllServices() {
    wx.switchTab({ url: '/pages/shop/shop' });
  },

  onCardTap(e: WechatMiniprogram.TouchEvent) {
    const { orderNo } = e.currentTarget.dataset as { orderNo: string };
    wx.navigateTo({ url: `/pages/order-detail/order-detail?orderNo=${orderNo}` });
  },

  onBookTap(e: WechatMiniprogram.TouchEvent) {
    const { orderNo } = e.currentTarget.dataset as { orderNo: string };
    wx.navigateTo({ url: `/pages/appointment-create/appointment-create?orderNo=${orderNo}` });
  },

  onSpuTap(e: WechatMiniprogram.TouchEvent) {
    const { spuId } = e.currentTarget.dataset as { spuId: string };
    wx.navigateTo({ url: `/pages/service-detail/service-detail?spuId=${spuId}` });
  },
});
