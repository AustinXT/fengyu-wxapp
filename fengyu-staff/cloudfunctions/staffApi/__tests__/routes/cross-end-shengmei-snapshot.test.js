/**
 * 跨端守护：服务明细 is_shengmei 快照取值顺序（#378）
 *
 * 口径：服务单创建时取 product_skus.is_shengmei 当前值，SKU 为 NULL 时回退 sale_items 开单快照。
 * 写入点只有两处，各自独立副本（禁止跨端共享目录）：
 *   - fengyu-staff/cloudfunctions/staffApi/routes/service.js  create（pg 原生 SQL）
 *   - fengyu-admin/src/actions/services.ts                   createServiceOrder（Drizzle sql 模板）
 * 两端各自的单测钉住了自己的顺序；本文件防「只改一端」——任一端顺序或写法漂移即红。
 */
const fs = require('node:fs')
const path = require('node:path')

const STAFF_SERVICE_JS = path.resolve(__dirname, '../../routes/service.js')
const ADMIN_SERVICES_TS = path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/services.ts')

/** 提取所有以 is_shengmei 为参数的 COALESCE(...) 调用，并把两端的列写法归一成 `sku` / `sale_item` */
function shengmeiCoalesceCalls(text) {
  const calls = text.match(/COALESCE\(\s*[^()]*?is_?[sS]hengmei[^()]*\)/g) || []
  return calls.map((call) =>
    call
      .replace(/\$\{productSkus\.isShengmei\}|\bps\.is_shengmei\b/g, 'sku')
      .replace(/\$\{saleItems\.isShengmei\}|\bsi\.is_shengmei\b/g, 'sale_item')
      .replace(/\s+/g, ''),
  )
}

describe('跨端：service_items.is_shengmei 快照取值顺序（#378）', () => {
  const staff = shengmeiCoalesceCalls(fs.readFileSync(STAFF_SERVICE_JS, 'utf8'))
  const admin = shengmeiCoalesceCalls(fs.readFileSync(ADMIN_SERVICES_TS, 'utf8'))

  test('staff service.js 只有一处生美 COALESCE，且 SKU 优先、sale_items 兜底', () => {
    expect(staff).toEqual(['COALESCE(sku,sale_item)'])
  })

  test('admin services.ts 只有一处生美 COALESCE，且 SKU 优先、sale_items 兜底', () => {
    expect(admin).toEqual(['COALESCE(sku,sale_item)'])
  })

  test('两端逐字等价', () => {
    expect(staff).toEqual(admin)
  })
})
