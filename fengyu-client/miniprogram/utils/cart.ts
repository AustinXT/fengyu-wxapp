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
  /**
   * PR-D：一级品项 kind 名（来自 product_categories 一级行）。
   * 与 bigCategory（=商城分类 mall_categories.category_name）不同：productKind 是
   * 业务品项（护理项目/家居产品/体验卡 + 任意 admin 新建一级 kind；
   * 2026-04-26 起 充值卡 通过 isRechargeCard capability 列单独表达）。
   * 可选——加购时若 SKU 数据未携带则保持 undefined，购物车 tag 走 bigCategory 兜底。
   */
  productKind?: string;
  /**
   * PR-D：一级 kind 行的 display_color HEX 值（DB 驱动）。
   * 与 productKind 配套；缺失时 tag 退化为 type='primary'。
   */
  kindDisplayColor?: string;
  /**
   * 2026-04-26 capability 化：充值卡行级标记（取自 product_skus.is_recharge_card）。
   * 商城常规通道已在 SKU_VALID_FILTER 排除充值卡；此字段用于购物车 tag 兜底渲染
   * 以及防止字面量 bigCategory='充值卡' 散落。常规商品保持 false。
   */
  isRechargeCard?: boolean;
  /**
   * 2026-04-26 体验卡 capability 化（ticket Round 2）：行级标记（取自 product_skus.is_experience）。
   * 商城常规通道已在 SKU_VALID_FILTER 排除体验卡（is_experience=true 的 SKU 不进商城商品列表）；
   * 体验卡走独立购物流（pages/experience-card/checkout），不与商城购物车合并。
   * 商城正常 SKU 保持 false；此字段仅用于兜底防御。
   */
  isExperience?: boolean;
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
    if (!data || !Array.isArray(data.items)) {
      return { items: [], updatedAt: Date.now() };
    }
    // 过滤掉损坏的条目（缺少必须字段）
    data.items = data.items.filter(
      (i: any) => i && typeof i.skuId === 'string' && typeof i.price === 'number' && typeof i.quantity === 'number'
    );
    return data;
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
export function addToCart(item: Omit<CartItem, 'quantity' | 'addedAt'>, quantity: number = 1): Cart {
  const cart = getCart();
  const existingIndex = cart.items.findIndex(i => i.skuId === item.skuId);

  if (existingIndex > -1) {
    cart.items[existingIndex].quantity += quantity;
  } else {
    cart.items.push({
      ...item,
      quantity,
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
