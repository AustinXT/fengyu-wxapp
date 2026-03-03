// pages/cart/cart.ts
Page({
  data: {
    introUrl: 'https://636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la/images/intro.png',
  },

  onShareAppMessage() {
    return { title: '凤御馆', path: '/pages/home/home' };
  },
});
