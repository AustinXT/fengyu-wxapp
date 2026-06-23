// packageOrder/card-inflow/card-inflow.ts — 旧系统充值金转入（店长）
import { callStaffApi } from '../../utils/cloud';
import { isManager, getCurrentStoreId } from '../../utils/role';

const app = getApp<IAppOption>();

interface CustomerInfo {
  id: string | null;
  clientUserId: string;
  customerNo?: string | null;
  name: string;
  phone: string;
  phoneMasked?: string;
  /** 顾客绑定门店 ID（customer.search 返回，判断是否本店） */
  boundStoreId?: string | null;
  /** 顾客绑定门店名（展示「非本店」标签用） */
  storeName?: string;
  /** 是否非本店顾客（boundStoreId 缺失时为 false，放行后端兜底） */
  crossStore?: boolean;
}

/** 标注一条顾客是否非本店（boundStoreId 缺失时返回 false，由后端兜底校验） */
function markCrossStore(c: CustomerInfo): CustomerInfo {
  return { ...c, crossStore: !!c.boundStoreId && c.boundStoreId !== getCurrentStoreId() };
}

interface InflowResponse {
  saleOrderId: string;
  amount: number;
  status: string;
}

/** 格式化小数（去尾 0） */
function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return (Math.round(n * 100) / 100).toString();
}

