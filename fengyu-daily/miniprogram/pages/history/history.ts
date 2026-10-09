import { decodeRouteId } from '../../utils/route';
import { callApi, showError, Report, Management } from '../../utils/cloud';
import { expireLogin, sessionContext } from '../../utils/session';
interface Period { id: string; name: string; start: string; end: string }
Page({
  _context: '',
  _loadId: 0,
  data: {
    routeInvalid: false, reports: [] as Report[], loading: false, ready: false, own: true,
    employeeId: '', employee: null as { name: string; position_name?: string; store_name?: string } | null,
    periods: [] as Period[], periodIndex: 0, summary: null as Management['summary'] | null },
  onLoad(options: Record<string, string | undefined>) {
    const routeId = decodeRouteId(options.employeeId);
    if (routeId === null) { this.setData({ routeInvalid: true }); return; }
    this.setData({ employeeId: routeId });
  },
  onShow() { void this.load(); },
  async onPullDownRefresh() {
    expireLogin();
    try { await this.load(true); }
    finally { wx.stopPullDownRefresh(); }
  },
  async load(refreshPeriods = false) {
    if (this.data.routeInvalid) return;
    const context = sessionContext();
    if (this.data.loading && this._context === context) return;
    const loadId = ++this._loadId;
    if (this._context !== context)
      this.setData({ periods: [], periodIndex: 0, reports: [], employee: null, summary: null, ready: false });
    this._context = context;
    this.setData({ loading: true });
    try {
      const data = await callApi<{ reports: Report[]; own: boolean; employee: { name: string; position_name?: string; store_name?: string }; summary: Management['summary'] | null; period: Period | null; periods?: Period[] }>('report.history', {
        employeeId: this.data.employeeId || undefined,
        periodId: this.data.periods[this.data.periodIndex]?.id,
        includePeriods: refreshPeriods || !this.data.periods.length,
      });
      if (context !== sessionContext() || loadId !== this._loadId) return;
      const { periods, period, ...overview } = data;
      this.setData({ ...overview, ready: true, ...(periods ? {
        periods, periodIndex: Math.max(0, periods.findIndex(p => p.id === period?.id)),
      } : {}) });
    } catch (e) {
      if (loadId === this._loadId) {
        this.setData({ reports: [], employee: null, summary: null, ready: false });
        showError(e);
      }
    } finally { if (loadId === this._loadId) this.setData({ loading: false }); }
  },
  periodChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.loading) return;
    this.setData({ periodIndex: Number(e.detail.value), ready: false }); void this.load();
  },
  open(e: WechatMiniprogram.CustomEvent) {
    wx.navigateTo({ url: this.data.own && e.currentTarget.dataset.status !== 'submitted' ? '/pages/report/report?date=' + e.currentTarget.dataset.date
      : '/pages/detail/detail?id=' + encodeURIComponent(e.currentTarget.dataset.id) });
  },
  retry() { void this.load(); },
});
