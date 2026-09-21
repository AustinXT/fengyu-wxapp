/**
 * 进销存单据中心跨端一致性守护（PR #113：单据端点收敛到 org_node_id 口径）
 *
 * 用户决策：不抽取 cloudfunctions-shared 共享代码，各端保留独立副本。
 * 一致性靠本 snapshot test 守护——任一端字面漂移即触发失败，
 * 错误信息提醒维护者同步另外一端。
 *
 * 守护对象：
 *   1. 单据端点列口径 — staff 单据 scope SQL 必须用 source_org_node_id /
 *      target_org_node_id（0038 已 RENAME，残留 *_location_id 即运行时报错）；
 *      db/schema/inventory.ts 的 inventory_docs 列定义是权威锚点。
 *      ├── fengyu-staff/cloudfunctions/staffApi/routes/inventory.js (pg)
 *      ├── fengyu-admin/src/lib/inventory/engine.ts (Drizzle)
 *      └── db/schema/inventory.ts（schema 权威）
 *
 *   2. 单据类型集合 — 两端独立定义的 DOC_PREFIX / INBOUND / OUTBOUND /
 *      NO_MOVEMENT / RECEIVE_REQUIRED / APPROVAL / RECEIVE_INBOUND_TYPE
 *      必须逐项一致（含数量断言，防止两端同时丢项仍比对相等）。
 *
 *   3. staff 端安全护栏 —
 *      a. 所有 throw new Error 的一级前缀 ⊆ 9 项错误码白名单
 *      b. assertNoStaffMoneyFields 金额字段禁提交保护必须存在
 */

const fs = require('node:fs')
const path = require('node:path')

const FILES = {
  staffInventoryJs: path.resolve(__dirname, '../../routes/inventory.js'),
  adminEngineTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/inventory/engine.ts'),
  // 盘点类型集合在 admin 侧住在独立模块（engine 与单据详情页共用单源），不在 engine.ts 里。
  adminStocktakeTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/inventory/stocktake.ts'),
  // 建批次的第三份副本：upsertLot 与 engine 的 ensureLotFromSku 同功能不同名。
  adminBusinessTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/inventory/business.ts'),
  dbSchemaInventoryTs: path.resolve(__dirname, '../../../../../db/schema/inventory.ts'),
}

function readFile(p) {
  return fs.readFileSync(p, 'utf8')
}

/** 截取 `const <name>(: 类型)? = { ... }` 对象字面量块（staff JS 与 admin TS 两种形态通用）。 */
function extractObjectBlock(src, varName) {
  const re = new RegExp(`const ${varName}[^=]*=\\s*\\{[\\s\\S]*?\\n\\}`)
  const m = src.match(re)
  if (!m) throw new Error(`未找到 ${varName} 对象定义`)
  return m[0]
}

/** 截取 `const <name>(: 类型)? = new Set([ ... ])` 集合成员（去引号、排序）。 */
function extractSetItems(src, varName) {
  const re = new RegExp(`const ${varName}[^=]*=\\s*new Set[^\\[]*\\[([\\s\\S]*?)\\]`)
  const m = src.match(re)
  if (!m) throw new Error(`未找到 ${varName} 集合定义`)
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
}

/** 提取对象块中 `'key': 'value'`（staff 键带引号）/ `key: 'value'`（admin TS 裸键）对，排序。 */
function extractQuotedPairs(block) {
  return [...block.matchAll(/'([^']+)'\s*:\s*'([^']+)'|([一-龥][一-龥A-Za-z0-9]*)\s*:\s*'([^']+)'/g)]
    .map((m) => `${m[1] ?? m[3]}=${m[2] ?? m[4]}`)
    .sort()
}

/**
 * 取包含 `needle` 的**整条**模板字符串字面量（一对反引号之间）。
 *
 * 用于「这条 SQL 里不许出现 X」这类断言：只截关键字附近的固定窗口是不够的 ——
 * 在关键字**前面**加一段 CTE（比如扣预留）就能滑出窗口，断言照样绿。
 *
 * ⚠️ **仅用于 staff 侧**：staff 的 SQL 是原生 pg 的纯 `$1/$2` 模板，没有 `${}` 插值，
 * 也就没有嵌套模板的歧义，简单的「前后各找一个反引号」是可靠的。
 * admin 侧是 drizzle 模板（`sql.join` 里就有嵌套反引号），源码正则天然不可靠 ——
 * 那边改用 `engine.test.ts` 的 `PgDialect().sqlToQuery` 断编译产物，严格更强。
 */
