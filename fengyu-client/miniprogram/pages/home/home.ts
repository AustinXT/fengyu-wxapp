// pages/home/home.ts
import Toast from "@vant/weapp/toast/toast";
import { addToCart, getCartCount, clearCart } from "../../utils/cart";

const app = getApp<IAppOption>();

// CloudBase CDN 基础 URL
const CDN_BASE = "https://636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la/fengyu-client";

interface Banner {
  id: string;
  title: string;
  desc: string;
  bgColor: string;
  image: string;
  link: string;
}

interface Category {
  category: string;
  category_order: number;
  big_category: string;
}

interface SpuItem {
  spu_id: string;
  name: string;
  category: string;
  big_category: string;
  cover_image: string;
  min_price: string;
  is_recommend: boolean;
  skuList?: any[];
}

const BIG_CATEGORIES = ["福利活动", "护理项目", "家居产品"];

// 数据库 big_category 与前端显示的映射
const BIG_CATEGORY_MAP: Record<string, string> = {
  促销方案: "福利活动",
  生美: "护理项目",
  非生美: "护理项目",
  院装产品: "家居产品",
};

// 获取前端显示的大分类名称
function getDisplayBigCategory(dbValue: string): string {
  return BIG_CATEGORY_MAP[dbValue] || dbValue;
}

