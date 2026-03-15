// pagesOrder/service-records/service-records.ts
import Toast from '@vant/weapp/toast/toast';
import { formatDate, safeParseDate } from '../../utils/format';
import { callClientApi } from '../../utils/cloud';

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
    loadError: false,
    page: 1,
    hasMore: true,
  },

  onLoad() {
    this.loadRecords();
  },

  onPullDownRefresh() {
    this.setData({ page: 1, hasMore: true, records: [] });
    this.loadRecords().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.isLoading) return;
    this.loadRecords();
  },

  async loadRecords() {
    if (this.data.isLoading) return;
    this.setData({ isLoading: true, loadError: false });

    try {
      const data = await callClientApi('service.list', {
        page: this.data.page,
        pageSize: 20,
      });

      const newRecords = (data?.records || []).map((r: any) => ({
        ...r,
        dateFmt: formatDate(r.service_date),
        statusColor: getStatusColor(r.status),
        durationFmt: calcDuration(r),
        itemSummary: (r.items || []).map((i: any) => i.product_name || '未知项目').join('、'),
      }));

      const records = this.data.page === 1
        ? newRecords
        : [...this.data.records, ...newRecords];

      this.setData({
        records,
        page: this.data.page + 1,
        hasMore: newRecords.length >= 20,
      });
    } catch (err: any) {
      Toast.fail(err.message || '加载失败');
      this.setData({ loadError: true });
    } finally {
      this.setData({ isLoading: false });
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
