import Toast from '@vant/weapp/toast/toast';
import { callClientApi } from '../../utils/cloud';
import { formatDate } from '../../utils/format';

interface HomeProduct {
  saleItemId: string;
  saleItemGroupId?: string | null;
  saleOrderId: string;
  productName: string;
  unit: string;
  purchasedQuantity: number;
  paidQuantity: number;
  pickedQuantity: number;
  refundedQuantity: number;
  remainingQuantity: number;
  pendingPickupQuantity: number;
  /** 行级欠款；仅 refundedQuantity=0 时有值，退过款的行为 null（received 是净实收，相减会虚增欠款） */
  unpaidAmount: number | null;
  status: string;
  storeId: string;
  storeName: string | null;
  purchasedAt: string;
  purchasedAtFmt?: string;
  statusClass?: string;
  unpaidAmountFmt?: string;
}

Page({
  data: {
    products: [] as HomeProduct[],
    isLoading: false,
    loadError: false,
    hasLoaded: false,
  },

  onLoad() {
    this.loadProducts();
  },

  onShow() {
    if (!this.data.isLoading && this.data.hasLoaded) {
      this.loadProducts();
    }
  },

  onPullDownRefresh() {
    this.loadProducts().finally(() => wx.stopPullDownRefresh());
  },

  async loadProducts() {
    if (this.data.isLoading) return;
    this.setData({ isLoading: true, loadError: false });
    try {
      const data = await callClientApi<{ items: HomeProduct[] }>('order.homeProducts', {});
      const statusClassMap: Record<string, string> = {
        退款处理中: 'pending',
        待提货: 'pending',
        部分提货: 'progress',
        已提货: 'success',
        已完成: 'done',
        待付清: 'pending',
      };
      this.setData({
        products: (data?.items || []).map((item) => ({
          ...item,
          purchasedAtFmt: item.purchasedAt ? formatDate(item.purchasedAt) : '',
          statusClass: statusClassMap[item.status] || 'done',
          // 仅未付清的行展示欠款；寄存单/退过款的行后端下发 null，留空由 wxml 判显隐。
          // 小程序 toLocaleString 不可靠（ICU 精简），千分位用 toFixed + 正则。
          unpaidAmountFmt:
            item.unpaidAmount != null && Number(item.unpaidAmount) > 0
              ? Number(item.unpaidAmount)
                  .toFixed(2)
                  .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
              : '',
        })),
      });
    } catch (_) {
      Toast.fail('加载失败');
      this.setData({ loadError: true });
    } finally {
      this.setData({ isLoading: false, hasLoaded: true });
    }
  },
});
