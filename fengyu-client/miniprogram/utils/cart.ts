

const CART_KEY = 'cart';

export interface CartItem {
  skuId: string;
  spuId: string;
  spuName: string;
  skuDisplayName: string;
  coverImage: string;
  
  price: number;
  
  listPrice?: number;
  quantity: number;
  bigCategory: string;
  productType: string;
  
  productKind?: string;
  
  kindDisplayColor?: string;
  
  isExperience?: boolean;
  addedAt: number;
}

export interface Cart {
  items: CartItem[];
  updatedAt: number;
}


export function getCart(): Cart {
  try {
    const data = wx.getStorageSync(CART_KEY);
    if (!data || !Array.isArray(data.items)) {
      return { items: [], updatedAt: Date.now() };
    }
    
    data.items = data.items.filter(
      (i: any) => i && typeof i.skuId === 'string' && typeof i.price === 'number' && typeof i.quantity === 'number'
    );
    return data;
  } catch {
    return { items: [], updatedAt: Date.now() };
  }
}


function saveCart(cart: Cart): void {
  cart.updatedAt = Date.now();
  wx.setStorageSync(CART_KEY, cart);
}


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


export function updateQuantity(skuId: string, quantity: number): Cart {
  const cart = getCart();
  const item = cart.items.find(i => i.skuId === skuId);

  if (item) {
    if (quantity <= 0) {
      
      cart.items = cart.items.filter(i => i.skuId !== skuId);
    } else {
      item.quantity = quantity;
    }
    saveCart(cart);
  }

  return cart;
}


export function removeFromCart(skuId: string): Cart {
  const cart = getCart();
  cart.items = cart.items.filter(i => i.skuId !== skuId);
  saveCart(cart);
  return cart;
}


export function clearCart(): void {
  saveCart({ items: [], updatedAt: Date.now() });
}


export function getCartCount(): number {
  const cart = getCart();
  return cart.items.reduce((sum, item) => sum + item.quantity, 0);
}


export function getCartTotal(): number {
  const cart = getCart();
  return cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}


export function setAllSelected(selected: boolean, items: CartItem[]): CartItem[] {
  return items.map(item => ({ ...item, selected }));
}
