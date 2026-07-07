
import Toast from '@vant/weapp/toast/toast';
import Dialog from '@vant/weapp/dialog/dialog';
import { clearCart } from '../../utils/cart';
import { callClientApi, bindPhoneWithCloudID } from '../../utils/cloud';
import { formatDate } from '../../utils/format';
import { getIsMember, priceView } from '../../utils/member-pricing';
import { recomputeAmounts, parseAgreement, DEFAULT_AGREEMENT_TEXT } from './checkout-helpers';

const app = getApp<IAppOption>();

interface CheckoutItem {
  skuId: string;
  spuName: string;
  skuDisplayName: string;
  coverImage: string;
  
  price: number;
  
  listPrice?: number;
  quantity: number;
}

interface Staff {
  employee_id: string;
  name: string;
  position: string;
  avatarUrl?: string;
}

Page({
  data: {
    spuName: '',
    skuId: '',
    skuDisplayName: '',
    unitPrice: 0,
    staffWfId: '',
    staffName: '',
    staffAvatarUrl: '',
    storeName: '',
    paymentMethod: '微信' as '微信' | '支付宝' | '线下',
    agreed: false,
    submitting: false,
    
    existingOrderNo: '',
    
    fromCart: false,
    cartItems: [] as CheckoutItem[],
    displayItems: [] as CheckoutItem[],
    
    bundleProductId: '',
    totalPrice: 0,
    quantity: 1,
    
    showAlipayShare: false,
    alipayShareToken: '',
    alipayAmount: '0.00',
    alipayOrderNo: '',
    
    showPhoneBind: false,
    
    staffList: [] as Staff[],
    showStaffPopup: false,
    
    orderType: 'normal' as string,
    
    selectedCoupon: null as null | { couponId: string; name: string; discount: number },
    couponDiscount: 0,
    showCouponPopup: false,
    availableCoupons: [] as any[],
    couponsLoading: false,
    
    cardBalance: 0,
    cardId: '' as string,
    useCard: true,                
    prepaidCardAmount: 0,         
    paidAmount: 0,                
    showPayMethodGroup: true,     
    netBeforeCard: 0,             
    
    isRecharge: false,
    rechargeFaceValue: 0,
    rechargePayAmount: 0,
    rechargeBonus: 0,
    rechargeDiscountLabel: '',
    
    showAgreement: false,
    agreementLoading: false,
    agreementLoaded: false,
    agreementTitle: '服务消费协议',
    agreementParas: [] as { text: string; heading: boolean }[],
  },

  onLoad(options) {
    const { skuId, productId, spuName, staffWfId, staffName, orderNo, saleOrderId, fromCart, quantity, orderType, bundleProductId } = options as Record<string, string>;
    const storeName = app.globalData.boundStoreName;

    
    this.loadStaffList();
    this.loadDefaultStaff();
    
    this.loadCardBalance();

    const existingId = saleOrderId || orderNo;
    if (existingId) {
      
      this.setData({ existingOrderNo: existingId });
      this.loadExistingOrder(existingId);
    } else if (bundleProductId) {
      
      const bundleItems: CheckoutItem[] = wx.getStorageSync('bundleCheckoutItems') || [];
      if (bundleItems.length === 0) {
        Toast.fail('无套餐商品');
        setTimeout(() => wx.navigateBack(), 1000);
        return;
      }
      const total = Math.round(bundleItems.reduce((s, i) => s + i.price * i.quantity, 0) * 100) / 100;
      const decodedSpuName = decodeURIComponent(spuName || '');
      this.setData({
        bundleProductId,
        cartItems: bundleItems,
        displayItems: bundleItems,
        spuName: decodedSpuName,
        skuDisplayName: bundleItems.map(i => i.skuDisplayName).join('、'),
        unitPrice: total,
        totalPrice: total,
        storeName,
        staffWfId: staffWfId || '',
        staffName: decodeURIComponent(staffName || ''),
        quantity: 1,
      });
      this.recomputeAmounts();
    } else if (fromCart === '1') {
      
      const checkoutItems: CheckoutItem[] = wx.getStorageSync('checkoutItems') || [];
      if (checkoutItems.length === 0) {
        Toast.fail('无结算商品');
        setTimeout(() => wx.navigateBack(), 1000);
        return;
      }
      
      
      const total = Math.round(checkoutItems.reduce((s, i) => s + i.price * i.quantity, 0) * 100) / 100;
      this.setData({
        fromCart: true,
        cartItems: checkoutItems,
        displayItems: checkoutItems,
        spuName: checkoutItems.length === 1 ? checkoutItems[0].spuName : `${checkoutItems.length} 件商品`,
        skuDisplayName: checkoutItems.length === 1 ? checkoutItems[0].skuDisplayName : checkoutItems.map(i => i.spuName).join('、'),
        unitPrice: total,
        totalPrice: total,
        storeName,
      });
      this.recomputeAmounts();
      
      this.repriceCartItems(checkoutItems);
    } else {
      
      const qty = parseInt(quantity, 10) || 1;
      this.loadSkuPrice(skuId, qty, productId);
      this.setData({
        skuId: skuId || '',
        spuName: decodeURIComponent(spuName || ''),
        staffWfId: staffWfId || '',
        staffName: decodeURIComponent(staffName || ''),
        storeName,
        quantity: qty,
        orderType: orderType || 'normal',
      });
    }
  },

  async loadSkuPrice(skuId: string, quantity: number = 1, productId?: string) {
    try {
      const data = await callClientApi('product.skuDetail', { skuId, productId });
      const sku = data?.sku;
      
      const pv = priceView(getIsMember(), sku?.special_price, sku?.price);
      const unitPrice = pv.display;
      this.setData({
        skuDisplayName: sku?.spec_name || '',
        unitPrice,
        totalPrice: Math.round(unitPrice * quantity * 100) / 100,
        displayItems: [{
          skuId,
          spuName: this.data.spuName,
          skuDisplayName: sku?.spec_name || '',
          coverImage: sku?.cover_image || '',
          price: unitPrice,
          listPrice: pv.strike ?? unitPrice,
          quantity,
        }],
      });
      this.recomputeAmounts();
    } catch {
      Toast.fail('加载价格失败');
    }
  },

  
  async repriceCartItems(items: CheckoutItem[]) {
    try {
      const member = getIsMember();
      const repriced = await Promise.all(items.map(async (item) => {
        try {
          const data = await callClientApi('product.skuDetail', { skuId: item.skuId });
          const sku = (data as { sku?: { special_price?: number | null; price?: number | null } })?.sku;
          if (!sku) return item;
          const pv = priceView(member, sku.special_price, sku.price);
          return { ...item, price: pv.display, listPrice: pv.strike ?? pv.display };
        } catch {
          return item;
        }
      }));
      const total = Math.round(repriced.reduce((s, i) => s + i.price * i.quantity, 0) * 100) / 100;
      this.setData({
        cartItems: repriced,
        displayItems: repriced,
        unitPrice: total,
        totalPrice: total,
      });
      this.recomputeAmounts();
    } catch {
      
    }
  },

  async loadExistingOrder(saleOrderId: string) {
    try {
      const data = await callClientApi('order.detail', { saleOrderId });
      const order = data?.order || {};
      const items = data?.items || [];

      
      if (order.status && order.status !== '待支付') {
        const msgMap: Record<string, string> = {
          '已关闭': '订单已超时关闭',
          '已支付': '订单已完成支付',
          '已完成': '订单已完成',
          '支付失败': '订单支付失败，请联系店员',
        };
        Toast.fail(msgMap[order.status] || `订单状态：${order.status}`);
        setTimeout(() => {
          wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}` });
        }, 1500);
        return;
      }

      const firstItem = items[0] || {};
      const existingCouponDiscount = Number(order.coupon_discount || 0);
      
      const preDiscountTotal = Number(order.total_amount || 0) + existingCouponDiscount;
      
      const validMethods = ['微信', '支付宝', '线下'] as const;
      const restoredMethod = validMethods.includes(order.payment_method) ? order.payment_method : '微信';

      
      if (order.sale_order_type === '充值单') {
        const faceValue = Number(order.total_amount || 0);
        const payable = Number(order.payable_amount || 0);
        const bonus = Math.round((faceValue - payable) * 100) / 100;
        const discount = faceValue > 0 ? Math.round((payable / faceValue) * 100) / 100 : 1;
        const discountLabel = (discount * 10).toFixed(1).replace(/\.0$/, '') + ' 折';
        this.setData({
          isRecharge: true,
          spuName: '充值卡',
          storeName: order.store_name || '',
          paymentMethod: restoredMethod,
          rechargeFaceValue: faceValue,
          rechargePayAmount: payable,
          rechargeBonus: bonus,
          rechargeDiscountLabel: discountLabel,
          
          paidAmount: payable,
          showPayMethodGroup: payable > 0,
          prepaidCardAmount: 0,
          couponDiscount: 0,
          netBeforeCard: 0,
          
          agreed: true,
        });
        return;
      }

      
      
      const orderPrepaidCardAmount = Number(order.prepaid_card_amount || 0);

      this.setData({
        spuName: items.length > 1
          ? `${items.length} 件商品`
          : (firstItem.product_name || ''),
        skuDisplayName: items.length > 1
          ? items.map((i: any) => i.product_name).join('、')
          : (firstItem.product_name || ''),
        unitPrice: preDiscountTotal,
        storeName: order.store_name || '',
        quantity: 1,
        couponDiscount: existingCouponDiscount,
        paymentMethod: restoredMethod,
        useCard: orderPrepaidCardAmount > 0,
        
        staffWfId: order.preferred_employee_id || '',
        staffName: order.preferred_staff_name || '',
        displayItems: items.map((i: any) => ({
          skuId: i.sale_item_id || '',
          spuName: i.product_name || '',
          skuDisplayName: i.product_name || '',
          coverImage: i.cover_image || '',
          price: Number(i.unit_price || 0),
          quantity: Number(i.quantity || 1),
        })),
      });
      this.recomputeAmounts();
    } catch {
      Toast.fail('加载订单信息失败');
    }
  },

  async loadStaffList() {
    try {
      const storeId = app.globalData.boundStoreId;
      if (!storeId) return;
      const data = await callClientApi('staff.list', { storeId });
      const roleTag = (skills?: string[]) => (skills || []).filter((s) => s === '美容师' || s === '养生师').join('/');
      const staffList: Staff[] = (data?.staffList || []).map((s: any) => ({
        employee_id: s.staff_id,
        name: s.name,
        
        position: roleTag(s.skills) || s.position,
        avatarUrl: s.avatarUrl || '',
      }));
      this.setData({ staffList });
    } catch {
      
    }
  },

  async loadDefaultStaff() {
    try {
      
      if (this.data.staffWfId) return;
      const data = await callClientApi<{
        mainStaffId: string | null;
        mainStaffName: string | null;
        mainStaffAvatarUrl: string | null;
      }>('staff.default', {});
      if (data?.mainStaffId) {
        this.setData({
          staffWfId: data.mainStaffId,
          staffName: data.mainStaffName || '',
          staffAvatarUrl: data.mainStaffAvatarUrl || '',
        });
      }
    } catch {
      
    }
  },

  
  async loadCardBalance() {
    try {
      const data = await callClientApi<{ balance: number; cardId: string | null }>(
        'card.balance', {}
      );
      const balance = Number(data?.balance) || 0;
      this.setData({
        cardBalance: balance,
        cardId: data?.cardId || '',
        
        useCard: balance > 0 ? this.data.useCard : false,
      });
      this.recomputeAmounts();
    } catch {
      
      this.setData({ cardBalance: 0, useCard: false });
      this.recomputeAmounts();
    }
  },

  
  recomputeAmounts() {
    
    if (this.data.isRecharge) return;

    const totalAmount = this.data.fromCart
      ? Number(this.data.totalPrice) || 0
      : (Number(this.data.unitPrice) || 0) * (Number(this.data.quantity) || 1);
    const result = recomputeAmounts({
      totalAmount,
      couponDiscount: Number(this.data.couponDiscount) || 0,
      cardBalance: Number(this.data.cardBalance) || 0,
      useCard: this.data.useCard,
    });
    this.setData({
      prepaidCardAmount: result.prepaidCardAmount,
      paidAmount: result.paidAmount,
      showPayMethodGroup: result.showPayMethodGroup,
      netBeforeCard: result.netBeforeCard,
    });
  },

  
  onToggleUseCard(e: WxEvent<boolean>) {
    
    if (this.data.cardBalance <= 0) return;
    this.setData({ useCard: !!e.detail });
    this.recomputeAmounts();
  },

  onSelectStaff() {
    this.setData({ showStaffPopup: true });
  },

  onCloseStaffPopup() {
    this.setData({ showStaffPopup: false });
  },

  onStaffSelect(e: WechatMiniprogram.CustomEvent<{ wfId: string; name: string }>) {
    const { wfId, name } = e.detail;
    const matched = this.data.staffList.find((s) => s.employee_id === wfId);
    this.setData({
      staffWfId: wfId,
      staffName: name,
      staffAvatarUrl: matched?.avatarUrl || '',
      showStaffPopup: false,
    });
  },

  

  async onSelectCoupon() {
    
    if (this.data.existingOrderNo) return;

    this.setData({ showCouponPopup: true, couponsLoading: true });
    try {
      
      let items: { skuId: string; quantity: number; amount: number }[];
      if (this.data.fromCart || this.data.bundleProductId) {
        items = this.data.cartItems.map(i => ({
          skuId: i.skuId,
          quantity: i.quantity,
          amount: i.price * i.quantity,
        }));
      } else {
        const price = Number(this.data.unitPrice) || 0;
        items = [{ skuId: this.data.skuId, quantity: this.data.quantity, amount: price * this.data.quantity }];
      }

      const data = await callClientApi('coupon.available', {
        storeId: app.globalData.boundStoreId,
        items,
      });
      
      
      this.setData({
        availableCoupons: (data?.coupons || []).map((c: any) => ({
          ...c,
          expireAtFmt: formatDate(c.expireAt),
        })),
      });
    } catch {
      this.setData({ availableCoupons: [] });
    } finally {
      this.setData({ couponsLoading: false });
    }
  },

  onCloseCouponPopup() {
    this.setData({ showCouponPopup: false });
  },

  onCouponPick(e: WechatMiniprogram.TouchEvent) {
    const { couponId, name, discount } = e.currentTarget.dataset as {
      couponId: string; name: string; discount: number;
    };
    const d = Number(discount) || 0;
    this.setData({
      selectedCoupon: { couponId, name, discount: d },
      couponDiscount: d,
      showCouponPopup: false,
    });
    this.recomputeAmounts();
  },

  onClearCoupon() {
    this.setData({
      selectedCoupon: null,
      couponDiscount: 0,
      showCouponPopup: false,
    });
    this.recomputeAmounts();
  },

  onAgreementChange(e: WxEvent<boolean>) {
    this.setData({ agreed: e.detail });
  },

  onPayMethodChange(e: WxEvent<string>) {
    this.setData({ paymentMethod: e.detail as '微信' | '支付宝' | '线下' });
  },

  onPayMethodTap(e: WechatMiniprogram.TouchEvent) {
    const { method } = e.currentTarget.dataset as { method: '微信' | '支付宝' | '线下' };
    this.setData({ paymentMethod: method });
  },

  async onViewAgreement() {
    this.setData({ showAgreement: true });
    
    if (this.data.agreementLoaded) return;
    this.setData({ agreementLoading: true });
    try {
      const data = await callClientApi<{ title?: string; content?: string }>(
        'config.consumeAgreement', {}
      );
      const title = (data?.title || '').trim() || '服务消费协议';
      const content = (data?.content || '').trim() || DEFAULT_AGREEMENT_TEXT;
      this.setData({
        agreementTitle: title,
        agreementParas: parseAgreement(content),
        agreementLoaded: true,
      });
    } catch {
      
      this.setData({
        agreementParas: parseAgreement(DEFAULT_AGREEMENT_TEXT),
        agreementLoaded: true,
      });
    } finally {
      this.setData({ agreementLoading: false });
    }
  },

  onCloseAgreement() {
    this.setData({ showAgreement: false });
  },

  
  onAgreeFromPopup() {
    this.setData({ agreed: true, showAgreement: false });
  },

  async onSubmitOrder() {
    if (!this.data.agreed) {
      Toast.fail('请先同意消费协议');
      return;
    }
    if (this.data.submitting) return;

    
    if (!this.data.existingOrderNo && !app.globalData.boundStoreId) {
      Toast('请先绑定门店');
      Dialog.confirm({
        title: '请先绑定门店',
        message: '下单需绑定门店，便于后续到店核销',
        confirmButtonText: '去绑定',
        cancelButtonText: '取消',
      }).then(() => {
        wx.navigateTo({ url: '/pagesStore/store-select/store-select' });
      }).catch(() => {});
      return;
    }

    this.setData({ submitting: true });

    try {
      if (this.data.existingOrderNo) {
        const existingId = this.data.existingOrderNo;
        const useCard = this.data.useCard && this.data.cardBalance > 0;
        const prepaidCardAmount = useCard ? Number(this.data.prepaidCardAmount) || 0 : 0;
        const paidAmount = Number(this.data.paidAmount) || 0;

        
        
        let balanceSnapshot: { updatedAt?: string } | null = null;
        if (!this.data.isRecharge) {
          
          
          const adjustRes = await callClientApi<{ balanceSnapshot?: { updatedAt?: string } | null }>(
            'order.scanAdjust',
            {
              saleOrderId: existingId,
              useCard,
              prepaidCardAmount,
              paymentMethod: paidAmount === 0 ? undefined : this.data.paymentMethod,
            }
          );
          balanceSnapshot = adjustRes?.balanceSnapshot || null;
        }

        if (paidAmount === 0 && prepaidCardAmount > 0) {
          
          await callClientApi('order.confirmPrepaidFull', {
            saleOrderId: existingId,
            expectedBalanceUpdatedAt: balanceSnapshot?.updatedAt,
          });
          Toast.success('已使用储值卡支付');
          setTimeout(() => wx.redirectTo({
            url: `/pagesOrder/order-detail/order-detail?saleOrderId=${existingId}`,
          }), 1200);
          return;
        }

        if (this.data.paymentMethod === '线下') {
          
          
          await callClientApi('order.offlinePay', { saleOrderId: existingId });
          Toast.success('已选择线下支付，请到店付款');
          setTimeout(() => {
            if (this.data.isRecharge) {
              wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${existingId}` });
            } else {
              wx.navigateBack();
            }
          }, 1500);
          return;
        }

        if (this.data.paymentMethod === '支付宝') {
          await this.doAlipayPay(existingId);
          return;
        }

        if (this.data.paymentMethod === '微信') {
          await this.doWechatPay(existingId);
          return;
        }
      }

      
      const storeId = app.globalData.boundStoreId;

      
      let items: { skuId: string; quantity: number }[];
      if (this.data.fromCart || this.data.bundleProductId) {
        items = this.data.cartItems.map(i => ({ skuId: i.skuId, quantity: i.quantity }));
      } else {
        items = [{ skuId: this.data.skuId, quantity: this.data.quantity }];
      }

      const data = await callClientApi<any>('order.create', {
        storeId,
        items,
        bundleProductId: this.data.bundleProductId || undefined,
        preferredStaffWfId: this.data.staffWfId || null,
        paymentMethod: this.data.paymentMethod,
        orderType: this.data.orderType !== 'normal' ? this.data.orderType : undefined,
        couponId: this.data.selectedCoupon?.couponId || undefined,
        useCard: this.data.useCard && this.data.cardBalance > 0,
        prepaidCardAmount: this.data.prepaidCardAmount,
      });

      const saleOrderId = data?.saleOrderId || data?.orderNo;
      if (!saleOrderId) throw new Error('创建订单失败');

      
      const isPrepaidFull = data?.status === '已支付'
        || data?.reason === 'prepaid_card_full'
        || data?.reason === 'coupon_full'
        || (data?.paymentParams === null && Number(data?.paidAmount || 0) === 0);
      if (isPrepaidFull) {
        if (this.data.fromCart) clearCart();
        if (this.data.bundleProductId) wx.removeStorageSync('bundleCheckoutItems');
        Toast.success(Number(data?.prepaidCardAmount || 0) > 0 ? '已使用储值卡支付' : '已使用优惠券抵扣');
        setTimeout(() => wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}` }), 1200);
        return;
      }

      if (this.data.paymentMethod === '线下') {
        if (this.data.fromCart) clearCart();
        if (this.data.bundleProductId) wx.removeStorageSync('bundleCheckoutItems');
        Toast.success('已提交，等待店长确认收款');
        setTimeout(() => wx.redirectTo({ url: `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}` }), 1500);
      } else if (this.data.paymentMethod === '支付宝') {
        if (this.data.fromCart) clearCart();
        if (this.data.bundleProductId) wx.removeStorageSync('bundleCheckoutItems');
        await this.doAlipayPay(saleOrderId);
      } else {
        await this.doWechatPay(saleOrderId);
        if (this.data.fromCart) clearCart();
        if (this.data.bundleProductId) wx.removeStorageSync('bundleCheckoutItems');
      }
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

  onClosePhoneBind() {
    this.setData({ showPhoneBind: false });
  },

  async onGetPhoneNumber(e: WechatMiniprogram.TouchEvent) {
    const { cloudID, errMsg } = e.detail;

    if (!cloudID) {
      if (errMsg?.includes('auth deny')) {
        Toast.fail('您拒绝了授权');
      }
      return;
    }

    try {
      await bindPhoneWithCloudID(cloudID as string);
      this.setData({ showPhoneBind: false });

      Toast.success('绑定成功');
      
      setTimeout(() => this.onSubmitOrder(), 800);
    } catch (err: any) {
      Toast.fail(err.message || '绑定失败，请重试');
    }
  },

  async doAlipayPay(saleOrderId: string) {
    const data = await callClientApi<any>('order.alipayPay', { saleOrderId });
    
    if (data?.status === '已支付' || data?.reason === 'prepaid_card_full') {
      Toast.success('已使用储值卡支付');
      setTimeout(() => wx.redirectTo({
        url: `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}`,
      }), 1200);
      return;
    }
    
    
    const shareToken = data?.alipayShareToken;
    if (!shareToken) {
      Toast.fail('支付宝吱口令获取失败');
      return;
    }
    const displayAmount = this.data.isRecharge
      ? Number(data?.paidAmount || 0)
      : Number(data?.totalAmount || 0);
    this.setData({
      showAlipayShare: true,
      alipayShareToken: shareToken,
      alipayAmount: displayAmount.toFixed(2),
      alipayOrderNo: saleOrderId,
    });
  },

  onAlipayShareCopy() {
    const token: string = this.data.alipayShareToken;
    if (!token) return;
    wx.setClipboardData({
      data: token,
      success: () => Toast.success('吱口令已复制，请打开支付宝粘贴'),
      fail: () => Toast.fail('复制失败'),
    });
  },

  onAlipayShareDone() {
    
    const saleOrderId = this.data.alipayOrderNo;
    const isRecharge = this.data.isRecharge;
    this.setData({ showAlipayShare: false });
    wx.redirectTo({
      url: isRecharge
        ? '/pagesProfile/prepaid-cards/prepaid-cards'
        : `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}`,
    });
  },

  onAlipayShareClose() {
    
    this.setData({ showAlipayShare: false });
  },

  async doWechatPay(saleOrderId: string) {
    const data = await callClientApi<any>('order.pay', { saleOrderId });
    
    if (data?.status === '已支付' || data?.reason === 'prepaid_card_full') {
      Toast.success('已使用储值卡支付');
      setTimeout(() => wx.redirectTo({
        url: `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}`,
      }), 1200);
      return;
    }
    
    const paymentParams = data?.paymentParams;
    if (!paymentParams || !paymentParams.paySign) {
      Toast.fail('支付参数获取失败');
      return;
    }
    const isRecharge = this.data.isRecharge;
    const detailUrl = `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}`;
    
    
    
    const successUrl = isRecharge ? '/pagesProfile/prepaid-cards/prepaid-cards' : `${detailUrl}&paid=1`;
    try {
      await wx.requestPayment(paymentParams);
    } catch (err: any) {
      const errMsg = (err?.errMsg || '').toLowerCase();
      
      if (errMsg.includes('cancel')) {
        wx.redirectTo({ url: detailUrl });
        return;
      }
      
      
      
      if (['banned', 'platform rules', 'violated', '违规', '违反', 'no permission', 'access denied']
        .some((kw) => errMsg.includes(kw))) {
        wx.showModal({
          title: '微信支付暂不可用',
          content: '当前微信支付能力受限，订单已为你保留。可在订单详情取消后改用支付宝，或选择到店付款。',
          showCancel: false,
          confirmText: '查看订单',
          success: () => wx.redirectTo({ url: detailUrl }),
        });
        return;
      }
      throw err;
    }
    Toast.success(isRecharge ? '充值成功' : '支付成功');
    setTimeout(() => wx.redirectTo({ url: successUrl }), 1200);
  },

  onShareAppMessage() {
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return { title: '凤御美容', path: `/pages/home/home${invSuffix}` };
  },
});
