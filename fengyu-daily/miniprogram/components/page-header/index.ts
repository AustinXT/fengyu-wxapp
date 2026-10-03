Component({
  properties: {
    title: { type: String, value: "" },
    back: { type: Boolean, value: false },
    customBack: { type: Boolean, value: false },
    brand: { type: Boolean, value: false },
  },
  data: { statusHeight: 20 },
  methods: { goBack() { if (this.properties.customBack) { this.triggerEvent('back'); return; } if (getCurrentPages().length > 1) wx.navigateBack(); else wx.switchTab({ url: '/pages/home/home' }); } },
  lifetimes: {
    attached() {
      this.setData({
        statusHeight: wx.getSystemInfoSync().statusBarHeight || 20,
      });
    },
  },
});
