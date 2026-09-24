/**
 * staffApi 专属：开单页套餐封面的档位选择（issue #232）
 *
 * `utils/image.js` 本身的行为断言在 `image.test.js` —— 那份与 clientApi 副本
 * **字节一致**，由 `image-cross-copy.test.js` 守护。端专属的用法断言必须放这里，
 * 加进 image.test.js 会破坏字节一致、让两端测试悄悄漂移
 * （这正是本 PR 在 utils/image.js 上要防的东西，不该在测试层重新犯一遍）。
 *
 * 这是 staffApi 当前**唯一**的外部图片下发点（`routes/product.js` 的 bundleGroups）。
 * 渲染侧 `components/bundle-picker/bundle-picker.wxml`，
 * 展示位 `.bundle-cover { width: 200rpx }`（**只设了宽**）+ `mode="aspectFill"`。
 */
const { safeThumbUrl, PRODUCT_THUMB_BOX_SMALL } = require('../../utils/image')

const COS_URL =
  'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la/product-covers/1789097186265-apa9p0.png'

describe('staff 开单页套餐封面（issue #232）', () => {
  test('复用 client 的小缩略档位 400，不另立档位', () => {
    // ⚠️ 别照着"200rpx 宽 → 3x 屏 344 物理像素 → 400 够用"来理解这个数：
    // 约束展示位的是**高**不是宽，而 400 在高度方向其实不够（约 1.4 倍放大）。
    // 完整算法与"为什么仍然不抬档"见 utils/image.js 里该常量的注释。
    expect(PRODUCT_THUMB_BOX_SMALL).toBe(400)
  })

  test('单张封面解码内存压到 1MB 以内', () => {
    expect(PRODUCT_THUMB_BOX_SMALL * PRODUCT_THUMB_BOX_SMALL * 4).toBeLessThan(1024 * 1024)
  })

  test('套餐封面用 box 模式而非面积模式', () => {
    // 封面是常规比例图（prod 43/43 长宽比恒 1.56），展示位又是 aspectFill 的方块，
    // box 的 contain 语义与它匹配。面积模式会让细长图输出超宽/超高，裁切后观感更差。
    // 长图（detail_images）才用面积模式。
    expect(safeThumbUrl(COS_URL, PRODUCT_THUMB_BOX_SMALL)).toBe(
      `${COS_URL}?imageMogr2/thumbnail/400x400`
    )
  })

  test('封面不可缩略时返回 null，前端 wx:if 走占位而非裂图', () => {
    expect(safeThumbUrl(null, PRODUCT_THUMB_BOX_SMALL)).toBeNull()
    expect(safeThumbUrl('', PRODUCT_THUMB_BOX_SMALL)).toBeNull()
    expect(safeThumbUrl('https://img.example.com/a.jpg', PRODUCT_THUMB_BOX_SMALL)).toBeNull()
  })

  test('⚠️ 页面级总量无上界——本档位只保证单张，不保证一页', () => {
    // 这条不是在断言安全，是在**把已知缺口钉成文档**。
    //
    // `_queryMallBundleGroups` 的 SQL 没有 LIMIT，`bundle-picker` 全量 wx:for 渲染，
    // 所以页面级解码量 = 套餐数 × 0.64MB，线性无界。
    // 曾经这里写的是 `expect(bytes * 32).toBeLessThan(21MB)`——把"生产现在有 32 个套餐"
    // 这个**数据快照**当成了不变量：admin 多建套餐，断言照样绿，
    // 而它声称保证的页面级上界早已不成立。那种断言比没有更糟。
    //
    // 真正的上界要靠 SQL LIMIT / 前端分页（client 侧同类缺口见 issue #248）。
    // 当前缓解只有 wxml 里的 lazy-load（只解码可见项）——删掉它就穿，所以钉住它。
    const wxml = require('node:fs').readFileSync(
      require('node:path').resolve(
        __dirname, '../../../../miniprogram/components/bundle-picker/bundle-picker.wxml'
      ), 'utf8'
    )
    expect(wxml).toContain('lazy-load')
    // binderror 是「URL 有效但 COS 出不来图」时退回占位的唯一兜底，同样别被顺手删掉
    expect(wxml).toContain('binderror="onCoverError"')
  })
})
