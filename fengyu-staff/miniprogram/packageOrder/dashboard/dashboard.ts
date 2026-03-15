// packageOrder/dashboard/dashboard.ts — 数据看板
import { callStaffApi } from '../../utils/cloud';
import { isManager } from '../../utils/role';

type RangeType = 'today' | 'month' | 'lastMonth';

interface DashboardData {
  footfall: number;
  headcount: number;
  revenue: number;
  consume: number;
  newMembers: number;
}

Page({
  data: {
    loading: false,
    isManager: false,
    rangeType: 'today' as RangeType,
    displayDate: '',
    // 5 项核心指标
    footfall: 0,
    headcount: 0,
    revenue: '0.00',
    consume: '0.00',
    newMembers: 0,
  },

  onLoad() {
    this.setData({ isManager: isManager() });
    this.setRange('today');
  },

  onShow() {
    // 回到页面时用当前选中的时间范围刷新
    if (this.data.rangeType) {
      this.setRange(this.data.rangeType);
    }
  },

  setRange(type: RangeType) {
    const now = new Date();
    let start: string, end: string, display: string;

    if (type === 'today') {
      start = end = this.fmt(now);
      display = `今日 ${start}`;
    } else if (type === 'month') {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      start = this.fmt(first);
      end = this.fmt(now);
      display = `${now.getFullYear()}年${now.getMonth() + 1}月`;
    } else {
      // lastMonth
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
      start = this.fmt(lastMonth);
      end = this.fmt(lastMonthEnd);
      display = `${lastMonth.getFullYear()}年${lastMonth.getMonth() + 1}月`;
    }

    this.setData({ rangeType: type, displayDate: display });
    this.loadDashboard(start, end);
  },

  onRangeTap(e: WechatMiniprogram.TouchEvent) {
    this.setRange(e.currentTarget.dataset.type as RangeType);
  },

  async loadDashboard(startDate: string, endDate: string) {
    this.setData({ loading: true });
    try {
      const data = await callStaffApi<DashboardData>('staff.dashboard', { startDate, endDate });
      this.setData({
        footfall: data.footfall || 0,
        headcount: data.headcount || 0,
        revenue: (data.revenue || 0).toFixed(2),
        consume: (data.consume || 0).toFixed(2),
        newMembers: data.newMembers || 0,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  fmt(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
});
