/**
 * 购物车工具测试
 * 覆盖全部 8 个导出函数：getCart/addToCart/updateQuantity/removeFromCart/clearCart/getCartCount/getCartTotal/setAllSelected
 */

import { createRequire } from 'node:module'
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

    test('前导零档位被拒（Number("0400")=400 会骗过纯数值校验）', () => {
      for (const rule of ['0400x0400', '01080x01080', '02250000@']) {
        seedStorage([{ skuId: 's1', price: 100, quantity: 1,
          coverImage: `${COS}?imageMogr2/thumbnail/${rule}` }])
        expect(getCart().items[0].coverImage).toBe('')
      }
    })

    test('反斜杠伪装被拒 —— WHATWG URL 把 \\ 当 /，真实 host 是 evil.com', () => {
      seedStorage([{ skuId: 's1', price: 100, quantity: 1,
        coverImage: 'https://evil.com\\x.tcb.qcloud.la/product-covers/a.jpg?imageMogr2/thumbnail/400x400' }])
      expect(getCart().items[0].coverImage).toBe('')
    })

    test('tab / 空格 / %23 同族变体一并被拒（host 字符集白名单）', () => {
      for (const host of ['evil.com\tx.tcb.qcloud.la', 'evil.com x.tcb.qcloud.la', 'evil.com%23x.tcb.qcloud.la']) {
        seedStorage([{ skuId: 's1', price: 100, quantity: 1,
          coverImage: `https://${host}/product-covers/a.jpg?imageMogr2/thumbnail/400x400` }])
        expect(getCart().items[0].coverImage).toBe('')
      }
    })

    test('反斜杠 × userinfo 组合被拒 —— 拆开检查必漏的那一类', () => {
      // codex 第四轮命中：`lastIndexOf('@')` 会取到可信域名，`\` 检查被整个跳过。
      // 真实 host 是 evil.com（WHATWG 把 \ 当 /，@可信域名 已属于 path）。
      // 这是连续第三个打穿「拆开逐段检查」思路的构造，故改为 authority 整体白名单。
      for (const u of [
        'https://evil.com\\@x.tcb.qcloud.la/d/a.jpg?imageMogr2/thumbnail/400x400',
        'https://evil.com\\@a@x.tcb.qcloud.la/d/a.jpg?imageMogr2/thumbnail/400x400',
        'https://evil.com\\\\@x.tcb.qcloud.la/d/a.jpg?imageMogr2/thumbnail/400x400',
      ]) {
        seedStorage([{ skuId: 's1', price: 100, quantity: 1, coverImage: u }])
        expect(getCart().items[0].coverImage).toBe('')
      }
    })

    test('端口超出 WHATWG 上限被拒（加载端会判 URL 无效 → 加载失败图而非占位图）', () => {
      // 两谱系第五轮独立指出的唯一 P3。方向本就是 fail-closed，修它只为让
      // 「放行的 URL 一定能被加载端正常解析」这个性质成立。
      for (const port of ['65536', '99999999999']) {
        seedStorage([{ skuId: 's1', price: 100, quantity: 1,
          coverImage: `https://x.tcb.qcloud.la:${port}/d/a.jpg?imageMogr2/thumbnail/400x400` }])
        expect(getCart().items[0].coverImage).toBe('')
      }
    })

    test('合法端口仍放行（云函数会原样下发非默认端口）', () => {
      const u = 'https://x.tcb.qcloud.la:8443/d/a.jpg?imageMogr2/thumbnail/400x400'
      seedStorage([{ skuId: 's1', price: 100, quantity: 1, coverImage: u }])
      expect(getCart().items[0].coverImage).toBe(u)
      const edge = 'https://x.tcb.qcloud.la:65535/d/a.jpg?imageMogr2/thumbnail/400x400'
      seedStorage([{ skuId: 's1', price: 100, quantity: 1, coverImage: edge }])
      expect(getCart().items[0].coverImage).toBe(edge)
    })

    test('userinfo 含分隔符的伪装被拒', () => {
      for (const u of [
        'https://evil.com/@x.tcb.qcloud.la/d/a.jpg?imageMogr2/thumbnail/400x400',
        'https://evil.com?@x.tcb.qcloud.la/d/a.jpg?imageMogr2/thumbnail/400x400',
        'https://evil.com#@x.tcb.qcloud.la/d/a.jpg?imageMogr2/thumbnail/400x400',
      ]) {
        seedStorage([{ skuId: 's1', price: 100, quantity: 1, coverImage: u }])
        expect(getCart().items[0].coverImage).toBe('')
      }
    })

    test('userinfo 里带可信域名的伪装被拒，但 user@可信域名 放行（与服务端一致）', () => {
      seedStorage([
        { skuId: 's1', price: 100, quantity: 1,
          coverImage: `https://x.tcb.qcloud.la@evil.com/d/a.jpg?imageMogr2/thumbnail/400x400` },
        { skuId: 's2', price: 100, quantity: 1,
          coverImage: `https://user@x.tcb.qcloud.la/d/a.jpg?imageMogr2/thumbnail/400x400` },
      ])
      const items = getCart().items
      expect(items[0].coverImage).toBe('')
      expect(items[1].coverImage).toBe('https://user@x.tcb.qcloud.la/d/a.jpg?imageMogr2/thumbnail/400x400')
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
 * issue #230 · 两端判据的**闭环守护**（真正绑定服务端实现）
 *
 * 净化器 `sanitizeCoverImage` 是云函数 `safeThumbUrl` / `safeThumbUrlByArea` 的**镜像判据**，
 * 两边各写一份必然漂移，而漂移是**静默**的：
 * - 前端比服务端严 → 新加购条目封面变占位图（无报错、极难定位）
 * - 前端比服务端松 → fail-open，未缩略的外域原图被放行（就是 #213 的崩溃）
 *
 * ⚠️ 这组用例**直接 require 云函数模块**跑真实构造器，不是手写 fixture。
 * 但它仍是**有限样本**守护，覆盖的是「已知可达形态」而非全部输入空间 ——
 * 例如 `foo~bar.tcb.qcloud.la` 服务端接受而前端拒（`~` 不在 host 字符集里），
 * 该形态不会是 CloudBase 正常签发的桶域名，故不追平（codex 第四轮 P3-2）。
 * 第一版曾用手写 `SHAPES` 列举形态，被 codex 指出「没有绑定真实实现，
 * 『任一端漂移立即转红』的注释不成立」——并当场给出漏网反例（userinfo 形态）。
 * 项目现有的 cross-end 守护（`cross-end-error-codes-snapshot.test.js`）同样是 require 另一端模块，做法一致。
 */
describe('issue #230：净化器与云函数构造器的闭环守护', () => {
  const req = createRequire(import.meta.url)
  const img = req('../../../cloudfunctions/clientApi/utils/image.js')

  const H = 'test-env-1300000000.tcb.qcloud.la'

  /** 构造器**接受**的输入（服务端会下发）→ 净化器必须**接受**其输出 */
  const SERVER_ACCEPTS = [
    ['https 常规', `https://${H}/product-covers/a.jpg`],
    ['http', `http://${H}/product-covers/a.jpg`],
    ['FQDN 尾点', `https://${H}./product-covers/a.jpg`],
    ['非默认端口', `https://${H}:8443/product-covers/a.jpg`],
    ['userinfo（云函数按 hostname 判据放行）', `https://user@${H}/product-covers/a.jpg`],
    ['大写扩展名', `https://${H}/product-covers/UPPER.PNG`],
    ['jpeg', `https://${H}/product-covers/a.jpeg`],
    ['webp 详情图', `https://${H}/product-details/1789097186265-apa9p0.webp`],
    ['带 #fragment', `https://${H}/product-covers/a.jpg#sec`],
    ['原 URL 已带放大参数（会被整串丢弃）', `https://${H}/product-covers/a.jpg?imageView2/1/w/50000`],
  ] as const

  /** 构造器**拒绝**的输入 → 净化器也必须拒绝（方向盲区：P1 的反斜杠洞正落在这一格） */
  const SERVER_REJECTS = [
    ['非 COS 域名', 'https://img.example.com/a.jpg'],
    ['userinfo 伪装可信域名', `https://${H}@evil.com/d/a.jpg`],
    ['反斜杠伪装（WHATWG 把 \\ 当 /）', `https://evil.com\\${H}/product-covers/a.jpg`],
    ['反斜杠 × userinfo 组合', `https://evil.com\\@${H}/product-covers/a.jpg`],
    ['反斜杠 × 双 @', `https://evil.com\\@a@${H}/product-covers/a.jpg`],
    ['对象键只有一段', `https://${H}/a.png`],
    ['非图片扩展名', `https://${H}/d/a.svg`],
    // ⚠️ 这条原始 URL 自带 query，下面拼规则时会出现双 `?`，不是良构 URL。
    // 保留原样是刻意的：它要测的是**云函数拒绝签名 URL**这件事，
    // 而净化器侧 THUMB_RULE 的 `^...$` 锚定对双 `?` 串同样必然拒，断言方向成立。
    // （GLM 第五轮 P3-4 指出此措辞，结论是无影响。）
    ['带 COS 签名', `https://${H}/d/a.png?q-sign-algorithm=sha1`],
    ['非 http(s)', `ftp://${H}/d/a.jpg`],
  ] as const

  const RULES: Array<[string, (u: string) => string | null, string]> = [
    ['box SMALL', (u) => img.safeThumbUrl(u, img.PRODUCT_THUMB_BOX_SMALL),
      `imageMogr2/thumbnail/${img.PRODUCT_THUMB_BOX_SMALL}x${img.PRODUCT_THUMB_BOX_SMALL}`],
    ['box LARGE', (u) => img.safeThumbUrl(u, img.PRODUCT_THUMB_BOX_LARGE),
      `imageMogr2/thumbnail/${img.PRODUCT_THUMB_BOX_LARGE}x${img.PRODUCT_THUMB_BOX_LARGE}`],
    ['area DETAIL', (u) => img.safeThumbUrlByArea(u, img.PRODUCT_DETAIL_IMAGE_MAX_PIXELS),
      `imageMogr2/thumbnail/${img.PRODUCT_DETAIL_IMAGE_MAX_PIXELS}@`],
  ]

  for (const [ruleName, build, ruleStr] of RULES) {
    for (const [shapeName, input] of SERVER_ACCEPTS) {
      test(`${ruleName} · 服务端下发「${shapeName}」→ 净化器必须接受`, () => {
        const out = build(input)
        // 前置断言：这些输入确实是服务端会接受的，否则用例本身失去意义
        expect(out, `构造器意外拒绝了 ${input}`).not.toBeNull()
        expect(sanitizeCoverImage(out as string)).toBe(out)
      })
    }

    for (const [shapeName, input] of SERVER_REJECTS) {
      test(`${ruleName} · 服务端拒绝「${shapeName}」→ 净化器也必须拒绝`, () => {
        expect(build(input), `构造器意外接受了 ${input}`).toBeNull()
        // 构造器拒绝时不会有输出；直接把**原始 URL 拼上该档位的合法规则**喂给净化器，
        // 模拟「脏数据混进 storage」——净化器同样不能放行。
        // ⚠️ 必须用 ruleStr 而不是写死 400x400：写死会让三个档位退化成同一个断言，
        //    面积分支若单独漂移就不会转红（codex 第四轮 P3-1）。
        expect(sanitizeCoverImage(`${input}?${ruleStr}`)).toBe('')
      })
    }
  }

  test('档位常量与净化器上限口径一致（净化器不能把合法档位误杀）', () => {
    for (const box of [img.PRODUCT_THUMB_BOX_SMALL, img.PRODUCT_THUMB_BOX_LARGE]) {
      const u = img.safeThumbUrl(`https://${H}/product-covers/a.jpg`, box)
      expect(sanitizeCoverImage(u)).toBe(u)
    }
    const areaUrl = img.safeThumbUrlByArea(`https://${H}/product-details/a.jpg`, img.PRODUCT_DETAIL_IMAGE_MAX_PIXELS)
    expect(sanitizeCoverImage(areaUrl)).toBe(areaUrl)
  })
})
