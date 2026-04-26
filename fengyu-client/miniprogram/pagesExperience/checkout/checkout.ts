// pagesExperience/checkout/checkout.ts — 体验卡独立下单页（严格独立：固定 1 张/单，不读商城 cart）
import Toast from '@vant/weapp/toast/toast';
import Dialog from '@vant/weapp/dialog/dialog';
import { callClientApi, bindPhoneWithCloudID } from '../../utils/cloud';

const app = getApp<IAppOption>();

Page({
  data: {
    skuId: '',
    spuName: '',
    skuDisplayName: '',
    coverImage: '',
    unitPrice: 0,
    storeName: '',
    paymentMethod: '微信' as '微信',
    agreed: false,
    submitting: false,
    isLoading: true,
    // 手机绑定
    showPhoneBind: false,
  },

  onLoad(options) {
    const { skuId, spuName } = options as Record<string, string>;
    if (!skuId) {
      Toast.fail('缺少体验卡参数');
      setTimeout(() => wx.navigateBack(), 1000);
      return;
    }
    this.setData({
      skuId,
      spuName: decodeURIComponent(spuName || ''),
      storeName: app.globalData.boundStoreName || '',
    });
    this.loadSkuDetail(skuId);
  },

  async loadSkuDetail(skuId: string) {
    this.setData({ isLoading: true });
    try {
      const data = await callClientApi<{ sku: any }>('product.skuDetail', { skuId });
      const sku = data?.sku;
      if (!sku) {
        throw new Error('体验卡不存在');
      }
      // 防御性校验：服务端体验卡 SKU 入口已限定 is_experience=true，但前端再兜底一次
      // 防止外部 url 直传非体验卡 skuId 进入此 checkout 走错快照
      const isExp = sku.is_experience === true || sku.isExperience === true;
      if (sku.is_experience !== undefined && !isExp) {
        Toast.fail('该商品不是体验卡');
        setTimeout(() => wx.navigateBack(), 1200);
        return;
      }
      const unitPrice = Number(sku.special_price || sku.price || 0);
      this.setData({
        skuDisplayName: sku.spec_name || '',
        coverImage: sku.cover_image || '',
        unitPrice,
        spuName: this.data.spuName || sku.product_name || sku.spec_name || '体验卡',
      });
    } catch (err: any) {
      console.error('loadSkuDetail error:', err);
      Toast.fail(err?.message || '加载失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onPayMethodChange(e: WxEvent<string>) {
    this.setData({ paymentMethod: e.detail as '微信' });
  },

  onPayMethodTap(e: WechatMiniprogram.TouchEvent) {
    const { method } = e.currentTarget.dataset as { method: '微信' };
    this.setData({ paymentMethod: method });
  },

  onAgreementChange(e: WxEvent<boolean>) {
    this.setData({ agreed: e.detail });
  },

  onViewAgreement() {
    wx.showModal({
      title: '体验卡服务协议',
      content: '体验卡为新人专享福利，仅限本人到店使用，购买后不支持退款，逾期作废。详情请到店咨询。',
      showCancel: false,
    });
  },

  async onSubmitOrder() {
    if (!this.data.agreed) {
      Toast.fail('请先同意体验卡服务协议');
      return;
    }
    if (this.data.submitting) return;
    if (!this.data.skuId) {
      Toast.fail('体验卡参数错误');
      return;
    }

    const storeId = app.globalData.boundStoreId;
    if (!storeId) {
      Dialog.confirm({
        title: '请先绑定门店',
        message: '体验卡需绑定门店后到店核销',
        confirmButtonText: '去绑定',
        cancelButtonText: '取消',
      }).then(() => {
        wx.navigateTo({ url: '/pagesStore/store-select/store-select' });
      }).catch(() => {});
      return;
    }

    this.setData({ submitting: true });

    try {
      // 严格独立：仅 1 张体验卡，不传 useCard / coupon / fromCart / cartItems
      const data = await callClientApi<any>('order.create', {
        storeId,
        items: [{ skuId: this.data.skuId, quantity: 1 }],
        paymentMethod: this.data.paymentMethod,
      });

      const saleOrderId = data?.saleOrderId || data?.orderNo;
      if (!saleOrderId) throw new Error('创建订单失败');

      // 微信支付
      await this.doWechatPay(saleOrderId);
    } catch (err: any) {
      if (err?.errorType === 'PHONE_REQUIRED') {
        this.setData({ showPhoneBind: true });
      } else if (err?.data?.pendingOrderNo) {
        const pendingId = err.data.pendingOrderNo;
        Dialog.confirm({
          title: '您有待支付订单',
          message: '请先完成支付或取消订单后再下单',
          confirmButtonText: '去支付',
          cancelButtonText: '我知道了',
        }).then(() => {
          wx.navigateTo({
            url: `/pagesOrder/order-detail/order-detail?saleOrderId=${pendingId}`,
          });
        }).catch(() => {});
      } else {
        Toast.fail(err?.message || '下单失败，请重试');
      }
    } finally {
      this.setData({ submitting: false });
    }
  },

  async doWechatPay(saleOrderId: string) {
    const data = await callClientApi('order.pay', { saleOrderId });
    const paymentParams = data?.paymentParams || {};
    try {
      await wx.requestPayment(paymentParams);
    } catch (payErr: any) {
      if ((payErr?.errMsg || '').toLowerCase().includes('cancel')) {
        // 用户取消支付：跳详情页（订单仍待支付）
        wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}` });
        return;
      }
      throw payErr;
    }
    Toast.success('支付成功');
    setTimeout(
      () => wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}` }),
      1200
    );
  },

  onClosePhoneBind() {
    this.setData({ showPhoneBind: false });
  },

  async onGetPhoneNumber(e: WechatMiniprogram.CustomEvent<{ cloudID?: string; errMsg?: string }>) {
    const { cloudID, errMsg } = e.detail;
    if (!cloudID) {
      if (errMsg?.includes('auth deny')) Toast.fail('您拒绝了授权');
      return;
    }
    try {
      await bindPhoneWithCloudID(cloudID);
      this.setData({ showPhoneBind: false });
      Toast.success('绑定成功');
      setTimeout(() => this.onSubmitOrder(), 800);
    } catch (err: any) {
      Toast.fail(err?.message || '绑定失败，请重试');
    }
  },

  onShareAppMessage() {
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return {
      title: this.data.spuName || '凤御体验卡',
      path: `/pages/home/home${invSuffix}`,
    };
  },
});
