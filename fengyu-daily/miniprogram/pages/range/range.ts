import { callApi, showError, today, Management } from '../../utils/cloud';
Page({
  data: { nodeId: '', period: 'today', title: '范围日报', loading: false, overview: null as Management | null },
  onLoad(options: Record<string, string | undefined>) {
    let nodeId = '';
    try {
      nodeId = decodeURIComponent(options.nodeId || '');
    } catch (e) {
      showError(new Error('组织范围参数无效，请返回后重新进入'));
      return;
    }
    this.setData({ nodeId, period: ['today', 'week', 'month'].includes(options.period || '') ? options.period! : 'today' });
    void this.load();
  },
  async load() {
    if (this.data.loading) return;
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
