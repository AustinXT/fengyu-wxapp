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
    ]

    test.each(CASES)('%s 两端逐项一致且共 %i 项', ({ name, size }) => {
      const staffItems = extractSetItems(staffSrc, name)
      const adminItems = extractSetItems(adminSrc, name)
      expect(staffItems.length, `staff ${name} 项数漂移`).toBe(size)
      expect(adminItems.length, `admin ${name} 项数漂移`).toBe(size)
      expect(staffItems).toEqual(adminItems)
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
