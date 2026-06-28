// components/nav-bar/nav-bar.ts

const app = getApp<IAppOption>();

Component({
  properties: {
    /** 页面标题文字（与 showLogo 互斥，title 优先） */
    title: {
      type: String,
      value: "",
    },
    /** 是否显示 Logo（默认 true；设置 title 时自动切换为文字） */
    showLogo: {
      type: Boolean,
      value: true,
    },
    /** 导航栏背景色 */
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

  // 折叠屏展开/折叠、屏幕旋转时触发
  // 先让 App 重算 globalData（onLaunch 只算一次），再 nextTick 重读（避开 getMenuButton 同步返回 resize 前旧值的坑）
  pageLifetimes: {
    resize() {
      app.initNavBarInfo();
      wx.nextTick(() => this._applyNavBar());
    },
  },

  methods: {
    _applyNavBar() {
      const { statusBarHeight = 44, navBarContentHeight = 44, navBarHeight = 88, logoHeight = 34 } = app.globalData;
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