Page({
  data: {
    searchValue: "",
    boundStoreName: "",
    banners: [
      // 轮播图1：jolyvia 品牌宣传
      { id: "1", title: "", desc: "", bgColor: "", image: `${CDN_BASE}/banner/banner1.jpg`, link: "" },
      // 轮播图2：jolyvia 品牌宣传
      { id: "2", title: "", desc: "", bgColor: "", image: `${CDN_BASE}/banner/banner2.jpg`, link: "" },
      // 轮播图3：jolyvia 品牌宣传
      { id: "3", title: "", desc: "", bgColor: "", image: `${CDN_BASE}/banner/banner3.jpg`, link: "" },
      // 轮播图4：jolyvia 品牌宣传
      { id: "4", title: "", desc: "", bgColor: "", image: `${CDN_BASE}/banner/banner4.jpg`, link: "" },
      // 轮播图5：jolyvia 品牌宣传
      { id: "5", title: "", desc: "", bgColor: "", image: `${CDN_BASE}/banner/banner5.jpg`, link: "" },
    ] as Banner[],
    currentBanner: 0,

    // 分类相关
    bigCategories: BIG_CATEGORIES,
    activeBigCategoryIndex: 1, // 默认选中"护理项目"
    categories: [] as Category[],
    activeCategoryIndex: 0,
    spuList: [] as SpuItem[],
    isLoading: false,
    cartCount: 0,
  },

  // 所有分类（未过滤）
  _allCategories: [] as Category[],

  // 页面级 SPU 缓存：按分类名缓存已加载的 SPU 列表
  _spuCache: {} as Record<string, SpuItem[]>,

  onLoad() {
    const storeName = app.globalData.boundStoreName || "";
    this.setData({
      boundStoreName: storeName,
    });
    this.loadShopInit();
    this.updateCartCount();
  },

  onShow() {
    const storeName = app.globalData.boundStoreName || "";
    if (storeName !== this.data.boundStoreName) {
      // 切换门店时清空购物车和 SPU 缓存
      clearCart();
      this._spuCache = {};
      this._allCategories = [];
      this.setData({
        boundStoreName: storeName,
        activeBigCategoryIndex: 0,
        activeCategoryIndex: 0,
        spuList: [],
        cartCount: 0,
      });
      this.loadShopInit();
    } else {
      this.updateCartCount();
    }
  },

  updateCartCount() {
    this.setData({ cartCount: getCartCount() });
  },

  onPullDownRefresh() {
    wx.stopPullDownRefresh();
  },

  // ===== 事件处理 =====

  onSelectStore() {
    wx.navigateTo({ url: "/pagesStore/store-select/store-select" });
  },

  onSearchChange(e: WechatMiniprogram.CustomEvent<string>) {
    const value = e.detail;
    this.setData({ searchValue: value });
  },

  onSearchInput(e: WechatMiniprogram.InputEvent) {
    this.setData({ searchValue: e.detail.value });
  },

  onSearchSubmit() {
    const value = this.data.searchValue.trim();
    if (value) {
      wx.showToast({ title: "搜索功能开发中", icon: "none" });
    }
  },

  onScanPay() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (res) => {
        if (res.path) {
          wx.navigateTo({ url: "/" + res.path });
        } else if (res.result) {
          wx.navigateTo({ url: `/pagesOrder/scan-pay/scan-pay?orderNo=${encodeURIComponent(res.result)}` });
        }
      },
      fail: () => {
        // 用户取消扫码，不提示
      },
    });
  },

  onBannerChange(e: WechatMiniprogram.CustomEvent<number>) {
    this.setData({ currentBanner: e.detail.current });
  },

  onBannerTap(e: WechatMiniprogram.TouchEvent) {
    const url = e.currentTarget.dataset.url;
    if (url) {
      // TODO: 处理跳转
    }
  },

  // 宫格按钮点击处理
  onGridTap(e: WechatMiniprogram.TouchEvent) {
    const { type } = e.currentTarget.dataset as { type: string };

    switch (type) {
      case "promotion":
        // 切换到"促销方案"分类
        this.switchBigCategory(0);
        break;
      case "service":
        // 切换到"护理项目"分类
        this.switchBigCategory(1);
        break;
      case "product":
        // 切换到"家居产品"分类
        this.switchBigCategory(2);
        break;
      case "coupon":
        wx.showToast({ title: "优惠券功能开发中", icon: "none" });
        break;
      case "treatment":
        wx.navigateTo({ url: "/pagesOrder/treatment-cards/treatment-cards" });
        break;
      default:
        break;
    }
  },

  // 切换大分类
  switchBigCategory(index: number) {
    if (index === this.data.activeBigCategoryIndex) return;

    const activeBig = BIG_CATEGORIES[index];
    const filtered = this._allCategories.filter((c) => c.big_category === activeBig);
    const categoriesWithIndex = filtered.map((c, i) => ({ ...c, _index: i }));

    this.setData({
      activeBigCategoryIndex: index,
      categories: categoriesWithIndex,
      activeCategoryIndex: 0,
      spuList: [],
    });

    if (filtered.length > 0) {
      const firstCategory = filtered[0].category;
      const cached = this._spuCache[firstCategory];
      if (cached) {
        this.setData({ spuList: cached });
      } else {
        this.loadSpuList(firstCategory);
      }
    }
  },

  // ===== 分类和商品列表逻辑 =====

  // 使用 shopInit 合并接口一次性加载分类 + 第一个分类的 SPU 列表
  async loadShopInit() {
    try {
      this.setData({ isLoading: true });
      const res = (await wx.cloud.callFunction({
        name: "clientApi",
        data: {
          action: "product.shopInit",
          payload: {},
        },
      })) as any;

      if (res.result?.code !== 0) {
        throw new Error(res.result?.message || "加载失败");
      }

      const categories: Category[] = res.result.data?.categories || [];
      const spuList: SpuItem[] = res.result.data?.spuList || [];

      const listWithPrice = spuList.map((spu: any) => ({
        ...spu,
        min_price: spu.priceFrom || "0",
      }));

      // 缓存 shopInit 返回的 SPU 列表（对应全局第一个分类）
      if (categories.length > 0) {
        this._spuCache[categories[0].category] = listWithPrice;
      }

      // 保存全部分类，按当前大类筛选侧边栏
      // 注意：将数据库返回的 big_category 转换为前端显示的名称
      const categoriesWithBigCategory = categories.map((c: any) => ({
        ...c,
        big_category: getDisplayBigCategory(c.big_category),
      }));
      this._allCategories = categoriesWithBigCategory;
      const activeBig = BIG_CATEGORIES[this.data.activeBigCategoryIndex];
      const filtered = categoriesWithBigCategory.filter((c) => c.big_category === activeBig);
      const categoriesWithIndex = filtered.map((c, i) => ({
        ...c,
        _index: i,
      }));

      // 判断第一个筛选后的分类是否有缓存
      let displayList = listWithPrice;
      if (filtered.length > 0 && filtered[0].category !== categories[0]?.category) {
        // 首个大类分类与全局首个分类不同，需单独加载
        displayList = [];
      }

      this.setData({
        categories: categoriesWithIndex,
        activeCategoryIndex: 0,
        spuList: displayList,
      });

      // 如需单独加载首个大类的 SPU
      if (filtered.length > 0 && displayList.length === 0) {
        this.loadSpuList(filtered[0].category);
      }
    } catch (err: any) {
      console.error("loadShopInit error:", err);
      Toast.fail(err?.message || "加载失败");
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onBigCategoryChange(e: WechatMiniprogram.CustomEvent) {
    const index = typeof e.detail === "number" ? e.detail : (e.detail as any)?.index;
    if (typeof index !== "number" || index === this.data.activeBigCategoryIndex) return;

    const activeBig = BIG_CATEGORIES[index];
    const filtered = this._allCategories.filter((c) => c.big_category === activeBig);
    const categoriesWithIndex = filtered.map((c, i) => ({ ...c, _index: i }));

    this.setData({
      activeBigCategoryIndex: index,
      categories: categoriesWithIndex,
      activeCategoryIndex: 0,
      spuList: [],
    });

    if (filtered.length > 0) {
      const firstCategory = filtered[0].category;
      const cached = this._spuCache[firstCategory];
      if (cached) {
        this.setData({ spuList: cached });
      } else {
        this.loadSpuList(firstCategory);
      }
    }
  },

  onCategoryChange(e: WechatMiniprogram.CustomEvent<number>) {
    const index = typeof e.detail === "number" ? e.detail : (e.detail as any)?.key;
    if (typeof index !== "number") return;
    const { categories } = this.data;
    if (index === this.data.activeCategoryIndex && this.data.spuList.length > 0) return;

    const category = index < categories.length ? categories[index].category : "院装产品";

    // 先查缓存：命中则直接替换，不清空不闪烁
    const cached = this._spuCache[category];
    if (cached) {
      this.setData({ activeCategoryIndex: index, spuList: cached });
      return;
    }

    // 未命中缓存：清空列表显示骨架屏，发起请求
    this.setData({ activeCategoryIndex: index, spuList: [] });
    this.loadSpuList(category);
  },

  async loadSpuList(category: string) {
    this.setData({ isLoading: true });
    try {
      const res = (await wx.cloud.callFunction({
        name: "clientApi",
        data: {
          action: "product.spuList",
          payload: { category },
        },
      })) as any;

      if (res.result?.code !== 0) {
        throw new Error(res.result?.message || "加载商品失败");
      }

      const spuList: SpuItem[] = res.result.data?.spuList || [];
      const listWithPrice = spuList.map((spu: any) => ({
        ...spu,
        min_price: spu.priceFrom || "0",
      }));

      // 写入缓存
      this._spuCache[category] = listWithPrice;

      this.setData({ spuList: listWithPrice });
    } catch (err: any) {
      console.error("loadSpuList error:", err);
      Toast.fail(err?.message || "加载商品失败");
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onSpuTap(e: WechatMiniprogram.TouchEvent) {
    const { spuId } = e.currentTarget.dataset as { spuId: string };
    wx.navigateTo({ url: `/pagesShop/service-detail/service-detail?spuId=${spuId}` });
  },

  // 点击"加入购物车"按钮
  async onAddToCart(e: WechatMiniprogram.TouchEvent) {
    e.stopPropagation(); // 阻止冒泡，避免触发卡片点击
    const { spuId } = e.currentTarget.dataset as { spuId: string };
    const spu = this.data.spuList.find((s) => s.spu_id === spuId);
    if (!spu) return;

    // 获取第一个 SKU 作为默认添加到购物车的商品
    const skuList = spu.skuList || [];
    if (skuList.length === 0) {
      Toast("暂无可购规格");
      return;
    }

    // 使用最低价的 SKU
    const sku = skuList[0];

    addToCart({
      skuId: sku.sku_id,
      spuId: spu.spu_id,
      spuName: spu.name,
      skuDisplayName: sku.sku_display_name,
      coverImage: spu.cover_image,
      price: sku.originalPrice || 0,
      bigCategory: spu.big_category,
      productType: sku.product_type,
    });

    this.updateCartCount();
    Toast.success("已加入购物车");
  },

  // 点击底部购物车栏
  onCartTap() {
    wx.navigateTo({ url: "/pages/cart/cart" });
  },
});
