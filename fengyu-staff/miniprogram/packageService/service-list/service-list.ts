// pages/service-list/service-list.ts
// 护理单列表现已作为独立 Tab 页实现（pages/service/service）
// 本页面直接跳转护理 Tab
Page({
  data: {},
  onLoad() {
    wx.switchTab({ url: '/pages/service/service' });
  },
});
