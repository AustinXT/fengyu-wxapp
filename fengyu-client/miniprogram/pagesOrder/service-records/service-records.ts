// pagesOrder/service-records/service-records.ts
import Toast from '@vant/weapp/toast/toast';
import { formatDate, safeParseDate } from '../../utils/format';
import { callClientApi } from '../../utils/cloud';

const PAGE_SIZE = 20;

interface ServiceRecord {
  service_order_id: string;
  status: string;
  service_date: string;
  store_name: string;
  employee_name: string;
  started_at: string;
  completed_at: string;
  items: Array<{
    product_name: string;
    sku_spec_name: string;
    session_used: number;
    service_duration: number;
  }>;
  // 格式化后的字段
  dateFmt: string;
  statusColor: string;
  durationFmt: string;
  itemSummary: string;
}

Page({
  data: {
    records: [] as ServiceRecord[],
    isLoading: false,
    loadingMore: false,
    loadError: false,
    hasMore: true,
  },

  _page: 1,

  onLoad() {
    this.loadRecords();
  },

  onPullDownRefresh() {
    this.loadRecords().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore && !this.data.isLoading) {
      this.loadMore();
    }
  },

  _mapRecords(raw: any[]): ServiceRecord[] {
    return raw.map((r: any) => ({
      ...r,
      dateFmt: formatDate(r.service_date),
      statusColor: getStatusColor(r.status),
      durationFmt: calcDuration(r),
      itemSummary: (r.items || []).map((i: any) => i.product_name || '未知项目').join('、'),
    }));
  },

  /** 加载首页（重置分页） */
  async loadRecords() {
    this._page = 1;
    this.setData({ isLoading: true, loadError: false, hasMore: true });
    try {
      const data = await callClientApi('service.list', {
        page: 1,
        pageSize: PAGE_SIZE,
      });
      const newRecords = this._mapRecords(data?.records || []);
      this.setData({
        records: newRecords,
        hasMore: newRecords.length === PAGE_SIZE,
      });
    } catch (err: any) {
      Toast.fail(err.message || '加载失败');
      this.setData({ loadError: true });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  /** 加载更多（追加，错误不覆盖已有数据） */
  async loadMore() {
    this._page += 1;
    this.setData({ loadingMore: true });
    try {
      const data = await callClientApi('service.list', {
        page: this._page,
        pageSize: PAGE_SIZE,
      });
      const newRecords = this._mapRecords(data?.records || []);
      this.setData({
        records: [...this.data.records, ...newRecords],
        hasMore: newRecords.length === PAGE_SIZE,
      });
    } catch {
      this._page -= 1;
      Toast.fail('加载更多失败');
    } finally {
      this.setData({ loadingMore: false });
    }
  },

  onTapRecord(_e: WechatMiniprogram.TouchEvent) {
    // 服务记录为只读卡片，详情信息已在列表中展示
  },
});

function getStatusColor(status: string): string {
  switch (status) {
    case '待服务': return '#D48806';
    case '服务中': return '#096DD9';
    case '已完成': return '#389E0D';
    case '已取消': return '#8C8C8C';
    default: return '#8C8C8C';
  }
}

function calcDuration(record: any): string {
  if (record.started_at && record.completed_at) {
    const start = safeParseDate(record.started_at)?.getTime() ?? 0;
    const end = safeParseDate(record.completed_at)?.getTime() ?? 0;
    const mins = Math.round((end - start) / 60000);
    if (mins > 0) return `${mins}分钟`;
  }
  // 从 items 中累计 service_duration
  const items = record.items || [];
  const total = items.reduce((sum: number, i: any) => sum + (i.service_duration || 0), 0);
  return total > 0 ? `${total}分钟` : '';
}
