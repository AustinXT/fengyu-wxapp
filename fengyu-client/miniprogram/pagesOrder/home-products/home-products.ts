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
  pickedQuantity: number;
  refundedQuantity: number;
  remainingQuantity: number;
  status: string;
  storeId: string;
  storeName: string | null;
  purchasedAt: string;
  purchasedAtFmt?: string;
  statusClass?: string;
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
      };
      this.setData({
        products: (data?.items || []).map((item) => ({
          ...item,
          purchasedAtFmt: item.purchasedAt ? formatDate(item.purchasedAt) : '',
          statusClass: statusClassMap[item.status] || 'done',
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
