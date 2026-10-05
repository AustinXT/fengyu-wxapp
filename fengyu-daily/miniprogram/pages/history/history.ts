import { callApi, showError, Report, Management } from "../../utils/cloud";
interface Period { id: string; name: string; start: string; end: string }
Page({
  data: { reports: [] as Report[], loading: false, ready: false, own: true,
    employeeId: '', employee: null as { name: string; position_name?: string; store_name?: string } | null,
    periods: [] as Period[], periodIndex: 0, summary: null as Management['summary'] | null },
  onLoad(options: Record<string, string | undefined>) { this.setData({ employeeId: options.employeeId || '' }); },
  onShow() { void this.load(); },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true, ready: false });
    try {
      if (!this.data.periods.length) {
        const data = await callApi<{ periods: Period[]; period: Period | null }>('period.list');
        this.setData({ periods: data.periods, periodIndex: Math.max(0, data.periods.findIndex((p) => p.id === data.period?.id)) });
      }
      const data = await callApi<{ reports: Report[]; own: boolean; employee: { name: string; position_name?: string; store_name?: string }; summary: Management['summary'] | null }>('report.history',
        { employeeId: this.data.employeeId || undefined, periodId: this.data.periods[this.data.periodIndex]?.id });
      this.setData({ ...data, ready: true });
    } catch (e) { showError(e); } finally { this.setData({ loading: false }); }
  },
  periodChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.loading) return;
    this.setData({ periodIndex: Number(e.detail.value) }); void this.load();
  },
  open(e: WechatMiniprogram.CustomEvent) {
    wx.navigateTo({ url: this.data.own ? '/pages/report/report?date=' + e.currentTarget.dataset.date
      : '/pages/detail/detail?id=' + encodeURIComponent(e.currentTarget.dataset.id) });
  },
  retry() { void this.load(); },
});