Page({
  data: {
    boundStoreName: '',
    boundStoreId: '',
    isManager: false, // 仅店长可提交转入

    // 顾客
    customerKeyword: '',
    customerSearching: false,
    customerInfo: null as CustomerInfo | null,
    customerResults: [] as CustomerInfo[],

    // 转入金额（自由输入：>0、≤2 位小数、无档位/无上限/不打折）
    amountInput: '',
    amountError: '',

    // 备注（可选，后端自动加「旧系统充值金转入」前缀）
    remark: '',

    // CTA
    ctaText: '请输入转入金额',
    ctaDisabled: true,
    submitting: false,
  },

  onLoad(query: Record<string, string>) {
    const storeId = app.globalData.boundStoreId || '';
    const storeName = app.globalData.boundStoreName || '';
    this.setData({ boundStoreId: storeId, boundStoreName: storeName, isManager: isManager() });

    // 可选：从 URL 参数预填顾客（如从顾客详情带入）
    if (query?.clientUserId && query?.customerName) {
      this.setData({
        customerInfo: markCrossStore({
          id: null,
          clientUserId: query.clientUserId,
          name: query.customerName,
          phone: query.customerPhone || '',
          phoneMasked: query.customerPhone ? query.customerPhone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '',
          boundStoreId: query.boundStoreId || null,
          storeName: query.storeName || '',
        }),
      });
      this.updateCta();
    }
  },

  onShow() {
    const storeId = app.globalData.boundStoreId || '';
    const storeName = app.globalData.boundStoreName || '';
    if (storeId !== this.data.boundStoreId || storeName !== this.data.boundStoreName) {
      this.setData({ boundStoreId: storeId, boundStoreName: storeName });
    }
  },

  // ============ 顾客选择（与 card-recharge 同口径：跨店统一）============

  onCustomerKeywordInput(e: WechatMiniprogram.CustomEvent) {
    const value = (e.detail as { value?: string })?.value || '';
    this.setData({ customerKeyword: value, customerResults: [] });
  },

  async onSearchCustomer() {
    const keyword = (this.data.customerKeyword || '').trim();
    if (!keyword || this.data.customerSearching) return;
    this.setData({ customerSearching: true });
    try {
      const results = await callStaffApi<CustomerInfo[]>('customer.search', { keyword, crossStore: true });
      const valid = (results || []).filter(r => r.clientUserId).map(markCrossStore);
      if (valid.length === 0) {
        this.setData({ customerInfo: null, customerResults: [] });
        wx.showModal({
          title: '顾客未绑定门店',
          content: '未找到已绑定本系统门店的顾客，请先引导顾客本人登录小程序并绑定门店后再转入。',
          showCancel: false,
          confirmColor: '#C0322A',
        });
      } else if (valid.length === 1) {
        this.setData({ customerInfo: valid[0], customerResults: [] });
        this.updateCta();
      } else {
        this.setData({ customerInfo: null, customerResults: valid });
      }
    } catch (err: any) {
      wx.showToast({ title: err?.message || '查询失败', icon: 'none' });
    } finally {
      this.setData({ customerSearching: false });
    }
  },

  onSelectCustomer(e: WechatMiniprogram.TouchEvent) {
    const customer = markCrossStore(e.currentTarget.dataset.customer as CustomerInfo);
    this.setData({ customerInfo: customer, customerResults: [] });
    this.updateCta();
  },

  onClearCustomer() {
    this.setData({ customerInfo: null, customerKeyword: '', customerResults: [] });
    this.updateCta();
  },

  // ============ 转入金额（自由输入：等额、不打折、不限档位/上限）============

  onAmountInput(e: WechatMiniprogram.CustomEvent) {
    const raw = ((e.detail as { value?: string })?.value || '').trim();
    let err = '';
    const n = Number(raw);
    if (raw) {
      if (!Number.isFinite(n) || n <= 0) err = '请输入有效金额';
      else if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) err = '最多保留 2 位小数';
    }
    this.setData({ amountInput: raw, amountError: err });
    this.updateCta();
  },

  onRemarkInput(e: WechatMiniprogram.CustomEvent) {
    this.setData({ remark: (e.detail as { value?: string })?.value || '' });
  },

  // ============ CTA ============

  updateCta() {
    const { customerInfo, amountInput, amountError } = this.data;
    if (!customerInfo) {
      this.setData({ ctaText: '请先选择顾客', ctaDisabled: true });
      return;
    }
    const n = Number(amountInput);
    if (!amountInput || amountError || !Number.isFinite(n) || n <= 0) {
      this.setData({ ctaText: '请输入转入金额', ctaDisabled: true });
      return;
    }
    this.setData({ ctaText: `确认转入 · ¥${formatAmount(n)}`, ctaDisabled: false });
  },

  // ============ 提交 ============

  async onSubmit() {
    if (this.data.submitting || this.data.ctaDisabled) return;
    // 统一店长权限网关：非店长不能提交转入
    if (!this.data.isManager) {
      wx.showToast({ title: '您无操作权限，请联系店长', icon: 'none', duration: 2500 });
      return;
    }
    const { customerInfo, amountInput, remark } = this.data;
    if (!customerInfo?.clientUserId) {
      wx.showToast({ title: '请选择顾客', icon: 'none' });
      return;
    }
    if (customerInfo.crossStore) {
      wx.showModal({
        title: '无法转入',
        content: `该顾客属于「${customerInfo.storeName || '其他'}」门店，非本店顾客无法转入。`,
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    const amount = Number(amountInput);
    if (!amount || amount <= 0) {
      wx.showToast({ title: '请输入转入金额', icon: 'none' });
      return;
    }

    // 资金敏感：二次确认
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '确认转入',
        content: `为顾客「${customerInfo.name || '未命名'}」转入旧系统充值金 ¥${formatAmount(amount)}，到账后即可消费。确认无误？`,
        confirmText: '确认转入',
        confirmColor: '#C0322A',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;

    this.setData({ submitting: true });
    try {
      const payload: Record<string, unknown> = {
        clientUserId: customerInfo.clientUserId,
        amount,
      };
      const trimmedRemark = (remark || '').trim();
      if (trimmedRemark) payload.remark = trimmedRemark;
      const res = await callStaffApi<InflowResponse>('card.inflow', payload);
      if (!res?.saleOrderId) throw new Error('转入失败');
      wx.showToast({ title: '转入成功', icon: 'success', duration: 800 });
      setTimeout(() => {
        wx.redirectTo({ url: `/packageOrder/order-detail/order-detail?id=${res.saleOrderId}` });
      }, 600);
    } catch (err: any) {
      const msg = (err?.message || '').replace(/^[A-Z_]+:\s*/, '');
      wx.showToast({ title: msg || '转入失败', icon: 'none' });
      this.setData({ submitting: false });
    }
  },
});
