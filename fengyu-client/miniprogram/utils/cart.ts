// utils/cart.ts - 购物车工具类

const CART_KEY = 'cart';

export interface CartItem {
  skuId: string;
  spuId: string;
  spuName: string;
  skuDisplayName: string;
  coverImage: string;
  /** 成交价（会员价分流后：会员=会员价、非会员=标价；加购时按当时会员身份定） */
  price: number;
  /** 标价（划线展示用）；listPrice > price 才划线。会员价分流前的老数据可能缺失。 */
  listPrice?: number;
  quantity: number;
  bigCategory: string;
  productType: string;
  /**
   * PR-D：一级品项 kind 名（来自 product_categories 一级行）。
   * 与 bigCategory（=商城分类 mall_categories.category_name）不同：productKind 是
   * 业务品项（护理项目/家居产品/体验卡 + 任意 admin 新建一级 kind）。
   * 充值卡已剥离 SKU 域（2026-05-20），走独立 prepaid-cards 页，不入商城购物车。
   * 可选——加购时若 SKU 数据未携带则保持 undefined，购物车 tag 走 bigCategory 兜底。
   */
  productKind?: string;
  /**
   * PR-D：一级 kind 行的 display_color HEX 值（DB 驱动）。
   * 与 productKind 配套；缺失时 tag 退化为 type='primary'。
   */
  kindDisplayColor?: string;
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
 * 净化用的解码内存上限。不硬编码云函数那几个具体档位——那会变成第二份会漂移的常量表；
 * 只卡「解码内存是否在合理范围」，任何合理档位都放行，异常大的拒掉。
 * 2000×2000×4 ≈ 16MB / 4,000,000×4 ≈ 16MB，与 PRODUCT_THUMB_BOX_LARGE(1080) 留足余量。
 */
const SANITIZE_MAX_EDGE = 2000;
const SANITIZE_MAX_AREA = 4000000;

/** 把 URL 拆成 authority / path / query 三段，便于逐段用**各自正确的大小写规则**校验 */
const URL_PARTS_PATTERN = /^(https?):\/\/([^/?#]+)(\/[^?#]*)\?(.*)$/i;

/** 对象键形态：两段、纯 ASCII、图片扩展名。与云函数 `safeThumbUrl` 的白名单同形 */
const OBJECT_KEY_PATTERN = /^\/[\w-]+\/[\w.-]+\.(?:png|jpe?g|webp|gif)$/i;

/**
 * 处理指令白名单。**刻意不加 `/i`** —— 数据万象的处理指令是大小写敏感的，
 * `?IMAGEMOGR2/THUMBNAIL/400x400` 不会被执行，请求退化成普通对象访问、返回原图。
 * 对它做大小写折叠就是又一个 fail-open（codex 第二轮命中：上一版的子串判断反而拒绝了这个构造）。
 *
 * 末尾 `$` 锚定保证 query 里**只有**这一条规则，杜绝
 * `?imageMogr2/thumbnail/400x400|imageView2/1/w/50000` 这类管道链后段放大。
 */
const THUMB_RULE_PATTERN = /^imageMogr2\/thumbnail\/(\d+x\d+|\d+@)$/;

/**
 * 档位数值本身也要卡：形态合法但 `10000x10000` 仍是 400MB 解码。
 * 下界取 1 —— 腾讯云规定 Width/Height 为 1~10000，`0x2000` 是无效规则（会裂图）。
 */
function isSafeThumbRule(rule: string): boolean {
  const box = rule.match(/^(\d+)x(\d+)$/);
  if (box) {
    const w = Number(box[1]);
    const h = Number(box[2]);
    return w > 0 && h > 0 && w <= SANITIZE_MAX_EDGE && h <= SANITIZE_MAX_EDGE;
  }
  const area = rule.match(/^(\d+)@$/);
  if (area) {
    const a = Number(area[1]);
    return a > 0 && a <= SANITIZE_MAX_AREA;
  }
  return false;
}

/**
 * issue #230：购物车是 localStorage **持久化快照** —— `coverImage` 在加购那一刻
 * 从接口返回值拷贝进来，之后不再回源。
 *
 * 云函数已改为只下发缩略 URL，但**本次发版之前**加购的条目里躺的仍是原图 URL，
 * 服务端改造对它们完全不起作用（这也是 lazy-load 救不了的：购物车条目少，首屏即全部可见）。
 *
 * 这里只做**拒绝**不做构造：不是完整合规形态的一律置空，走已有的 cover-placeholder 分支。
 * 刻意不在前端重拼 URL —— URL 构造必须由服务端完全掌控（前端拼一份就等于多一处会漂移的规则）。
 * 校验与构造是两回事：这里是纵深防御的**拒绝**规则，方向是 fail-closed。
 */
export function sanitizeCoverImage(url: unknown): string {
  if (typeof url !== 'string') return '';

  // 先剥 fragment 再拆：云函数用 URL 对象重建 URL，源 URL 带 #frag 时
  // 缩略参数会拼在 fragment 之前，整串以 fragment 结尾。不剥就会误杀合法下发值。
  const parts = url.split('#')[0].match(URL_PARTS_PATTERN);
  if (!parts) return '';
  const [, , authority, path, query] = parts;

  // 把可信域名塞进 userinfo 的伪装（`https://x.tcb.qcloud.la@evil.com/...`）
  if (authority.indexOf('@') !== -1) return '';

  // 域名大小写不敏感（DNS 语义），并去掉 FQDN 尾点——
  // `a.tcb.qcloud.la.` 与 `a.tcb.qcloud.la` 等价，云函数侧同样做了归一。
  // 端口一并剥掉：云函数只校验 hostname，非默认端口的 URL 它会照常下发。
  const host = authority.split(':')[0].replace(/\.$/, '');
  if (!/\.tcb\.qcloud\.la$/i.test(host)) return '';

  if (!OBJECT_KEY_PATTERN.test(path)) return '';

  // 处理指令**大小写敏感**（见 THUMB_RULE_PATTERN 注释）
  const rule = query.match(THUMB_RULE_PATTERN);
  if (!rule) return '';

  return isSafeThumbRule(rule[1]) ? url : '';
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
    // 存量条目的封面可能是未缩略的原图 URL，置空走占位图
    data.items.forEach((i: CartItem) => {
      i.coverImage = sanitizeCoverImage(i.coverImage);
    });
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
