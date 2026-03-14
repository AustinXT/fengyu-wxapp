// pages/cart/cart.ts

const CDN_BASE = 'https://636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la';
const IMAGE_PATH = '/images/fengyuguan.jpg';
const IMAGE_WIDTH = 2480;
const IMAGE_HEIGHT = 34960;
const STRIP_COUNT = 10;

interface StripItem {
  url: string;
  heightRpx: number;
}

function buildStrips(): StripItem[] {
  const stripH = Math.ceil(IMAGE_HEIGHT / STRIP_COUNT);
  const heightRpx = Math.ceil(750 * stripH / IMAGE_WIDTH);
  const strips: StripItem[] = [];
  for (let i = 0; i < STRIP_COUNT; i++) {
    const dy = i * stripH;
    const h = Math.min(stripH, IMAGE_HEIGHT - dy);
    strips.push({
      url: `${CDN_BASE}${IMAGE_PATH}?imageMogr2/cut/${IMAGE_WIDTH}x${h}x0x${dy}/thumbnail/750x`,
      heightRpx: Math.ceil(750 * h / IMAGE_WIDTH),
    });
  }
  return strips;
}

Page({
  data: {
    strips: buildStrips(),
  },

  onShareAppMessage() {
    return { title: '凤御馆', path: '/pages/home/home' };
  },
});
