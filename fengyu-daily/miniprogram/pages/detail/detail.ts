import { callApi, showError, Report, Business } from "../../utils/cloud";
Page({
  data: { id: '', date: '', report: null as Report | null, entries: [] as Business[],
    loading: false, own: false, canEdit: false, submittedLabel: '' },
  onLoad(options: Record<string, string | undefined>) {
    this.setData({ id: options.id || '', date: options.date || '' }); void this.load();
  },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const data = await callApi<{ report: Report; entries: Business[]; own: boolean; canEdit: boolean }>(
        'manager.detail', { id: this.data.id || undefined, date: this.data.date || undefined,
          workspace: wx.getStorageSync('dailyWorkspace') });
      this.setData({ ...data, submittedLabel: data.report.updated_at || data.report.submitted_at || '' });
    } catch (e) { showError(e); } finally { this.setData({ loading: false }); }
  },
  edit() {
    if (!this.data.canEdit || !this.data.report) return;
    wx.redirectTo({ url: '/pages/report/report?edit=1&date=' + this.data.report.report_date });
  },
  retry() { void this.load(); },
});
