Component({
  properties: {
    title: { type: String, value: "" },
    brand: { type: Boolean, value: false },
  },
  data: { statusHeight: 20 },
  lifetimes: {
    attached() {
      this.setData({
        statusHeight: wx.getSystemInfoSync().statusBarHeight || 20,
      });
    },
  },
});
