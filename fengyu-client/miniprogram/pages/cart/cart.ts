// pages/cart/cart.ts
import Toast from "@vant/weapp/toast/toast";
import { getCart, updateQuantity, removeFromCart, clearCart } from "../../utils/cart";
import type { CartItem } from "../../utils/cart";

interface CartItemWithSelect extends CartItem {
  selected: boolean;
}

Page({
  data: {
    items: [] as CartItemWithSelect[],
    allSelected: false,
    selectedCount: 0,
    totalPrice: "0.00",
  },

  onShow() {
    this.loadCart();
  },

  loadCart() {
    const cart = getCart();
    const items: CartItemWithSelect[] = cart.items.map((item) => ({
      ...item,
      selected: true, // 默认全选
    }));
    this.setData({ items });
    this.recalculate();
  },

  recalculate() {
    const { items } = this.data;
    const selectedItems = items.filter((i) => i.selected);
    const selectedCount = selectedItems.reduce((sum, i) => sum + i.quantity, 0);
    const total = selectedItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const allSelected = items.length > 0 && items.every((i) => i.selected);

    this.setData({
      allSelected,
      selectedCount,
      totalPrice: total.toFixed(2),
    });
  },

  // 全选/取消全选
  onToggleAll(e: WechatMiniprogram.CustomEvent<boolean>) {
    const checked = e.detail;
    const items = this.data.items.map((item) => ({
      ...item,
      selected: checked,
    }));
    this.setData({ items });
    this.recalculate();
  },

  // 单个商品选中/取消
  onItemSelectChange(e: WechatMiniprogram.CustomEvent<boolean>) {
    const { skuId } = e.currentTarget.dataset as { skuId: string };
    const items = this.data.items.map((item) => (item.skuId === skuId ? { ...item, selected: e.detail } : item));
    this.setData({ items });
    this.recalculate();
  },

  // 数量变化
  onQuantityChange(e: WechatMiniprogram.CustomEvent<number>) {
    const { skuId } = e.currentTarget.dataset as { skuId: string };
    const quantity = e.detail;
    updateQuantity(skuId, quantity);
    const items = this.data.items.map((item) => (item.skuId === skuId ? { ...item, quantity } : item));
    this.setData({ items });
    this.recalculate();
  },

  // 删除商品
  onDeleteItem(e: WechatMiniprogram.TouchEvent) {
    const { skuId } = e.currentTarget.dataset as { skuId: string };
    removeFromCart(skuId);
    const items = this.data.items.filter((i) => i.skuId !== skuId);
    this.setData({ items });
    this.recalculate();
    Toast("已删除");
  },

  // 去逛逛
  onGoShop() {
    wx.switchTab({ url: "/pages/home/home" });
  },

  // 结算
  onCheckout() {
    const selectedItems = this.data.items.filter((i) => i.selected);
    if (selectedItems.length === 0) {
      Toast("请选择要结算的商品");
      return;
    }

    // 将选中的商品信息存到 storage，供 checkout 页面读取
    const checkoutItems = selectedItems.map((item) => ({
      skuId: item.skuId,
      spuName: item.spuName,
      skuDisplayName: item.skuDisplayName,
      price: item.price,
      quantity: item.quantity,
    }));

    wx.setStorageSync("checkoutItems", checkoutItems);
    wx.navigateTo({ url: "/pages/checkout/checkout?fromCart=1" });
  },

  onShareAppMessage() {
    return { title: "凤御美容", path: "/pages/home/home" };
  },
});
