import { callApi, showError, Report } from "../../utils/cloud";
Page({
  data: { reports: [] as Report[], loading: false },
  onShow() {
    void this.load();
  },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const data = await callApi<{ reports: Report[] }>("report.history");
      this.setData(data);
    } catch (e) {
      showError(e);
    } finally {
      this.setData({ loading: false });
    }
  },
  open(e: WechatMiniprogram.CustomEvent) {
    wx.navigateTo({
      url: "/pages/report/report?date=" + e.currentTarget.dataset.date,
    });
  },
});
