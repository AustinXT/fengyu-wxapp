// pages/shop/shop.js
Page({

  /**
   * 页面的初始数据
   */
  data: {
    boundStoreName: '',
    categories: [],
    activeCategoryIndex: 0,
    spuList: [],
    isLoading: false,
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    const app = getApp();
    const storeName = app.globalData?.boundStoreName || '';
    this.setData({ boundStoreName: storeName });
    this.loadCategories();
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    const app = getApp();
    const storeName = app.globalData?.boundStoreName || '';
    if (storeName !== this.data.boundStoreName) {
      this.setData({ boundStoreName: storeName, activeCategoryIndex: 0, spuList: [] });
      this.loadCategories();
    }
  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide() {

  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {

  },

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  onPullDownRefresh() {

  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom() {

  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage() {

  },

  onSelectStore() {
    wx.navigateTo({ url: '/pages/store-select/store-select' });
  },

  async loadCategories() {
    try {
      this.setData({ isLoading: true });
      const res = await wx.cloud.callFunction({
        name: 'clientApi',
        data: {
          action: 'product.categories',
          payload: { storeName: this.data.boundStoreName },
        },
      });
      const categories = res.result?.data?.categories || [];
      this.setData({ categories, activeCategoryIndex: 0 });
      const first = categories[0]?.category;
      if (first) this.loadSpuList(first);
    } catch (err) {
      console.error('loadCategories error:', err);
      wx.showToast({ title: '加载分类失败', icon: 'none' });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onCategoryChange(e) {
    const index = e.detail.index;
    this.setData({ activeCategoryIndex: index, spuList: [] });
    const { categories } = this.data;
    const category = index < categories.length ? categories[index].category : '院装产品';
    this.loadSpuList(category);
  },

  async loadSpuList(category) {
    this.setData({ isLoading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'clientApi',
        data: {
          action: 'product.spuList',
          payload: { category, storeName: this.data.boundStoreName },
        },
      });
      const spuList = res.result?.data?.spuList || [];
      // 计算每个 SPU 的最低价
      const listWithPrice = spuList.map((spu) => ({
        ...spu,
        min_price: spu.priceFrom || '0',
      }));
      this.setData({ spuList: listWithPrice });
    } catch (err) {
      console.error('loadSpuList error:', err);
      wx.showToast({ title: '加载商品失败', icon: 'none' });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onSpuTap(e) {
    const { spuId } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/service-detail/service-detail?spuId=${spuId}` });
  },
})
