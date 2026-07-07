

const app = getApp<IAppOption>();

Component({
  properties: {
    
    title: {
      type: String,
      value: "",
    },
    
    showLogo: {
      type: Boolean,
      value: true,
    },
    
    background: {
      type: String,
      value: "#FFFFFF",
    },
  },

  data: {
    statusBarHeight: 44,
    contentHeight: 44,
    navBarHeight: 88,
    logoHeight: 26,
    showBack: false,
  },

  lifetimes: {
    attached() {
      this._applyNavBar();
    },
  },

  
  
  pageLifetimes: {
    resize() {
      app.initNavBarInfo();
      wx.nextTick(() => this._applyNavBar());
    },
  },

  methods: {
    _applyNavBar() {
      const { statusBarHeight = 44, navBarContentHeight = 44, navBarHeight = 88, logoHeight = 26 } = app.globalData;
      const pages = getCurrentPages();
      this.setData({
        statusBarHeight,
        contentHeight: navBarContentHeight,
        navBarHeight,
        logoHeight,
        showBack: pages.length > 1,
      });
    },
    onBack() {
      wx.navigateBack({ delta: 1 });
    },
  },
});
