// pages/service-list/service-list.ts
// 服务单列表现已作为独立 Tab 页实现（pages/service/service）
// 本页面直接跳转服务 Tab
Page({
  data: {},
  onLoad() {
    wx.switchTab({ url: '/pages/service/service' });
  },
});
