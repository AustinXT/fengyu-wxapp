// pagesShop/shopping-cart/shopping-cart.ts
import Toast from "@vant/weapp/toast/toast";
import Dialog from "@vant/weapp/dialog/dialog";
import { getCart, updateQuantity, removeFromCart, clearCart } from "../../utils/cart";

interface CartItemDisplay {
  skuId: string;
  spuId: string;
  spuName: string;
  skuDisplayName: string;
  coverImage: string;
  price: number;
  quantity: number;
  bigCategory: string;
  checked: boolean;
}

Page({
  data: {
    cartItems: [] as CartItemDisplay[],
    allChecked: true,
    totalPrice: 0,
    totalCount: 0,
    isEmpty: true,
  },

  onShow() {
    this.loadCart();
  },

  loadCart() {
    const cart = getCart();
    const items: CartItemDisplay[] = cart.items.map((item) => ({
      skuId: item.skuId,
      spuId: item.spuId,
      spuName: item.spuName,
      skuDisplayName: item.skuDisplayName,
      coverImage: item.coverImage,
      price: item.price,
      quantity: item.quantity,
      bigCategory: item.bigCategory || '',
      checked: true,
    }));

    this.setData({
      cartItems: items,
      isEmpty: items.length === 0,
      allChecked: true,
    });
    this.calcTotal();
  },

  calcTotal() {
    const { cartItems } = this.data;
    const checked = cartItems.filter((i) => i.checked);
    this.setData({
      totalPrice: Math.round(checked.reduce((sum, i) => sum + i.price * i.quantity, 0) * 100) / 100,
      totalCount: checked.reduce((sum, i) => sum + i.quantity, 0),
    });
  },

  onToggleItem(e: WechatMiniprogram.TouchEvent) {
    const { index } = e.currentTarget.dataset as { index: number };
    const key = `cartItems[${index}].checked`;
    this.setData({ [key]: !this.data.cartItems[index].checked });

    const allChecked = this.data.cartItems.every((i) => i.checked);
    this.setData({ allChecked });
    this.calcTotal();
  },

  onToggleAll() {
    const newVal = !this.data.allChecked;
    const cartItems = this.data.cartItems.map((i) => ({ ...i, checked: newVal }));
    this.setData({ cartItems, allChecked: newVal });
    this.calcTotal();
  },

  onQuantityChange(e: WxEvent<number>) {
    const { index } = e.currentTarget.dataset as { index: number };
    const quantity = e.detail;
    const item = this.data.cartItems[index];

    updateQuantity(item.skuId, quantity);
    this.setData({ [`cartItems[${index}].quantity`]: quantity });
    this.calcTotal();
  },

  async onClearAll() {
    try {
      await Dialog.confirm({
        title: '清空购物车',
        message: '确定要清空购物车中的所有商品吗？',
      });
      clearCart();
      this.setData({ cartItems: [], isEmpty: true, allChecked: true, totalPrice: 0, totalCount: 0 });
      Toast.success('已清空');
    } catch {
      // 用户取消
    }
  },

  onDeleteItem(e: WechatMiniprogram.TouchEvent) {
    const { index } = e.currentTarget.dataset as { index: number };
    const item = this.data.cartItems[index];

    removeFromCart(item.skuId);
    const cartItems = this.data.cartItems.filter((_, i) => i !== index);
    this.setData({
      cartItems,
      isEmpty: cartItems.length === 0,
    });
    this.calcTotal();
    Toast.success("已删除");
  },

  onItemTap(e: WechatMiniprogram.TouchEvent) {
    const { spuId } = e.currentTarget.dataset as { spuId: string };
    wx.navigateTo({ url: `/pagesShop/service-detail/service-detail?productId=${spuId}` });
  },

  onCheckout() {
    const checkedItems = this.data.cartItems.filter((i) => i.checked);
    if (checkedItems.length === 0) {
      Toast("请选择商品");
      return;
    }

    // 存储结算商品到 localStorage
    wx.setStorageSync(
      "checkoutItems",
      checkedItems.map((i) => ({
        skuId: i.skuId,
        spuName: i.spuName,
        skuDisplayName: i.skuDisplayName,
        coverImage: i.coverImage,
        price: i.price,
        quantity: i.quantity,
      }))
    );

    wx.navigateTo({ url: "/pagesOrder/checkout/checkout?fromCart=1" });
  },

  goShopping() {
    wx.navigateBack();
  },

  onShareAppMessage() {
    return { title: "凤御购物车", path: "/pages/home/home" };
  },
});
