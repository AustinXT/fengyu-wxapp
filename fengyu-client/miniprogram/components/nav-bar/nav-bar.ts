// components/nav-bar/nav-bar.ts

const app = getApp<IAppOption>();

Component({
  properties: {
    /** 页面标题文字（与 showLogo 互斥，title 优先） */
    title: {
      type: String,
      value: '',
    },
    /** 是否显示 Logo（默认 true；设置 title 时自动切换为文字） */
    showLogo: {
      type: Boolean,
      value: true,
    },
    /** 导航栏背景色 */
    background: {
      type: String,
      value: '#FFFFFF',
    },
  },

  data: {
    statusBarHeight: 44,
    contentHeight: 44,
    navBarHeight: 88,
    showBack: false,
  },

  lifetimes: {
    attached() {
      const { statusBarHeight = 44, navBarContentHeight = 44, navBarHeight = 88 } = app.globalData;
      const pages = getCurrentPages();
      this.setData({
        statusBarHeight,
        contentHeight: navBarContentHeight,
        navBarHeight,
        showBack: pages.length > 1,
      });
    },
  },

  methods: {
    onBack() {
      wx.navigateBack({ delta: 1 });
    },
  },
});
