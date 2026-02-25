// utils/cart.ts - 购物车工具类

const CART_KEY = 'cart';

export interface CartItem {
  skuId: string;
  spuId: string;
  spuName: string;
  skuDisplayName: string;
  coverImage: string;
  price: number;
  quantity: number;
  bigCategory: string;
  productType: string;
  addedAt: number;
}

export interface Cart {
  items: CartItem[];
  updatedAt: number;
}

/**
 * 获取购物车数据
 */
export function getCart(): Cart {
  try {
    const data = wx.getStorageSync(CART_KEY);
    return data || { items: [], updatedAt: Date.now() };
  } catch {
    return { items: [], updatedAt: Date.now() };
  }
}

/**
 * 保存购物车数据
 */
function saveCart(cart: Cart): void {
  cart.updatedAt = Date.now();
  wx.setStorageSync(CART_KEY, cart);
}

/**
 * 添加商品到购物车
 */
export function addToCart(item: Omit<CartItem, 'quantity' | 'addedAt'>): Cart {
  const cart = getCart();
  const existingIndex = cart.items.findIndex(i => i.skuId === item.skuId);

  if (existingIndex > -1) {
    // 已存在，数量+1
    cart.items[existingIndex].quantity += 1;
  } else {
    // 新增商品
    cart.items.push({
      ...item,
      quantity: 1,
      addedAt: Date.now(),
    });
  }

  saveCart(cart);
  return cart;
}

/**
 * 更新商品数量
 */
export function updateQuantity(skuId: string, quantity: number): Cart {
  const cart = getCart();
  const item = cart.items.find(i => i.skuId === skuId);

  if (item) {
    if (quantity <= 0) {
      // 数量为0时删除
      cart.items = cart.items.filter(i => i.skuId !== skuId);
    } else {
      item.quantity = quantity;
    }
    saveCart(cart);
  }

  return cart;
}

/**
 * 从购物车删除商品
 */
export function removeFromCart(skuId: string): Cart {
  const cart = getCart();
  cart.items = cart.items.filter(i => i.skuId !== skuId);
  saveCart(cart);
  return cart;
}

/**
 * 清空购物车
 */
export function clearCart(): void {
  saveCart({ items: [], updatedAt: Date.now() });
}

/**
 * 获取购物车商品数量
 */
export function getCartCount(): number {
  const cart = getCart();
  return cart.items.reduce((sum, item) => sum + item.quantity, 0);
}

/**
 * 获取购物车商品总价
 */
export function getCartTotal(): number {
  const cart = getCart();
  return cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

/**
 * 批量设置选中状态（用于全选/取消全选）
 */
export function setAllSelected(selected: boolean, items: CartItem[]): CartItem[] {
  return items.map(item => ({ ...item, selected }));
}
