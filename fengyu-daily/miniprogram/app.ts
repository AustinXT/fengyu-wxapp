App<IAppOption>({
  globalData: {},
  onLaunch() {
    wx.cloud.init({ env: "cloud1-d5gz7zr8x6c38bd49", traceUser: true });
  },
});
