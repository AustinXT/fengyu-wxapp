// pages/checkout/checkout.ts
import Toast from '@vant/weapp/toast/toast';
import Dialog from '@vant/weapp/dialog/dialog';
import { clearCart } from '../../utils/cart';
import { callClientApi, bindPhoneWithCloudID } from '../../utils/cloud';
import { buildCouponDisplay, formatDate } from '../../utils/format';
import { getIsMember, priceView } from '../../utils/member-pricing';
import {
  recomputeAmounts,
  parseAgreement,
  DEFAULT_AGREEMENT_TEXT,
  normalizePointsDeductionMaxRate,
} from './checkout-helpers';

const app = getApp<IAppOption>();

interface CheckoutItem {
  skuId: string;
  spuName: string;
  skuDisplayName: string;
  coverImage: string;
  /** 成交价（会员价分流后：会员=会员价、非会员=标价） */
  price: number;
  /** 标价（划线展示用）；listPrice > price 才划线。可选——套餐/已存在订单项不带。 */
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
    // 若从员工端扫码进入，持有已有 orderNo
    existingOrderNo: '',
    // 购物车批量下单
    fromCart: false,
    cartItems: [] as CheckoutItem[],
    displayItems: [] as CheckoutItem[],
    // 组合套餐下单（service-detail bundle 流）
    bundleProductId: '',
    totalPrice: 0,
    quantity: 1,
    // 支付宝吱口令弹窗（聚合主扫 share_code 方案）
    showAlipayShare: false,
    alipayShareToken: '',
    alipayAmount: '0.00',
    alipayOrderNo: '',
    // 手机号绑定弹窗
    showPhoneBind: false,
    phoneBinding: false,
    // 绑定成功后延迟自动重提期间锁定提交入口，防止手点+定时器双触发重复下单
    autoResubmitPending: false,
    // 美容师选择
    staffList: [] as Staff[],
    showStaffPopup: false,
    // 促销方案
    orderType: 'normal' as string,
    // 优惠券
    selectedCoupon: null as null | { couponId: string; name: string; discount: number },
    couponDiscount: 0,
    showCouponPopup: false,
    availableCoupons: [] as any[],
    couponsLoading: false,
    // 储值卡抵扣（Wave 3E）
    cardBalance: 0,
    cardId: '' as string,
    useCard: true,                // 默认开（决策 #1）；余额 = 0 时 effectiveUseCard 自动 false
    // 积分抵扣
    pointsBalance: 0,
    usePoints: true,
    pointsUsed: 0,
    pointsDiscount: 0,
    maxPointsUsable: 0,
    pointsToYuanRate: 0.01,
    pointsDeductionMaxRate: 0.03,
    prepaidCardAmount: 0,         // 由 recomputeAmounts 派生
    // 取消支付后恢复既有订单时，锁定原 pending 金额；用户手动切换开关后清空，恢复常规重算。
    restoredPrepaidCardAmount: null as number | null,
    paidAmount: 0,                // 由 recomputeAmounts 派生
    showPayMethodGroup: true,     // 由 recomputeAmounts 派生：实付 > 0 才显示
    netBeforeCard: 0,             // 应抵扣部分（=总价-券），UI 显示用
    // 充值单分支：sale_order_type='充值单' 时隐藏商品/美容师/抵扣，只展示充值摘要
    isRecharge: false,
    // #214：本人是否持有活动中的支付意图（由 order.detail 下发，不含凭据）。
    // 为 true 时「去支付」跳过 scanAdjust —— 意图活跃期改抵扣有服务端守卫，
    // 不跳过这一步就会被拒，后面的 order.pay 根本执行不到。
    hasActivePaymentIntent: false,
    rechargeFaceValue: 0,
    rechargePayAmount: 0,
    rechargeBonus: 0,
    rechargeDiscountLabel: '',
    // 消费协议预览（点击《协议》懒加载 config.consumeAgreement，底部弹层滚动）
    showAgreement: false,
    agreementLoading: false,
    agreementLoaded: false,
    agreementTitle: '服务消费协议',
    agreementParas: [] as { text: string; heading: boolean }[],
  },

  onLoad(options) {
    const { skuId, productId, spuName, staffWfId, staffName, orderNo, saleOrderId, fromCart, quantity, orderType, bundleProductId } = options as Record<string, string>;
    const storeName = app.globalData.boundStoreName;

    // 加载美容师列表 + 默认美容师
    this.loadStaffList();
    this.loadDefaultStaff();
    // 加载储值卡余额（与门店无关，跨店可用；注意先于 recompute 生效）
    this.loadCardBalance();
    this.loadPointsBalance();

    const existingId = saleOrderId || orderNo;
    if (existingId) {
      // 场景 B：扫码收款，订单已存在
      this.setData({ existingOrderNo: existingId });
      this.loadExistingOrder(existingId);
    } else if (bundleProductId) {
      // 场景 D：组合套餐下单（service-detail 跳来，items 暂存 localStorage）
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
      // 场景 C：购物车批量下单
      const checkoutItems: CheckoutItem[] = wx.getStorageSync('checkoutItems') || [];
      if (checkoutItems.length === 0) {
        Toast.fail('无结算商品');
        setTimeout(() => wx.navigateBack(), 1000);
        return;
      }
      // 购物车缓存价（item.price）仅作占位先渲染；下方 repriceCartItems 会按当前会员身份
      // 向后端 product.skuDetail 重算每行单价，确保结算预览 = order.create 实际计费
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
      // 按当前会员身份向后端权威重算每行单价（覆盖购物车缓存里可能过期的会员价/标价）
      this.repriceCartItems(checkoutItems);
    } else {
      // 场景 A：自助下单
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
      // 会员价分流：会员→会员价、非会员→标价；与后端 order.create 权威定价同口径
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

  /**
   * 购物车批量下单：按当前会员身份向后端 product.skuDetail 重算每行单价，
   * 覆盖购物车缓存里可能过期的 price/listPrice（加购时旧会员身份或后台改过的会员价）。
   * 与 order.create 的 resolveUnitPrice 同口径（priceView，#6=B 体验卡亦按会员分流），确保预览 = 实扣。
   * 单行查询失败保留该行缓存价，不阻断结算。
   */
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
      // 整体重算失败不阻断结算：保持购物车缓存价
    }
  },

  async loadExistingOrder(saleOrderId: string) {
    try {
      const data = await callClientApi('order.detail', { saleOrderId });
      const order = data?.order || {};
      const items = data?.items || [];

      // 校验订单状态：仅待支付可进入结算
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
      const existingPointsUsed = Number(order.points_used || 0);
      const existingPointsDiscount = Number(order.points_discount || 0);
      // unitPrice 需为扣抵扣前金额，WXML/recompute 用 unitPrice - couponDiscount - pointsDiscount 计算实付
      const preDiscountTotal = Number(order.total_amount || 0) + existingCouponDiscount + existingPointsDiscount;
      // 还原支付方式（避免默认 wechat 覆盖用户原选）
      const validMethods = ['微信', '支付宝', '线下'] as const;
      const restoredMethod = validMethods.includes(order.payment_method) ? order.payment_method : '微信';

      // 充值单分支：精简摘要 + paidAmount 直接取 payable_amount，跳过抵扣/美容师/商品明细
      if (order.sale_order_type === '充值单') {
        const faceValue = Number(order.total_amount || 0);
        const payable = Number(order.payable_amount || 0);
        const bonus = Math.round((faceValue - payable) * 100) / 100;
        const discount = faceValue > 0 ? Math.round((payable / faceValue) * 100) / 100 : 1;
        const discountLabel = (discount * 10).toFixed(1).replace(/\.0$/, '') + ' 折';
        this.setData({
          hasActivePaymentIntent: order.has_active_payment_intent === true,
          isRecharge: true,
          spuName: '充值卡',
          storeName: order.store_name || '',
          paymentMethod: restoredMethod,
          rechargeFaceValue: faceValue,
          rechargePayAmount: payable,
          rechargeBonus: bonus,
          rechargeDiscountLabel: discountLabel,
          // 实付直接落 payable_amount；showPayMethodGroup 必须为 true 才能选支付方式
          paidAmount: payable,
          showPayMethodGroup: payable > 0,
          prepaidCardAmount: 0,
          pointsUsed: 0,
          pointsDiscount: 0,
          maxPointsUsable: 0,
          couponDiscount: 0,
          netBeforeCard: 0,
          // 充值单不需要协议勾选（充值说明已展示在 recharge 页 footer）
          agreed: true,
        });
        return;
      }

      // 尊重订单已有的抵扣状态：待支付阶段的预选值存在 pending_prepaid_card_amount，
      // 避免 UI 默认 useCard=true 与 DB 不一致——用户后续切换会通过 onSubmitOrder 的 scanAdjust 同步
      const orderPrepaidCardAmount = Number(
        order.pending_prepaid_card_amount || order.prepaid_card_amount || 0,
      );

      this.setData({
        // #214：本人是否持有活动中的支付意图（后端下发布尔，不含凭据）。
        // 为 true 时「去支付」要跳过 scanAdjust，否则会被服务端守卫拒掉、付不了款。
        hasActivePaymentIntent: order.has_active_payment_intent === true,
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
        pointsUsed: existingPointsUsed,
        pointsDiscount: existingPointsDiscount,
        maxPointsUsable: existingPointsUsed,
        usePoints: existingPointsUsed > 0,
        paymentMethod: restoredMethod,
        useCard: orderPrepaidCardAmount > 0,
        prepaidCardAmount: orderPrepaidCardAmount,
        restoredPrepaidCardAmount: orderPrepaidCardAmount > 0 ? orderPrepaidCardAmount : null,
        // 还原订单指定的美容师（覆盖 loadDefaultStaff 的并行竞态）
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
        // 优先展示派生身份（美容师/养生师），兜底用 position_name
        position: roleTag(s.skills) || s.position,
        avatarUrl: s.avatarUrl || '',
      }));
      this.setData({ staffList });
    } catch {
      // 美容师加载失败不影响主流程
    }
  },

  async loadDefaultStaff() {
    try {
      // 若 URL 已传入 staffWfId，不覆盖
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
      // 获取默认美容师失败不影响主流程
    }
  },

  /** 拉取储值卡余额，并按当前金额状态触发一次 recompute */
  async loadCardBalance() {
    try {
      const data = await callClientApi<{ balance: number; cardId: string | null }>(
        'card.balance', {}
      );
      const balance = Number(data?.balance) || 0;
      this.setData({
        cardBalance: balance,
        cardId: data?.cardId || '',
        // 余额 = 0 时强制关闭开关，避免 UI 出现"开关 on 但抵扣 0"的违和状态
        useCard: balance > 0 ? this.data.useCard : false,
      });
      this.recomputeAmounts();
    } catch {
      // 余额查询失败不阻断下单：保持 cardBalance=0、useCard=false
      this.setData({ cardBalance: 0, useCard: false });
      this.recomputeAmounts();
    }
  },

  /** 拉取积分余额与抵扣配置，并触发一次 recompute */
  async loadPointsBalance() {
    try {
      const data = await callClientApi<{
        balance: number;
        pointsToYuanRate?: number;
        pointsDeductionMaxRate?: number;
      }>('points.balance', {});
      const balance = Math.floor(Number(data?.balance) || 0);
      const isExistingOrder = !!this.data.existingOrderNo;
      this.setData({
        pointsBalance: balance,
        pointsToYuanRate: Number(data?.pointsToYuanRate) || 0.01,
        pointsDeductionMaxRate: normalizePointsDeductionMaxRate(data?.pointsDeductionMaxRate),
        usePoints: isExistingOrder ? this.data.usePoints : (balance > 0 ? this.data.usePoints : false),
      });
      this.recomputeAmounts();
    } catch {
      this.setData({
        pointsBalance: 0,
        usePoints: this.data.existingOrderNo ? this.data.usePoints : false,
      });
      this.recomputeAmounts();
    }
  },

  /** 根据当前 totalAmount/couponDiscount/cardBalance/useCard 重算抵扣明细 */
  recomputeAmounts() {
    // 充值单分支：paidAmount 已由 loadExistingOrder 写定为 payable_amount，不参与抵扣计算
    if (this.data.isRecharge) return;

    const totalAmount = this.data.fromCart
      ? Number(this.data.totalPrice) || 0
      : (Number(this.data.unitPrice) || 0) * (Number(this.data.quantity) || 1);
    if (this.data.existingOrderNo) {
      const netAfterDiscounts = Math.round(Math.max(
        0,
        totalAmount - (Number(this.data.couponDiscount) || 0) - (Number(this.data.pointsDiscount) || 0),
      ) * 100) / 100;
      const effectiveUseCard = this.data.useCard && this.data.cardBalance > 0 && netAfterDiscounts > 0;
      const prepaidCardAmount = effectiveUseCard
        ? Math.round(Math.min(Number(this.data.cardBalance) || 0, netAfterDiscounts) * 100) / 100
        : 0;
      const paidAmount = Math.round((netAfterDiscounts - prepaidCardAmount) * 100) / 100;
      this.setData({
        prepaidCardAmount,
        paidAmount,
        showPayMethodGroup: paidAmount > 0,
        netBeforeCard: netAfterDiscounts,
      });
      return;
    }
    const result = recomputeAmounts({
      totalAmount,
      couponDiscount: Number(this.data.couponDiscount) || 0,
      pointsBalance: Number(this.data.pointsBalance) || 0,
      usePoints: this.data.usePoints,
      pointsUsed: undefined,
      pointsToYuanRate: Number(this.data.pointsToYuanRate) || 0.01,
      pointsDeductionMaxRate: normalizePointsDeductionMaxRate(this.data.pointsDeductionMaxRate),
      cardBalance: Number(this.data.cardBalance) || 0,
      useCard: this.data.useCard,
      prepaidCardAmountLimit: this.data.restoredPrepaidCardAmount,
    });
    this.setData({
      prepaidCardAmount: result.prepaidCardAmount,
      pointsUsed: result.pointsUsed,
      pointsDiscount: result.pointsDiscount,
      maxPointsUsable: result.maxPointsUsable,
      paidAmount: result.paidAmount,
      showPayMethodGroup: result.showPayMethodGroup,
      netBeforeCard: result.netBeforeCard,
    });
  },

  /** 储值卡开关切换 */
  onToggleUseCard(e: WxEvent<boolean>) {
    // #214（round-14）：订单上已有活动支付意图时，抵扣方案已冻结在那笔渠道单里，
    // 且「去支付」会跳过 scanAdjust —— 放行拨动只会让顾客看到的金额和实际扣款不符。
    if (this.data.hasActivePaymentIntent) {
      wx.showToast({ title: '本次支付进行中，如需调整请先取消订单', icon: 'none' });
      return;
    }
    // 余额 = 0 时禁用：忽略 change 事件
    if (this.data.cardBalance <= 0) return;
    this.setData({
      useCard: !!e.detail,
      // 明确的用户操作代表重新选择方案；之后才允许按当前余额重新计算。
      restoredPrepaidCardAmount: null,
    });
    this.recomputeAmounts();
  },

  /** 积分开关切换 */
  onToggleUsePoints(e: WxEvent<boolean>) {
    if (this.data.pointsBalance <= 0 || this.data.maxPointsUsable <= 0 || this.data.existingOrderNo) return;
    this.setData({ usePoints: !!e.detail });
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

  // ===== 优惠券选择 =====

  async onSelectCoupon() {
    // 已有订单（扫码场景）不支持选券
    if (this.data.existingOrderNo) return;

    this.setData({ showCouponPopup: true, couponsLoading: true });
    try {
      // 构建 items 参数
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
      // expireAt 是 timestamp 列(UTC ISO)，用 formatDate 按设备本地(北京)取日期预格式化，
      // 避免 WXML 里 price.date() slice(0,10) 截 UTC 日期段跨午夜偏一天
      this.setData({
        availableCoupons: (data?.coupons || []).map((c: any) => ({
          ...c,
          expireAtFmt: formatDate(c.expireAt),
          ...buildCouponDisplay(c),
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
    // 首次打开懒加载协议，后续直接复用页面缓存
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
      // 接口异常用内置兜底文案，不阻塞下单
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

  /** 协议弹层底部「我已阅读并同意」：直接勾选 + 关闭 */
  onAgreeFromPopup() {
    this.setData({ agreed: true, showAgreement: false });
  },

  async onSubmitOrder() {
    if (!this.data.agreed) {
      Toast.fail('请先同意消费协议');
      return;
    }
    if (this.data.submitting || this.data.autoResubmitPending) return;

    // 自助下单须先绑定门店（扫码收款已有门店，跳过）；云函数也会兜底，前端先拦免一次往返
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

        // 充值单不参与储值卡抵扣（loadExistingOrder 已强制 useCard/prepaidCardAmount=0），
        // 跳过 scanAdjust 同步——避免改写订单 prepaid_card_amount
        let balanceSnapshot: { updatedAt?: string } | null = null;
        // #214（round-13）：订单上已有本人活动中的支付意图时，必须跳过 scanAdjust——
        // 意图活跃期改抵扣方案有服务端守卫，这一步会被 PAYMENT_INTENT_ACTIVE 拒掉，
        // 后面的 order.pay 根本执行不到，顾客从订单详情点「去支付」就永远付不了。
        // 抵扣方案此刻已经定死在那笔渠道单里，本来也不该改。
        const hasActiveIntent = this.data.hasActivePaymentIntent === true;
        if (!this.data.isRecharge && !hasActiveIntent) {
          // 把当前 UI 抵扣方案同步到 DB（confirmPrepaidFull / order.pay 读 DB 列计算 payable_amount）
          // paidAmount=0 时 paymentMethod 必须留空，后端会自动落 '无'
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
          // 全额储值卡抵扣：同事务扣 balance + 置已支付，不进任何第三方通道
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
          // 线下：余额需等店长 confirmOffline 后才到账，跳 order-detail 看"待支付"状态
          // （跳 prepaid-cards 会展示未更新的旧余额，造成"我刚充值怎么没到账"的困惑）
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

      // 自助下单
      const storeId = app.globalData.boundStoreId;

      // 构建订单项
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
        usePoints: this.data.usePoints && this.data.pointsUsed > 0,
        pointsUsed: this.data.usePoints && this.data.pointsUsed > 0 ? this.data.pointsUsed : undefined,
        useCard: this.data.useCard && this.data.cardBalance > 0,
        prepaidCardAmount: this.data.prepaidCardAmount,
      });

      const saleOrderId = data?.saleOrderId || data?.orderNo;
      if (!saleOrderId) throw new Error('创建订单失败');

      // 全额抵扣（券/卡）：后端已置 '已支付'，跳详情页不唤起支付
      const isPrepaidFull = data?.status === '已支付'
        || data?.reason === 'prepaid_card_full'
        || data?.reason === 'points_full'
        || data?.reason === 'coupon_full'
        || (data?.paymentParams === null && Number(data?.paidAmount || 0) === 0);
      if (isPrepaidFull) {
        if (this.data.fromCart) clearCart();
        if (this.data.bundleProductId) wx.removeStorageSync('bundleCheckoutItems');
        Toast.success(Number(data?.prepaidCardAmount || 0) > 0 ? '已使用储值卡支付' : (Number(data?.pointsDiscount || 0) > 0 ? '已使用积分抵扣' : '已使用优惠券抵扣'));
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
        // 登出态先免费 OPENID 恢复会话（同号老账号免消耗付费手机号验证），失败才弹付费授权
        if (app.isLoggedOut()) {
          const status = await app.syncLoginState(true);
          if (status === 'authenticated') {
            Toast.success('已恢复登录');
            // setTimeout 等 finally 释放 submitting 后再重试，避免撞提交守卫
            setTimeout(() => this.onSubmitOrder(), 0);
            return;
          }
        }
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
    if (this.data.phoneBinding) return;
    const { cloudID, errMsg } = e.detail;

    if (!cloudID) {
      if (errMsg?.includes('auth deny')) {
        Toast.fail('您拒绝了授权');
      }
      return;
    }

    this.setData({ phoneBinding: true });
    try {
      await bindPhoneWithCloudID(cloudID as string);
      this.setData({ showPhoneBind: false });

      Toast.success('绑定成功');
      // 绑定成功后自动重新提交订单；延迟窗口内锁住提交入口防手点+定时器双触发
      this.setData({ autoResubmitPending: true });
      setTimeout(() => {
        this.setData({ autoResubmitPending: false });
        this.onSubmitOrder();
      }, 800);
    } catch (err: any) {
      Toast.fail(err.message || '绑定失败，请重试');
    } finally {
      this.setData({ phoneBinding: false });
    }
  },

  async doAlipayPay(saleOrderId: string) {
    const data = await callClientApi<any>('order.alipayPay', { saleOrderId });
    // 防御性短路：后端识别为全额储值卡抵扣 → 直接跳详情页，不调任何第三方通道
    if (data?.status === '已支付' || data?.reason === 'prepaid_card_full') {
      Toast.success('已使用储值卡支付');
      setTimeout(() => wx.redirectTo({
        url: `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}`,
      }), 1200);
      return;
    }
    // 聚合主扫支付宝方案：后端串调 preorder(41) + share_code 返回吱口令
    // 前端弹"复制吱口令"popup，引导用户切到支付宝识别
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
    // 用户点"我已支付"：跳订单详情，订单状态由 payNotify 异步推进
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
    // 关闭弹窗但不跳转，用户可能改选其他支付方式
    this.setData({ showAlipayShare: false });
  },

  async doWechatPay(saleOrderId: string) {
    const data = await callClientApi<any>('order.pay', { saleOrderId });
    // 防御性短路：后端识别为全额储值卡抵扣（payable_amount=0）→ 直接跳详情页
    if (data?.status === '已支付' || data?.reason === 'prepaid_card_full') {
      Toast.success('已使用储值卡支付');
      setTimeout(() => wx.redirectTo({
        url: `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}`,
      }), 1200);
      return;
    }
    // 聚合主扫微信通道：直接拿 wx.requestPayment 5 字段（timeStamp/nonceStr/package/signType/paySign）
    const paymentParams = data?.paymentParams;
    if (!paymentParams || !paymentParams.paySign) {
      Toast.fail('支付参数获取失败');
      return;
    }
    const isRecharge = this.data.isRecharge;
    const detailUrl = `/pagesOrder/order-detail/order-detail?saleOrderId=${saleOrderId}`;
    // 支付成功后带 paid=1：触发 order-detail.confirmAndRefresh 主动轮询确认到账（对齐 scan-pay
    // 的 confirmAndRedirect）。payNotify 异步回调偶发丢失时，前端主动 queryTrade + 补偿入账，
    // 不再只靠 runPaymentReconcile 定时器（90s+）兜底。取消/封禁跳转用 detailUrl 不带 paid=1。
    const successUrl = isRecharge ? '/pagesProfile/prepaid-cards/prepaid-cards' : `${detailUrl}&paid=1`;
    try {
      await wx.requestPayment(paymentParams);
    } catch (err: any) {
      const errMsg = (err?.errMsg || '').toLowerCase();
      // 用户主动取消支付，跳订单详情（订单仍 '待支付'，可重新支付）
      if (errMsg.includes('cancel')) {
        wx.redirectTo({ url: detailUrl });
        return;
      }
      // 微信封禁/限制小程序支付能力（requestPayment:fail banned / 违反平台规则 /
      // no permission / access denied）：订单已创建并保留为待支付，明确引导改用支付宝
      // 或到店付款，而非笼统「下单失败」（订单其实已生成）。
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
