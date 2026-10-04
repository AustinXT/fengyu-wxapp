Component({
  properties: {
    title: { type: String, value: "" },
    back: { type: Boolean, value: false },
    customBack: { type: Boolean, value: false },
    brand: { type: Boolean, value: false },
  },
  data: { statusHeight: 20, headerHeight: 84 },
  methods: { goBack() { if (this.properties.customBack) { this.triggerEvent('back'); return; } if (getCurrentPages().length > 1) wx.navigateBack(); else wx.switchTab({ url: '/pages/home/home' }); } },
  lifetimes: {
    attached() {
      const statusHeight = wx.getSystemInfoSync().statusBarHeight || 20;
      this.setData({ statusHeight, headerHeight: statusHeight + 64 });
    },
  },
});