function enclosingTemplateLiteral(src, needle) {
  // ⚠️ 多命中要显式炸掉，不能静默取第一个：将来若在更早的行又写了一条同结构的
  //    在手量聚合 SQL，`indexOf` 会截到那一条，后面的 `not.toMatch(/reserv/i)`
  //    就守错了对象 —— 而且是静默守错。
  const hits = src.split(needle).length - 1
  if (hits > 1) throw new Error(`源码里有 ${hits} 处「${needle}」，本取法只认唯一一处，请改用更精确的锚点`)
  const at = src.indexOf(needle)
  if (at < 0) return null
  const start = src.lastIndexOf('`', at)
  const end = src.indexOf('`', at)
  if (start < 0 || end < 0) return null
  return src.slice(start + 1, end)
}

/** 提取所有 throw new Error 一级前缀（单引号与模板字符串两种形态；变量传入的跳过）。 */
function extractThrownPrefixes(src) {
  return [...src.matchAll(/throw new Error\(\s*['`]([A-Z_]+):/g)].map((m) => m[1])
}

const ERROR_PREFIX_WHITELIST = new Set([
  'UNAUTHORIZED',
  'PHONE_REQUIRED',
  'INVALID_PARAMS',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'INSUFFICIENT_BALANCE',
  'CONFLICT',
  'INVALID_STATE',
  'CLIENT_NOT_REGISTERED',
])

describe('PR #113 进销存单据组织端点跨端守护（staff / admin / schema）', () => {
  let staffSrc, adminSrc, schemaSrc

  beforeAll(() => {
    staffSrc = readFile(FILES.staffInventoryJs)
    adminSrc = readFile(FILES.adminEngineTs)
    schemaSrc = readFile(FILES.dbSchemaInventoryTs)
  })

  describe('§1 单据端点列口径：org_node_id（防回退 location_id）', () => {
    test('staff 单据 scope SQL 两处均按 source_org_node_id / target_org_node_id 过滤', () => {
      // 形态一：buildInventoryLocationScope helper（location_id → org_node_id 子查询映射）
      expect(staffSrc).toMatch(/source_org_node_id IN \(\s*SELECT org_node_id FROM inventory_locations WHERE location_id = ANY\(/)
      expect(staffSrc).toMatch(/target_org_node_id IN \(\s*SELECT org_node_id FROM inventory_locations WHERE location_id = ANY\(/)
      // 形态二：列表查询按 org 树递归展开（descendantOrgNodeIdsSql helper）过滤单据端点
      expect(staffSrc).toMatch(/d\.source_org_node_id IN \$\{descendantOrgNodeIdsSql\(idx\)\}/)
      expect(staffSrc).toMatch(/d\.target_org_node_id IN \$\{descendantOrgNodeIdsSql\(idx\)\}/)
      // helper 本体：带 path 环守卫的递归 CTE + 限定已建库存主体的组织节点
      expect(staffSrc).toMatch(/WITH RECURSIVE selected\(id, path\)/)
      expect(staffSrc).toMatch(/WHERE NOT child\.id = ANY\(selected\.path\)/)
      expect(staffSrc).toMatch(/SELECT id FROM selected WHERE id IN \(SELECT org_node_id FROM inventory_locations\)/)
    })

    test('staff 不得残留 source_location_id / target_location_id（0038 已 RENAME，残留即运行时报错）', () => {
      expect(staffSrc).not.toMatch(/source_location_id/)
      expect(staffSrc).not.toMatch(/target_location_id/)
    })

    test('schema 权威锚：inventory_docs 端点列经 inventory_locations.org_node_id 锚到组织节点', () => {
      // 0039 重建 FK 后的口径：单据端点列引用 inventoryLocations.orgNodeId
      //（inventory_locations.org_node_id 再 references org_nodes.id），不直接挂 orgNodes.id。
      expect(schemaSrc).toMatch(/sourceOrgNodeId: text\('source_org_node_id'\)\.references\(\s*\(\) => inventoryLocations\.orgNodeId/)
      expect(schemaSrc).toMatch(/targetOrgNodeId: text\('target_org_node_id'\)\.references\(\s*\(\) => inventoryLocations\.orgNodeId/)
    })

    test('admin engine.ts 单据读写同样使用 org 端点列（至少出现 source/target org_node_id）', () => {
      expect(adminSrc).toMatch(/source_org_node_id/)
      expect(adminSrc).toMatch(/target_org_node_id/)
    })
  })

  describe('§2 单据类型集合两端字面一致（含数量断言，防两端同时丢项）', () => {
    const CASES = [
      { name: 'INBOUND_DOC_TYPES', size: 12 },
      { name: 'OUTBOUND_DOC_TYPES', size: 10 },
      { name: 'NO_MOVEMENT_DOC_TYPES', size: 5 },
      { name: 'RECEIVE_REQUIRED_DOC_TYPES', size: 4 },
      { name: 'APPROVAL_DOC_TYPES', size: 4 },
      // admin 侧住在 stocktake.ts 而非 engine.ts（engine 与单据详情页共用单源）
      { name: 'STOCKTAKE_DOC_TYPES', size: 2, adminFile: 'adminStocktakeTs' },
    ]

    test.each(CASES)('$name 两端逐项一致且共 $size 项', ({ name, size, adminFile }) => {
      const staffItems = extractSetItems(staffSrc, name)
      const adminItems = extractSetItems(adminFile ? readFile(FILES[adminFile]) : adminSrc, name)
      expect(staffItems.length, `staff ${name} 项数漂移`).toBe(size)
      expect(adminItems.length, `admin ${name} 项数漂移`).toBe(size)
      expect(staffItems).toEqual(adminItems)
    })

    test('盘点账面数两端都写（staff 侧曾漏写导致 stock_snapshot 恒 NULL，#131）', () => {
      // 只比集合不够：两端集合一致但只有一端真的往 stock_snapshot 写账面数，
      // 同一种单据就会「admin 建的有账面数、staff 建的没有」。这里钉住写入形态本身。
      expect(staffSrc, 'staff 缺少「主体 + SKU 汇总在手量」查询').toMatch(
        /COALESCE\(SUM\(quantity_on_hand\), 0\)[\s\S]{0,200}?FROM inventory_stock_lots[\s\S]{0,200}?GROUP BY sku_id/,
      )
      expect(staffSrc, 'staff 的 stock_snapshot 参数仍写死 null').toMatch(
        /lot \? lot\.quantityOnHand : bookQuantity/,
      )
      const adminEngine = readFile(FILES.adminEngineTs)
      expect(adminEngine, 'admin 缺少「主体 + SKU 汇总在手量」查询').toMatch(
        /COALESCE\(SUM\(quantity_on_hand\), 0\)[\s\S]{0,200}?FROM inventory_stock_lots[\s\S]{0,200}?GROUP BY sku_id/,
      )
      // staff 侧必须**不扣预留**（#131 Q0）：出现 reservation 扣减即口径漂移。
      // ⚠️ 不能只截 `SUM(...)` → `GROUP BY` 那一段 —— 在它**前面**加一段扣预留的 CTE
      //    就绕过去了。取整条 SQL 字面量；staff 是原生 pg 的纯 `$1/$2` 模板、无 `${}`，
      //    没有嵌套模板的歧义，这个取法是可靠的。
      //
      // admin 侧在这里**只做存在性检查**（上面那条 toMatch，确认两端都有这条汇总查询，
      // 这是"跨端两边都写了"的对账点）；**不做口径扫描**。
      // admin 的口径由 `engine.test.ts` 用 drizzle 自己的编译器（`PgDialect().sqlToQuery`）
      // 断真正发给 PG 的 SQL 与参数，对内联 CTE / 嵌套 sql / query-builder 子查询一律有效，
      // 严格强于任何源码正则；在这儿再加一道弱的源码扫描反而误导。
      const staffLiteral = enclosingTemplateLiteral(staffSrc, 'COALESCE(SUM(quantity_on_hand), 0)')
      expect(staffLiteral, 'staff 取不到账面数查询所在的 SQL 字面量').toBeTruthy()
      // 保险丝：取法只在「模板里没有 ${}」时可靠。一旦 staff 那条 SQL 引入插值，
      // 截取跨度就可能错，而错了是**静默**的 —— 宁可在这里红一下提醒来人换取法。
      expect(staffLiteral, 'staff 账面数 SQL 引入了 ${} 插值，此处的截取法不再可靠').not.toContain('${')
      expect(staffLiteral, 'staff 的盘点账面数不该扣预留').not.toMatch(/reserv/i)
      expect(staffLiteral, 'staff 账面数必须按 sku_id 聚合').toMatch(/GROUP BY sku_id/)
      // admin 侧**不在这里加元断言**：grep「那行断言字符串还在不在」是假守护 ——
      // 把它注释掉照样匹配（注释里字符串还在），等价重写又会误红。
      // admin 的真守护是 engine.test.ts 里那条口径快照，且已接进 CI（lint.yml 的 admin job）。
    })

    test('两端都拦「同一 SKU 多行盘点」且话术一致', () => {
      // 账面数按 SKU 汇总，同 SKU 两行会各自拿到同一个完整账面数 → 差异是重复计算的废数
      const message = '同一 SKU 请合并为一条盘点明细'
      expect(staffSrc).toContain(message)
      expect(readFile(FILES.adminEngineTs)).toContain(message)
    })

    test('DOC_PREFIX 前缀映射两端逐对一致且共 33 对', () => {
      const staffPairs = extractQuotedPairs(extractObjectBlock(staffSrc, 'DOC_PREFIX'))
      const adminPairs = extractQuotedPairs(extractObjectBlock(adminSrc, 'DOC_PREFIX'))
      expect(staffPairs.length, 'staff DOC_PREFIX 对数漂移').toBe(33)
      expect(adminPairs.length, 'admin DOC_PREFIX 对数漂移').toBe(33)
      expect(staffPairs).toEqual(adminPairs)
    })

    test('RECEIVE_INBOUND_TYPE 收货入库映射两端逐对一致且共 4 对', () => {
      const staffPairs = extractQuotedPairs(extractObjectBlock(staffSrc, 'RECEIVE_INBOUND_TYPE'))
      const adminPairs = extractQuotedPairs(extractObjectBlock(adminSrc, 'RECEIVE_INBOUND_TYPE'))
      expect(staffPairs.length).toBe(4)
      expect(adminPairs.length).toBe(4)
      expect(staffPairs).toEqual(adminPairs)
    })

    test('staff 可见/可建单据类型必须是全量 DOC_PREFIX 的子集（防出现无前缀的单据类型）', () => {
      const allTypes = new Set(extractQuotedPairs(extractObjectBlock(staffSrc, 'DOC_PREFIX')).map((p) => p.split('=')[0]))
      for (const name of ['STAFF_VISIBLE_DOC_TYPES', 'STAFF_CREATE_DOC_TYPES', 'STAFF_RECEIVE_DOC_TYPES']) {
        for (const t of extractSetItems(staffSrc, name)) {
          expect(allTypes.has(t), `${name} 含未定义前缀的单据类型 ${t}`).toBe(true)
        }
      }
    })
  })

  describe('§3 staff 端安全护栏', () => {
    test('所有 throw 的一级前缀 ⊆ 9 项错误码白名单（否则降级 -1 服务器内部错误）', () => {
      const prefixes = [...new Set(extractThrownPrefixes(staffSrc))]
      expect(prefixes.length, 'staff inventory.js 应有可提取的 throw 前缀').toBeGreaterThan(0)
      const illegal = prefixes.filter((p) => !ERROR_PREFIX_WHITELIST.has(p))
      expect(illegal, `发现白名单外前缀：${illegal.join(', ')}`).toEqual([])
    })

    test('金额字段禁提交保护必须存在（price/amount/cost/discount/money/金额/价格 递归检测）', () => {
      expect(staffSrc).toMatch(/function assertNoStaffMoneyFields/)
      expect(staffSrc).toMatch(/price\|amount\|cost\|discount\|money\|金额\|价格/)
      expect(staffSrc).toMatch(/staff 端不允许提交金额字段/)
    })
  })

  describe('§4 syncInventoryLocations 短路探测两端一致（migration 0009 触发器兜底）', () => {
    // 反连接探测的关键片段两端必须逐字一致：任何一端改探测条件（少列/改列）另一端必须同步，
    // 否则一端认为无漂移跳过自愈、另一端反复全表 UPSERT，两端库存主体口径分叉。
    const PROBE_FRAGMENTS = [
      'loc.location_id IS NULL',
      // org_nodes.type 是 pgEnum，text 比较语境无隐式转换，必须显式 ::text（42883）
      'loc.location_type IS DISTINCT FROM o.type::text',
      'loc.name IS DISTINCT FROM o.name',
      'loc.org_node_id IS DISTINCT FROM o.id',
      'loc.parent_location_id IS DISTINCT FROM o.parent_id',
      'loc.is_active IS DISTINCT FROM o.is_active',
      "loc.location_type IS DISTINCT FROM '门店'",
      'loc.name IS DISTINCT FROM s.store_name',
      'loc.org_node_id IS DISTINCT FROM s.org_node_id',
      'loc.store_id IS DISTINCT FROM s.store_id',
      'loc.is_active IS DISTINCT FROM (COALESCE(o.is_active, false) AND NOT s.is_closed)',
      ') AS drifted',
    ]

    test('staff 与 admin 的漂移探测条件逐项存在', () => {
      for (const fragment of PROBE_FRAGMENTS) {
        expect(staffSrc.includes(fragment), `staff 缺少探测片段：${fragment}`).toBe(true)
        expect(adminSrc.includes(fragment), `admin 缺少探测片段：${fragment}`).toBe(true)
      }
    })

    test('两端探测后仍保留两条全表 UPSERT 自愈路径', () => {
      const upsertRe = /INSERT INTO inventory_locations[\s\S]*?ON CONFLICT \(location_id\) DO UPDATE/g
      expect(staffSrc.match(upsertRe)?.length ?? 0).toBeGreaterThanOrEqual(2)
      expect(adminSrc.match(upsertRe)?.length ?? 0).toBeGreaterThanOrEqual(2)
    })

    test('两端短路判定均为保守语义（仅显式 false 才跳过）', () => {
      expect(staffSrc).toMatch(/drifted === false\) return/)
      expect(adminSrc).toMatch(/drifted === false\) return/)
    })
  })

  // #132：批次供应商锚点。ensureLotFromSku / ensureInventoryLotFromSku 是两份独立副本，
  // 而 lot_key 的 supplier 段取 `supplierId ?? supplier` —— 一端锚 id、另一端锚名称的话，
  // 同一批实物会在两条写入路径下算出不同的 lot_key，拆成两行库存。
  describe('§5 批次供应商锚点两端一致（#132）', () => {
    test('两端都把 SKU 的 supplier_id 作为 trace.supplierId 的回落', () => {
      expect(staffSrc).toMatch(/trace\?\.supplierId[^\n]*\|\|\s*sku\.supplier_id/)
      expect(adminSrc).toMatch(/normalizeText\(trace\.supplierId\)\s*\?\?\s*sku\.supplier_id/)
    })

    test('两端的 SKU 查询都取了 supplier_id 列', () => {
      // 光断言上面的回落表达式不够：SELECT 里漏掉这一列时 `sku.supplier_id` 恒 undefined，
      // 表达式还在、行为却悄悄退回名称锚点，那条测试照样绿。
      const selectPattern = /SELECT sku_id, product_name, spec_name, supplier, supplier_id, product_series/
      expect(staffSrc).toMatch(selectPattern)
      expect(adminSrc).toMatch(selectPattern)
    })

    test('admin 的第三份建批次副本（business.ts 的 skuSnapshot）也取 supplier_id', () => {
      // 建批次的副本有**三**份而不是两份：admin engine 的 ensureLotFromSku、staffApi 的
      // ensureInventoryLotFromSku，以及 admin business.ts 的 upsertLot（同功能、不同名 ——
      // 按名字 grep 会漏掉它）。business.ts 里 skuSnapshot 原本硬写 `supplierId: null`，
      // 类型上却是 string|null，采购入库单没填供应商时批次就只剩名称锚点。
      const businessSrc = readFile(FILES.adminBusinessTs)
      expect(businessSrc).toMatch(
        /SELECT sku_id, product_code, product_name, spec_name, supplier, supplier_id, product_series/,
      )
      expect(businessSrc).toMatch(/supplierId: row\.supplier_id/)
      // 反向断言只钉 loadSku 的返回对象这一段：它是批次供应商的锚点来源。
      // 全文匹配 `supplierId: null` 会误伤**单据头**的同名字段 —— #194 之后采购/发货/入库
      // 单头一律不挂供应商（一张单可含多个供应商），那是另一回事，与批次锚点无关。
      const skuSnapshotReturn = businessSrc.slice(
        businessSrc.indexOf('SELECT sku_id, product_code, product_name, spec_name, supplier, supplier_id'),
        businessSrc.indexOf('itemCompanyPurchasePrice: numberOrNull(row.item_company_purchase_price)'),
      )
      expect(skuSnapshotReturn).not.toMatch(/supplierId: null/)
    })

    test('schema 里 inventory_skus.supplier_id 是指向 inventory_suppliers 的外键', () => {
      expect(schemaSrc).toMatch(
        /supplierId: text\('supplier_id'\)\.references\(\(\) => inventorySuppliers\.supplierId\)/,
      )
    })
  })

  // #251：`location_id = <X> OR org_node_id = <X>` 的双 id 多态查找。
  //
  // 两侧各自唯一（`location_id` 是主键、`org_node_id` 有 `uq_inventory_locations_org`），
  // 但**可以落在不同的两行上**：门店行是 `location_id = store_id` / `org_node_id = org-门店-*`
  //（只有总部/市场行自指），所以某个 store_id 恰等于某个 `type='门店'` 的 org_nodes.id 时，
  // 两侧指向两个**不同门店**的库存主体 → 取首行 = 「按 A 鉴权、扣 B 的批次」。
  //
  // ⚠️ 该签名全仓有**两份**，且一份在 admin：
  //   - staff `ensureInventoryLocation`（routes/inventory.js）
  //   - admin  `loadLocation`（lib/inventory/business.ts，20+ 处写路径走它，还带 FOR UPDATE）
  // 初版守护只打在 engine.ts 上、漏了 business.ts，导致这条安全断言假绿 ——
  // 所以下面的反向闸**必须同时扫两个 admin 文件**。
  //
  // 对照：admin `ensureOrgNodeLocation` / `orgNodeLocationIdForUpdate`（engine.ts）只按
  // org_node_id 单列查，该列 UNIQUE ⇒ 最多一行、天然确定，是**刻意的非对称**，不需要两道闸。
  describe('§6 库存主体解析确定性（#251）', () => {
    const adminBusinessSrc = readFile(FILES.adminBusinessTs)
    /** 归一空白后再断言：避免 prettier 换行 / 缩进变动造成误红。 */
    const flat = (src) => src.replace(/\s+/g, ' ')

    test('staff 侧 OR 多态查找必须带确定性排序 + LIMIT 2', () => {
      expect(flat(staffSrc)).toContain(
        'WHERE location_id = $1 OR org_node_id = $1 ORDER BY location_id LIMIT 2',
      )
    })

    test('admin 侧 loadLocation 同样带确定性排序 + LIMIT 2', () => {
      expect(flat(adminBusinessSrc)).toContain(
        'WHERE (location_id = ${endpointId} OR org_node_id = ${endpointId})'
        + ' ORDER BY location_id LIMIT 2',
      )
    })

    test('两端撞到两行都必须抛 CONFLICT（不静默选一行）', () => {
      expect(flat(staffSrc)).toMatch(
        /if \(rows\.length > 1\) \{ throw new Error\('CONFLICT: LOCATION_ID_AMBIGUOUS:/,
      )
      expect(flat(adminBusinessSrc)).toMatch(
        /if \(matched\.length > 1\) \{ throw new ApiError\('CONFLICT',/,
      )
    })

    /**
     * 停用行**必须参与**歧义判定 —— 两端都不得把 `is_active` 前置到过滤位置。
     *
     * 设入参 X 既是在营门店 A 的 `location_id`(=store_id)、又是**停用**门店 Y 的 `org_node_id`，
     * 调用方传 org_node_id = X 时意图是 Y；一旦 Y 被提前滤掉，就会静默返回 A 并按 A 鉴权、
     * 生成 A 的单据 —— 正是本 issue 的危害本体。停用状态不能消除入参所属 id 空间的不确定性。
     *
     * staff 侧曾用 `rows.filter(r => r.is_active !== false)` 再判歧义、
     * admin 侧曾在 WHERE 里写 `AND is_active = true`，两种都属于这个反模式。
     */
    test('两端都不得把停用行排除在歧义判定之外', () => {
      // admin：is_active 不能出现在 WHERE 与 ORDER BY 之间（即不能作为过滤条件）
      const adminWhereToOrder = flat(adminBusinessSrc).match(
        /WHERE \(location_id = \$\{endpointId\} OR org_node_id = \$\{endpointId\}\)(.*?)ORDER BY location_id/,
      )
      expect(adminWhereToOrder).not.toBeNull()
      expect(adminWhereToOrder[1]).not.toMatch(/is_active/)
      // staff：歧义判定必须基于全部命中行，不得先按 is_active 过滤
      expect(flat(staffSrc)).not.toMatch(/filter\([^)]*is_active[^)]*\)[^;]*length > 1/)
      // 两端的 is_active 判定都必须发生在「唯一命中项」确定之后
      expect(flat(staffSrc)).toMatch(/const row = rows\[0\] if \(row\.is_active === false\)/)
      expect(flat(adminBusinessSrc)).toMatch(/const row = matched\[0\] if \(!row \|\| row\.is_active === false\)/)
    })

    test('admin engine.ts 仍按 org_node_id 单列（UNIQUE）解析，未引入 OR 多态', () => {
      // 形参名用 \w+ 而非写死 orgNodeId：纯重命名不该让守护误红。
      expect(flat(adminSrc)).toMatch(/\.where\(eq\(inventoryLocations\.orgNodeId, \w+\)\)/)
      expect(flat(adminSrc)).toMatch(/FROM inventory_locations WHERE org_node_id = \$\{\w+\}/)
    })

    /**
     * 反向闸：任何 admin 文件若**新引入**双 id 多态而没同步两道闸，这里必须红。
     *
     * 正则放宽以吃掉初版的三类假阴性：操作数反序、表别名前缀（`l.location_id`）、
     * 参数不是 `${}` 直插（先存变量再拼）。engine.ts 当前应当一处都不命中；
     * business.ts 命中的那一处必须同时满足上面「有 ORDER BY + LIMIT 2 + CONFLICT」三条。
     */
    test('admin 侧不得存在「无两道闸」的 OR 多态', () => {
      const orPolymorphic = /(\w+\.)?location_id\s*=[^\n]*\bOR\b[^\n]*(\w+\.)?org_node_id|(\w+\.)?org_node_id\s*=[^\n]*\bOR\b[^\n]*(\w+\.)?location_id/g
      const drizzleOr = /\bor\(\s*eq\(\s*\w+\.(locationId|orgNodeId)/g

      expect(adminSrc.match(orPolymorphic)).toBeNull()
      expect(adminSrc.match(drizzleOr)).toBeNull()
      expect(adminBusinessSrc.match(drizzleOr)).toBeNull()
      // business.ts 只允许 loadLocation 这一处 OR 多态；多出来的必须自证已加两道闸。
      expect(adminBusinessSrc.match(orPolymorphic)).toHaveLength(1)
    })

    test('schema 权威锚：唯一性 + 可空性共同决定了上界与排序写法', () => {
      // 前两条：`LIMIT 2` 是精确上界的依据。一旦被撤，两端的 2 都不再成立。
      expect(schemaSrc).toMatch(/locationId: text\('location_id'\)\.primaryKey\(\)/)
      expect(schemaSrc).toMatch(/uniqueIndex\('uq_inventory_locations_org'\)\.on\(table\.orgNodeId\)/)
      // 第三条：org_node_id **可空**（无 .notNull()）。这正是不能拿
      // `ORDER BY (org_node_id = $1) DESC` 当排序键的原因之一（NULL 比较得 NULL，
      // 且 DESC 默认 NULLS FIRST），也是 `org_node_id || locationId` 兜底那个已知缺陷的前提。
      expect(schemaSrc).toMatch(/orgNodeId: text\('org_node_id'\)\.references\(\(\) => orgNodes\.id\),/)
    })
  })

  describe('Snapshot 守护（提交后任一项漂移立即可见）', () => {
    test('单据类型集合与端点口径文本快照', () => {
      expect({
        inbound: extractSetItems(staffSrc, 'INBOUND_DOC_TYPES'),
        outbound: extractSetItems(staffSrc, 'OUTBOUND_DOC_TYPES'),
        docPrefix: extractQuotedPairs(extractObjectBlock(staffSrc, 'DOC_PREFIX')),
        receiveInbound: extractQuotedPairs(extractObjectBlock(staffSrc, 'RECEIVE_INBOUND_TYPE')),
        thrownPrefixes: [...new Set(extractThrownPrefixes(staffSrc))].sort(),
      }).toMatchSnapshot()
    })
  })
})
