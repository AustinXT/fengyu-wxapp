/**
 * 购物车工具测试
 * 覆盖全部 8 个导出函数：getCart/addToCart/updateQuantity/removeFromCart/clearCart/getCartCount/getCartTotal/setAllSelected
 */

import {
  getCart,
  addToCart,
  updateQuantity,
  removeFromCart,
  clearCart,
  getCartCount,
  getCartTotal,
  setAllSelected,
  type CartItem,
} from '../../utils/cart'

function makeItem(overrides: Partial<CartItem> = {}): Omit<CartItem, 'quantity' | 'addedAt'> {
  return {
    skuId: overrides.skuId ?? 'sku-1',
    spuId: overrides.spuId ?? 'spu-1',
    spuName: overrides.spuName ?? '美白护理',
    skuDisplayName: overrides.skuDisplayName ?? '10次卡',
    coverImage: overrides.coverImage ?? '',
    price: overrides.price ?? 100,
    bigCategory: overrides.bigCategory ?? '护理项目',
    productType: overrides.productType ?? '疗程卡',
  }
}

beforeEach(() => {
  ;(wx as any).__resetStorage()
})

describe('getCart', () => {
  test('空存储返回空购物车', () => {
    const cart = getCart()
    expect(cart.items).toEqual([])
    expect(cart.updatedAt).toBeGreaterThan(0)
  })

  test('有数据时返回已有购物车', () => {
    const saved = { items: [{ skuId: 'sku-1', quantity: 2 }], updatedAt: 123 }
    wx.setStorageSync('cart', saved)
    const cart = getCart()
    expect(cart.items).toHaveLength(1)
  })
})

describe('addToCart', () => {
  test('添加新商品', () => {
    const cart = addToCart(makeItem())
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0].skuId).toBe('sku-1')
    expect(cart.items[0].quantity).toBe(1)
    expect(cart.items[0].addedAt).toBeGreaterThan(0)
  })

  test('添加已存在商品 → 数量累加', () => {
    addToCart(makeItem(), 2)
    const cart = addToCart(makeItem(), 3)
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0].quantity).toBe(5)
  })

  test('添加不同 SKU → 独立条目', () => {
    addToCart(makeItem({ skuId: 'sku-1' }))
    const cart = addToCart(makeItem({ skuId: 'sku-2' }))
    expect(cart.items).toHaveLength(2)
  })

  test('指定数量', () => {
    const cart = addToCart(makeItem(), 5)
    expect(cart.items[0].quantity).toBe(5)
  })

  test('持久化到 storage', () => {
    addToCart(makeItem())
    const stored = wx.getStorageSync('cart')
    expect(stored.items).toHaveLength(1)
  })
})

describe('updateQuantity', () => {
  test('更新数量', () => {
    addToCart(makeItem(), 3)
    const cart = updateQuantity('sku-1', 5)
    expect(cart.items[0].quantity).toBe(5)
  })

  test('数量 <= 0 时删除商品', () => {
    addToCart(makeItem())
    const cart = updateQuantity('sku-1', 0)
    expect(cart.items).toHaveLength(0)
  })

  test('负数量也删除', () => {
    addToCart(makeItem())
    const cart = updateQuantity('sku-1', -1)
    expect(cart.items).toHaveLength(0)
  })

  test('SKU 不存在时不修改', () => {
    addToCart(makeItem())
    const cart = updateQuantity('nonexistent', 10)
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0].quantity).toBe(1)
  })
})

describe('removeFromCart', () => {
  test('删除指定商品', () => {
    addToCart(makeItem({ skuId: 'sku-1' }))
    addToCart(makeItem({ skuId: 'sku-2' }))
    const cart = removeFromCart('sku-1')
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0].skuId).toBe('sku-2')
  })

  test('删除不存在的商品 → 不影响', () => {
    addToCart(makeItem())
    const cart = removeFromCart('nonexistent')
    expect(cart.items).toHaveLength(1)
  })
})

describe('clearCart', () => {
  test('清空购物车', () => {
    addToCart(makeItem({ skuId: 'sku-1' }))
    addToCart(makeItem({ skuId: 'sku-2' }))
    clearCart()
    const cart = getCart()
    expect(cart.items).toEqual([])
  })
})

describe('getCartCount', () => {
  test('空购物车返回 0', () => {
    expect(getCartCount()).toBe(0)
  })

  test('返回总数量（非 SKU 种类数）', () => {
    addToCart(makeItem({ skuId: 'sku-1' }), 3)
    addToCart(makeItem({ skuId: 'sku-2' }), 2)
    expect(getCartCount()).toBe(5)
  })
})

describe('getCartTotal', () => {
  test('空购物车返回 0', () => {
    expect(getCartTotal()).toBe(0)
  })

  test('返回总价（price × quantity 之和）', () => {
    addToCart(makeItem({ skuId: 'sku-1', price: 100 }), 2) // 200
    addToCart(makeItem({ skuId: 'sku-2', price: 50 }), 3)  // 150
    expect(getCartTotal()).toBe(350)
  })
})

describe('setAllSelected', () => {
  test('全选 → 所有 item 的 selected 设为 true', () => {
    const items = [
      { ...makeItem({ skuId: 'sku-1' }), quantity: 1, addedAt: 1 },
      { ...makeItem({ skuId: 'sku-2' }), quantity: 2, addedAt: 2 },
    ] as CartItem[]

    const result = setAllSelected(true, items)
    expect(result.every((i: any) => i.selected === true)).toBe(true)
  })

  test('取消全选 → 所有 item 的 selected 设为 false', () => {
    const items = [
      { ...makeItem({ skuId: 'sku-1' }), quantity: 1, addedAt: 1 },
    ] as CartItem[]

    const result = setAllSelected(false, items)
    expect(result.every((i: any) => i.selected === false)).toBe(true)
  })

  test('不修改原数组', () => {
    const items = [
      { ...makeItem({ skuId: 'sku-1' }), quantity: 1, addedAt: 1 },
    ] as CartItem[]

    const result = setAllSelected(true, items)
    expect(result).not.toBe(items)
    expect((items[0] as any).selected).toBeUndefined()
  })
})
