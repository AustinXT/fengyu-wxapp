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
  sanitizeCoverImage,
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
    const saved = { items: [{ skuId: 'sku-1', quantity: 2, price: 100 }], updatedAt: 123 }
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

/**
 * issue #230：购物车是 localStorage 持久化快照，`coverImage` 在加购那一刻拷贝进来，
 * 之后不再回源。云函数改为只下发缩略 URL 后，**发版前**加购的条目里仍是原图 URL ——
 * 服务端改造对它们不起作用，lazy-load 也救不了（购物车条目少，首屏即全部可见）。
 *
 * 这里只做**拒绝**不做构造：不含缩略参数的一律置空走占位图。
 * 刻意不在前端重拼 URL —— URL 构造必须由服务端完全掌控。
 */
describe('issue #230：存量购物车快照的封面净化', () => {
  const COS = 'https://x.tcb.qcloud.la/product-covers/a.jpg'

  function seedStorage(items: any[]) {
    ;(wx.setStorageSync as any)('cart', { items, updatedAt: Date.now() })
  }

  test('box 模式的缩略 URL 保留', () => {
    seedStorage([{ skuId: 's1', price: 100, quantity: 1, coverImage: `${COS}?imageMogr2/thumbnail/1080x1080` }])
    expect(getCart().items[0].coverImage).toBe(`${COS}?imageMogr2/thumbnail/1080x1080`)
  })

  test('面积模式的缩略 URL 同样保留', () => {
    // 判据必须同时认 box(`NxN`) 与面积(`N@`) 两种形态，否则详情图链路会被误杀
    seedStorage([{ skuId: 's1', price: 100, quantity: 1, coverImage: `${COS}?imageMogr2/thumbnail/2250000@` }])
    expect(getCart().items[0].coverImage).toBe(`${COS}?imageMogr2/thumbnail/2250000@`)
  })

  test('未缩略的存量原图 URL 被置空', () => {
    seedStorage([{ skuId: 's1', price: 100, quantity: 1, coverImage: COS }])
    expect(getCart().items[0].coverImage).toBe('')
  })

  test('带其它处理参数的 URL 也被置空（imageView2 是放大通道）', () => {
    seedStorage([{ skuId: 's1', price: 100, quantity: 1, coverImage: `${COS}?imageView2/1/w/50000` }])
    expect(getCart().items[0].coverImage).toBe('')
  })

  /**
   * 双谱系评审独立指出：净化逻辑自身不能 fail-open。
   * 原实现用 `url.includes('imageMogr2/thumbnail/')` 做子串判断，下面这些全都会被放行。
   */
  describe('净化判据自身不得 fail-open', () => {
    test('非 COS 域名把缩略串塞进别的参数值里 —— codex 给出的构造', () => {
      // includes() 命中，但 img.example.com 根本不执行数据万象，返回的是原图
      seedStorage([{ skuId: 's1', price: 100, quantity: 1,
        coverImage: 'https://img.example.com/huge.png?x=imageMogr2/thumbnail/1080x1080' }])
      expect(getCart().items[0].coverImage).toBe('')
    })

    test('管道链后段接放大规则 —— GLM 给出的构造', () => {
      seedStorage([{ skuId: 's1', price: 100, quantity: 1,
        coverImage: `${COS}?imageMogr2/thumbnail/400x400|imageView2/1/w/50000` }])
      expect(getCart().items[0].coverImage).toBe('')
    })

    test('形态合法但档位异常大（10000x10000 仍是 400MB 解码）', () => {
      seedStorage([{ skuId: 's1', price: 100, quantity: 1,
        coverImage: `${COS}?imageMogr2/thumbnail/10000x10000` }])
      expect(getCart().items[0].coverImage).toBe('')
    })

    test('面积模式档位异常大同样拒绝', () => {
      seedStorage([{ skuId: 's1', price: 100, quantity: 1,
        coverImage: `${COS}?imageMogr2/thumbnail/99999999@` }])
      expect(getCart().items[0].coverImage).toBe('')
    })

    test('把可信域名塞进 userinfo 伪装', () => {
      seedStorage([{ skuId: 's1', price: 100, quantity: 1,
        coverImage: 'https://x.tcb.qcloud.la@evil.com/d/a.jpg?imageMogr2/thumbnail/400x400' }])
      expect(getCart().items[0].coverImage).toBe('')
    })

    test('全大写处理指令被拒 —— 数据万象大小写敏感，IMAGEMOGR2 不生效', () => {
      // codex 第二轮命中：给整条正则加 /i 会放行这个构造，而它返回的是原图。
      // 注意上一版的子串判断反而拒绝了它 —— 这条防止再退步一次。
      seedStorage([{ skuId: 's1', price: 100, quantity: 1,
        coverImage: `${COS}?IMAGEMOGR2/THUMBNAIL/400x400` }])
      expect(getCart().items[0].coverImage).toBe('')
    })

    test('混合大小写指令同样被拒', () => {
      seedStorage([{ skuId: 's1', price: 100, quantity: 1,
        coverImage: `${COS}?ImageMogr2/Thumbnail/400x400` }])
      expect(getCart().items[0].coverImage).toBe('')
    })

    test('零值档位被拒（腾讯云规定 1~10000，0x2000 会裂图）', () => {
      for (const rule of ['0x2000', '0x0', '0@']) {
        seedStorage([{ skuId: 's1', price: 100, quantity: 1,
          coverImage: `${COS}?imageMogr2/thumbnail/${rule}` }])
        expect(getCart().items[0].coverImage).toBe('')
      }
    })

    test('缩略参数后面还跟着别的 query', () => {
      seedStorage([{ skuId: 's1', price: 100, quantity: 1,
        coverImage: `${COS}?imageMogr2/thumbnail/400x400&imageView2/1/w/50000` }])
      expect(getCart().items[0].coverImage).toBe('')
    })
  })

  test('非字符串 / 缺字段一律归一为空串，不抛', () => {
    seedStorage([
      { skuId: 's1', price: 100, quantity: 1, coverImage: null },
      { skuId: 's2', price: 100, quantity: 1 },
      { skuId: 's3', price: 100, quantity: 1, coverImage: 42 },
    ])
    for (const item of getCart().items) {
      expect(item.coverImage).toBe('')
    }
  })
})

