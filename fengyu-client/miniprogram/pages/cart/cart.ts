
import { getCosBase } from '../../utils/cloud-env';
import { callClientApi } from '../../utils/cloud';

const CDN_BASE = getCosBase();
const DEFAULT_IMAGE_PATH = '/images/fengyuguan.jpg';

const TARGET_STRIP_PX = 4000;

const FALLBACK_WIDTH = 2480;
const FALLBACK_HEIGHT = 34960;

interface StripItem {
  url: string;
  heightRpx: number;
}


function buildStrips(baseUrl: string, w: number, h: number, v?: number): StripItem[] {
  const count = Math.max(1, Math.ceil(h / TARGET_STRIP_PX));
  const stripH = Math.ceil(h / count);
  const suffix = v ? `&t=${v}` : '';
  const strips: StripItem[] = [];
  for (let i = 0; i < count; i++) {
    const dy = i * stripH;
    const sh = Math.min(stripH, h - dy);
    if (sh <= 0) break;
    strips.push({
      url: `${baseUrl}?imageMogr2/cut/${w}x${sh}x0x${dy}/thumbnail/750x${suffix}`,
      heightRpx: Math.ceil(750 * sh / w),
    });
  }
  return strips;
}

function getImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src,
      success: (res) => resolve({ width: res.width, height: res.height }),
      fail: reject,
    });
  });
}

Page({
  data: {
    strips: [] as StripItem[],
  },

  async onLoad() {
    const base = `${CDN_BASE}${DEFAULT_IMAGE_PATH}`;
    let v = 0;
    try {
      const res = await callClientApi<{ url: string; v: number }>('config.fengyuguan', {});
      v = res?.v || 0;
      const probe = v ? `${base}?t=${v}` : base;
      const { width, height } = await getImageSize(probe);
      this.setData({ strips: buildStrips(base, width, height, v) });
    } catch {
      
      this.setData({ strips: buildStrips(base, FALLBACK_WIDTH, FALLBACK_HEIGHT, v) });
    }
  },

  onShareAppMessage() {
    const app = getApp<IAppOption>();
    const userId = app.globalData.userId;
    const invSuffix = userId ? `?inv=${encodeURIComponent(userId)}` : '';
    return { title: '凤御馆', path: `/pages/home/home${invSuffix}` };
  },
});
