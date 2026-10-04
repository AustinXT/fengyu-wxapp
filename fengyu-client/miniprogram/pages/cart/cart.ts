// pages/cart/cart.ts
import { callClientApi } from '../../utils/cloud';
import { sanitizeFengyuguanStrips } from '../../utils/fengyuguan';

Page({
  data: {
    strips: [] as { url: string; heightRpx: number }[],
    loading: true,
  },

  async onLoad() { await this.loadStrips(); },

  async loadStrips() {
    this.setData({ loading: true });
    try {
      const res = await callClientApi<{ strips: unknown }>('config.fengyuguan', {});
      this.setData({ strips: sanitizeFengyuguanStrips(res?.strips) });
    } catch {
      this.setData({ strips: [] });
    } finally { this.setData({ loading: false }); }
  },

  onShareAppMessage() {
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return { title: '凤御馆', path: `/pages/home/home${invSuffix}` };
  },
});