/**
 * issue #230 · 两端判据的**闭环守护**（GLM 第二轮 P2-1 提出）。
 *
 * 净化器是云函数 `safeThumbUrl` / `safeThumbUrlByArea` 的**镜像判据**，
 * 两边各写一份就会漂移。GLM 实测出 4 处不对称：服务端接受 `http://`、FQDN 尾点、
 * 非默认端口、`#fragment`，而前端正则当时全会误杀 —— 后果是**新加购**的条目
 * 封面也静默变占位图（无报错，极难定位）。当时不可达只因生产 URL 恰好都规范。
 *
 * 本项目对 error-codes / refund-cascade 有 cross-end 字面量 snapshot 的惯例，
 * 这里是等价物：把云函数**会下发的各种形态**喂给净化器，断言全部被接受。
 * 任一端收紧/放宽而另一端没跟上，这组用例立刻转红。
 *
 * fixture 按云函数 `safeThumbUrl` 的实际输出形态构造（它用 URL 对象重建 URL，
 * 故端口、尾点、fragment 都会原样保留在输出里）。
 */
describe('issue #230：净化器必须接受云函数的全部合法下发形态', () => {
  const HOST = 'test-env-1300000000.tcb.qcloud.la'
  // 三个档位对应 PRODUCT_THUMB_BOX_SMALL / _LARGE / _DETAIL_IMAGE_MAX_PIXELS
  const RULES = ['imageMogr2/thumbnail/400x400', 'imageMogr2/thumbnail/1080x1080', 'imageMogr2/thumbnail/2250000@']

  const SHAPES: Array<[string, string]> = [
    ['https 常规', `https://${HOST}/product-covers/a.jpg`],
    ['http（云函数 safeThumbUrl 接受 https?）', `http://${HOST}/product-covers/a.jpg`],
    ['FQDN 尾点（云函数归一后放行）', `https://${HOST}./product-covers/a.jpg`],
    ['非默认端口（云函数只校验 hostname）', `https://${HOST}:8443/product-covers/a.jpg`],
    ['大写扩展名', `https://${HOST}/product-covers/UPPER.PNG`],
    ['大写域名（DNS 不敏感）', `https://TEST-ENV-1300000000.TCB.QCLOUD.LA/product-covers/a.jpg`],
    ['详情图目录 webp', `https://${HOST}/product-details/1789097186265-apa9p0.webp`],
    ['jpeg 扩展名', `https://${HOST}/product-covers/a.jpeg`],
  ]

  for (const [name, base] of SHAPES) {
    for (const rule of RULES) {
      test(`接受：${name} + ${rule}`, () => {
        expect(sanitizeCoverImage(`${base}?${rule}`)).toBe(`${base}?${rule}`)
      })
    }
  }

  test('接受：带 #fragment 的下发值（云函数不剥 hash，参数拼在 fragment 前）', () => {
    const u = `https://${HOST}/product-covers/a.jpg?imageMogr2/thumbnail/400x400#sec`
    expect(sanitizeCoverImage(u)).toBe(u)
  })
})
