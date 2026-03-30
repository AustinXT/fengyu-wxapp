// pages/cart/cart.ts

import { callClientApi } from '../../utils/cloud';

const CDN_BASE = 'https://636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la';
const DEFAULT_IMAGE_PATH = '/images/fengyuguan.jpg';
const IMAGE_WIDTH = 2480;
const IMAGE_HEIGHT = 34960;
const STRIP_COUNT = 10;

interface StripItem {
  url: string;
  heightRpx: number;
}

function buildStrips(baseUrl: string, cacheBuster?: string): StripItem[] {
  const stripH = Math.ceil(IMAGE_HEIGHT / STRIP_COUNT);
  const suffix = cacheBuster ? `&t=${cacheBuster}` : '';
  const strips: StripItem[] = [];
  for (let i = 0; i < STRIP_COUNT; i++) {
    const dy = i * stripH;
    const h = Math.min(stripH, IMAGE_HEIGHT - dy);
    strips.push({
      url: `${baseUrl}?imageMogr2/cut/${IMAGE_WIDTH}x${h}x0x${dy}/thumbnail/750x${suffix}`,
      heightRpx: Math.ceil(750 * h / IMAGE_WIDTH),
    });
  }
  return strips;
}

Page({
  data: {
    strips: buildStrips(`${CDN_BASE}${DEFAULT_IMAGE_PATH}`),
  },

  onLoad() {
    this.loadFengyuguanImage();
  },

  async loadFengyuguanImage() {
    try {
      const data = await callClientApi<{ url: string }>('config.fengyuguan', {});
      const url = data?.url;
      if (url) {
        // Strip any existing query params (e.g. ?t=xxx cache-buster from admin upload)
        const cleanUrl = url.split('?')[0];
        this.setData({
          strips: buildStrips(cleanUrl, String(Date.now())),
        });
      }
    } catch (err) {
      console.error('loadFengyuguanImage error:', err);
    }
  },

  onShareAppMessage() {
    return { title: '凤御馆', path: '/pages/home/home' };
  },
});
