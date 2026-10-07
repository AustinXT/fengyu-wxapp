import { decodeRouteId } from '../../utils/route';
import { callApi, showError, today, Management } from '../../utils/cloud';
Page({
  data: { routeInvalid: false, nodeId: '', period: 'today', title: '范围日报', loading: false, overview: null as Management | null },
  onLoad(options: Record<string, string | undefined>) {
    const routeId = decodeRouteId(options.nodeId);
    if (routeId === null) { this.setData({ routeInvalid: true }); return; }
    this.setData({ nodeId: routeId, period: ['today', 'week', 'month'].includes(options.period || '') ? options.period! : 'today' });
    void this.load();
  },
  async load() {
    if (this.data.loading || this.data.routeInvalid) return;
    this.setData({ loading: true });
    try {
      const overview = await callApi<Management>('management.read', { date: today(), nodeId: this.data.nodeId, period: this.data.period });
      this.setData({ overview, title: (overview.nodes.find((n) => n.id === this.data.nodeId)?.name || '授权范围') + '日报' });
    } catch (e) { this.setData({ overview: null }); showError(e); } finally { this.setData({ loading: false }); }
  },
  periodChange(e: WechatMiniprogram.CustomEvent) {
    if (this.data.loading) return;
    this.setData({ period: e.currentTarget.dataset.period }); void this.load();
  },
  store(e: WechatMiniprogram.CustomEvent) {
    wx.navigateTo({ url: '/pages/manager/manager?storeId=' + encodeURIComponent(e.currentTarget.dataset.id) + '&period=' + this.data.period });
  },
  retry() { void this.load(); },
});
