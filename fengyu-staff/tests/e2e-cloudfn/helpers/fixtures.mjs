/**
 * 端到端 fixture：测试组织 / 门店 / 员工 / 顾客 / 销售单 / 商品 / 预约 / 服务单 /
 * 退款申请 / 储值卡 / 优惠券。
 *
 * 所有写入必须以命名空间 (默认 'TEST_E2E_L2' 即 'TE2LS_') 为前缀，cleanupTestData
 * 用前缀 WHERE 精确清理，保证不污染生产数据。
 *
 * 创建顺序（FK 依赖正向）：
 *   org_nodes(总部 → 市场 → 门店) → stores → product_categories → product_skus
 *   → staff_wechat_users + permission_roles
 *   → client_wechat_users → prepaid_cards
 *   → coupon_templates → user_coupons
 *   → sale_orders + sale_items + sale_allocations + sale_order_payments
 *   → appointments → service_orders + service_items
 *
 * 清理顺序（FK 依赖反向）：
 *   service_items → service_orders → appointments
 *   → point_transactions → card_transactions → sale_allocations
 *   → sale_order_payments → sale_items → sale_orders
 *   → user_coupons → coupon_templates → prepaid_cards
 *   → operation_logs → client_wechat_users → permission_roles
 *   → staff_wechat_users → product_skus → product_categories
 *   → stores → org_nodes
 */
import {
  NS,
  TEST_STORE_ID, TEST_STORE_ORG_ID, TEST_HQ_ORG_ID, TEST_MARKET_ORG_ID,
  TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_MANAGER_PHONE,
  TEST_CLIENT_USER_ID, TEST_CLIENT_OPENID, TEST_CLIENT_PHONE,
  TEST_MARKETS, TEST_STORES_MULTI,
  TEST_PHONE_RANGE_START, TEST_PHONE_RANGE_END,
  pgQuery, getPool,
} from '../setup.mjs'

// ────────────────────────────────────────────────────────────────────────
// 组织架构 + 门店
// ────────────────────────────────────────────────────────────────────────

/**
 * 确保测试组织架构（总部 → 市场 → 门店）+ stores 行存在
 * 幂等：用 ON CONFLICT DO NOTHING / DO UPDATE
 */
export async function ensureTestStore() {
  await pgQuery(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, '总部', NULL, 0, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_HQ_ORG_ID, `${NS}_总部`]
  )
  await pgQuery(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, '市场', $3, 0, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_MARKET_ORG_ID, `${NS}_市场`, TEST_HQ_ORG_ID]
  )
  await pgQuery(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, '门店', $3, 0, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_STORE_ORG_ID, `${NS}_测试店`, TEST_MARKET_ORG_ID]
  )

  await pgQuery(
    `INSERT INTO stores (store_id, store_name, org_node_id, opening_date, is_closed)
     VALUES ($1, $2, $3, CURRENT_DATE, false)
     ON CONFLICT (store_id) DO NOTHING`,
    [TEST_STORE_ID, `${NS}_测试店`, TEST_STORE_ORG_ID]
  )

  return { storeId: TEST_STORE_ID, storeOrgId: TEST_STORE_ORG_ID, marketOrgId: TEST_MARKET_ORG_ID, hqOrgId: TEST_HQ_ORG_ID }
}

/**
 * 创建"多市场 / 多门店"测试组织（用于 rbac / deny / mgmt / xend smoke）
 *
 * 默认：1 总部 + 2 市场（A=华东 / B=华北）× 各 2 门店（A1/A2/B1/B2）
 * 沿用 setup.mjs 的 TEST_MARKETS / TEST_STORES_MULTI 常量，幂等 INSERT。
 *
 * @param {object} opts
 * @param {Array<'A'|'B'>} opts.markets - 想建的市场 key（默认 ['A','B']）
 * @param {Array<keyof typeof TEST_STORES_MULTI>} opts.stores - 想建的门店 key（默认 ['A1','A2','B1','B2']）
 * @returns {Promise<{hqOrgId, markets: Array<{key, orgId, name, stores: Array<{key, storeId, orgId, name}>}>}>}
 */
export async function createTestOrg({
  markets = ['A', 'B'],
  stores = ['A1', 'A2', 'B1', 'B2'],
} = {}) {
  // 1) 总部（沿用 TEST_HQ_ORG_ID）
  await pgQuery(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, '总部', NULL, 0, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_HQ_ORG_ID, `${NS}_总部`]
  )

  // 2) 市场
  for (const key of markets) {
    const m = TEST_MARKETS[key]
    if (!m) throw new Error(`createTestOrg: 未知 market key=${key}`)
    await pgQuery(
      `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
       VALUES ($1, $2, '市场', $3, 0, true)
       ON CONFLICT (id) DO NOTHING`,
      [m.orgId, m.name, TEST_HQ_ORG_ID]
    )
  }

  // 3) 门店（org_nodes type='门店' + stores 行）
  for (const key of stores) {
    const s = TEST_STORES_MULTI[key]
    if (!s) throw new Error(`createTestOrg: 未知 store key=${key}`)
    const market = TEST_MARKETS[s.marketKey]
    if (!markets.includes(s.marketKey)) {
      throw new Error(`createTestOrg: store=${key} 所属市场 ${s.marketKey} 未在 markets 列表中`)
    }
    await pgQuery(
      `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
       VALUES ($1, $2, '门店', $3, 0, true)
       ON CONFLICT (id) DO NOTHING`,
      [s.orgId, s.name, market.orgId]
    )
    await pgQuery(
      `INSERT INTO stores (store_id, store_name, org_node_id, opening_date, is_closed)
       VALUES ($1, $2, $3, CURRENT_DATE, false)
       ON CONFLICT (store_id) DO NOTHING`,
      [s.storeId, s.name, s.orgId]
    )
  }

  const result = {
    hqOrgId: TEST_HQ_ORG_ID,
    markets: markets.map((key) => {
      const m = TEST_MARKETS[key]
      const myStores = stores
        .filter((k) => TEST_STORES_MULTI[k].marketKey === key)
        .map((k) => {
          const s = TEST_STORES_MULTI[k]
          return { key: k, storeId: s.storeId, orgId: s.orgId, name: s.name }
        })
      return { key, orgId: m.orgId, name: m.name, stores: myStores }
    }),
  }
  return result
}

/**
 * 创建一个测试 type='部门' 的 org_nodes（用于 deny-dept-scope-rejected）
 *
 * @param {object} opts
 * @param {string} opts.deptId - 部门 org_node_id（默认 `${NS}_DEPT_X`）
 * @param {string} opts.parentId - 父节点 ID（默认 TEST_HQ_ORG_ID）
 * @returns {Promise<{deptId}>}
 */
export async function createTestDeptNode({
  deptId = `${NS}_DEPT_X`,
  parentId = TEST_HQ_ORG_ID,
  name = `${NS}_部门_X`,
} = {}) {
  await pgQuery(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, '部门', $3, 0, true)
     ON CONFLICT (id) DO NOTHING`,
    [deptId, name, parentId]
  )
  return { deptId }
}

// ────────────────────────────────────────────────────────────────────────
// 提成比例矩阵（commission_rate_matrix）
// ────────────────────────────────────────────────────────────────────────

/**
 * 注入测试市场（默认 TEST_MARKET_ORG_ID）下的 commission_rate_matrix 规则。
 *
 * 覆盖维度：
 *   - 销售单 × {美容师, 养生师, 推广师} × {自销自耗, 他销自耗, 他销他耗} × tier
 *   - 服务单 × {美容师, 养生师} × {自销自耗, 他销自耗, 他销他耗} × tier
 *   - 自销自耗 故意拆 2 tier（0-5000 / 5000-NULL）→ 验证服务提成 tier 切换
 *   - 生态合作 故意不配 → 验证服务提成兜底 rate=0 + 写 rate_missing 日志
 *
 * 注意：
 *   1. allocation.suggest 实际只取首 tier（amount_tier_min=0），销售单 tier 切换在 suggest 侧不生效
 *      （已知偏差，不在此 fixture 范围）
 *   2. service.complete 真正按 consumeBase 查 tier_max 命中
 *   3. org_id 是市场节点（org_nodes.type='市场'），同市场多门店共享
 *
 * 幂等：ON CONFLICT 更新 commission_rate。
 *
 * @param {object} opts
 * @param {string} opts.orgId - 市场 org_node id（默认 TEST_MARKET_ORG_ID）
 * @returns {Promise<{orgId, ruleCount}>}
 */
export async function ensureTestCommissionMatrix({
  orgId = TEST_MARKET_ORG_ID,
} = {}) {
  await ensureTestStore()

  // [order_type, role_type, sales_category, tier_min, tier_max, rate]
  //
  // 销售单 自销自耗 拆 2 tier 验证 allocation.suggest 的 tier 阶梯切换
  // （allocation.js 已修复 lookupTierRate，按 totalAmount 精确命中 tier）。
  // 服务单 自销自耗 同样拆 tier，验证 service.complete 的 ORDER BY tier_min DESC LIMIT 1。
  const rules = [
    // ── 销售单 ──
    ['销售单', '美容师', '自销自耗', 0,    5000, 0.08],
    ['销售单', '美容师', '自销自耗', 5000, null, 0.10],
    ['销售单', '美容师', '他销自耗', 0,    null, 0.06],
    ['销售单', '美容师', '他销他耗', 0,    null, 0.05],
    ['销售单', '养生师', '自销自耗', 0,    5000, 0.08],
    ['销售单', '养生师', '自销自耗', 5000, null, 0.10],
    ['销售单', '养生师', '他销自耗', 0,    null, 0.06],
    ['销售单', '养生师', '他销他耗', 0,    null, 0.05],
    ['销售单', '推广师', '自销自耗', 0,    null, 0.05],
    ['销售单', '推广师', '他销自耗', 0,    null, 0.05],
    // ── 服务单 ──
    ['服务单', '美容师', '自销自耗', 0,    5000, 0.12],
    ['服务单', '美容师', '自销自耗', 5000, null, 0.18],
    ['服务单', '美容师', '他销自耗', 0,    null, 0.10],
    ['服务单', '美容师', '他销他耗', 0,    null, 0.08],
    ['服务单', '养生师', '自销自耗', 0,    null, 0.12],
    ['服务单', '养生师', '他销自耗', 0,    null, 0.10],
    ['服务单', '养生师', '他销他耗', 0,    null, 0.08],
  ]

  for (const [orderType, roleType, salesCat, tierMin, tierMax, rate] of rules) {
    await pgQuery(
      `INSERT INTO commission_rate_matrix
         (org_id, order_type, role_type, sales_category,
          amount_tier_min, amount_tier_max, commission_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ON CONSTRAINT uq_commission_matrix
         DO UPDATE SET commission_rate = EXCLUDED.commission_rate,
                       amount_tier_max = EXCLUDED.amount_tier_max,
                       updated_at = NOW()`,
      [orgId, orderType, roleType, salesCat, tierMin, tierMax, rate]
    )
  }

  return { orgId, ruleCount: rules.length }
}

// ────────────────────────────────────────────────────────────────────────
// 员工 + 权限
// ────────────────────────────────────────────────────────────────────────

/**
 * 创建测试员工（默认店长 manager 角色）。
 * @returns {Promise<{employeeId, openid, phone}>}
 */
export async function createTestStaff({
  employeeId = TEST_MANAGER_EMP_ID,
  openid = TEST_MANAGER_OPENID,
  phone = TEST_MANAGER_PHONE,
  name = `${NS}_店长`,
  isManager = true,
  positionName = '门店经理',
  skills = ['美容师'],
  storeId = TEST_STORE_ID,
  orgNodeId = TEST_STORE_ORG_ID,
} = {}) {
  await ensureTestStore()

  await pgQuery(
    `INSERT INTO staff_wechat_users (
       employee_id, openid, phone, name, gender, store_id, org_node_id,
       position_name, skills, is_resigned, hired_at
     )
     VALUES ($1, $2, $3, $4, '女', $5, $6, $7,
             $8::text[], false, CURRENT_DATE)
     ON CONFLICT (employee_id) DO UPDATE
       SET openid = EXCLUDED.openid,
           phone = EXCLUDED.phone,
           name = EXCLUDED.name,
           store_id = EXCLUDED.store_id,
           org_node_id = EXCLUDED.org_node_id,
           position_name = EXCLUDED.position_name,
           skills = EXCLUDED.skills,
           is_resigned = false`,
    [employeeId, openid, phone, name, storeId, orgNodeId, positionName, skills]
  )

  if (isManager) {
    await createTestPermissionRole({ employeeId, role: 'manager', scopeId: orgNodeId })
  }

  return { employeeId, openid, phone }
}

/**
 * 单独绑定权限角色（一人多角色或多 scope 时单步调用）。
 */
export async function createTestPermissionRole({
  employeeId,
  role = 'manager',
  scopeId = TEST_STORE_ORG_ID,
  createdBy = 'e2e-fixture',
} = {}) {
  if (!employeeId) throw new Error('createTestPermissionRole: employeeId required')
  await pgQuery(
    `INSERT INTO permission_roles (employee_id, role, scope_id, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (employee_id, role, scope_id) DO NOTHING`,
    [employeeId, role, scopeId, createdBy]
  )
  return { employeeId, role, scopeId }
}

/**
 * 创建测试员工 + 显式 bindings 数组（替代 isManager 布尔）
 *
 * 与 createTestStaff 不同：
 *   - 完全不预设角色（manager 不再默认绑定）
 *   - bindings: [{role, scopeId}] — 调用方手动指定每个绑定的 role + scope（多绑定支持）
 *   - bindings 为空数组 = 仅插 staff_wechat_users，无 permission_roles 行（用于 no-binding smoke）
 *
 * @param {object} opts
 * @param {string} opts.employeeId
 * @param {string} opts.openid
 * @param {string} opts.phone
 * @param {string} opts.name
 * @param {string|null} opts.storeId - staff_wechat_users.store_id（员工档案默认门店）
 * @param {string|null} opts.orgNodeId - staff_wechat_users.org_node_id（部门或门店）
 * @param {string} opts.positionName
 * @param {string[]} opts.skills
 * @param {Array<{role: string, scopeId: string}>} opts.bindings
 * @returns {Promise<{employeeId, openid, phone, bindings}>}
 */
export async function createTestStaffWithRoles({
  employeeId,
  openid,
  phone,
  name,
  storeId = null,
  orgNodeId = null,
  positionName = '测试岗',
  skills = [],
  bindings = [],
} = {}) {
  if (!employeeId) throw new Error('createTestStaffWithRoles: employeeId required')
  if (!openid) throw new Error('createTestStaffWithRoles: openid required')
  if (!phone) throw new Error('createTestStaffWithRoles: phone required')
  if (!name) throw new Error('createTestStaffWithRoles: name required')

  await pgQuery(
    `INSERT INTO staff_wechat_users (
       employee_id, openid, phone, name, gender, store_id, org_node_id,
       position_name, skills, is_resigned, hired_at
     )
     VALUES ($1, $2, $3, $4, '女', $5, $6, $7,
             $8::text[], false, CURRENT_DATE)
     ON CONFLICT (employee_id) DO UPDATE
       SET openid = EXCLUDED.openid,
           phone = EXCLUDED.phone,
           name = EXCLUDED.name,
           store_id = EXCLUDED.store_id,
           org_node_id = EXCLUDED.org_node_id,
           position_name = EXCLUDED.position_name,
           skills = EXCLUDED.skills,
           is_resigned = false`,
    [employeeId, openid, phone, name, storeId, orgNodeId, positionName, skills]
  )

  for (const b of bindings) {
    if (!b.role || !b.scopeId) {
      throw new Error(`createTestStaffWithRoles: binding 必须含 role + scopeId, 收到 ${JSON.stringify(b)}`)
    }
    await pgQuery(
      `INSERT INTO permission_roles (employee_id, role, scope_id, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (employee_id, role, scope_id) DO NOTHING`,
      [employeeId, b.role, b.scopeId, 'e2e-fixture']
    )
  }

  return { employeeId, openid, phone, bindings: [...bindings] }
}

/**
 * 清除 staffApi 的 AUTH_CACHE（在同进程内 smoke 修改了 permission_roles 后必须调用）。
 *
 * 注意：dynamic require 会加载 staffApi 模块；调用方必须在 invoke.mjs 已经 patch
 * 过 wx-server-sdk 之后调用（一般 import './setup.mjs' 后即可）。
 *
 * @param {string|string[]} openids
 */
export async function invalidateStaffAuthCache(openids) {
  const list = Array.isArray(openids) ? openids : [openids]
  if (list.length === 0) return
  const { createRequire } = await import('node:module')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const STAFF_API_DIR = path.resolve(__dirname, '..', '..', '..', 'cloudfunctions', 'staffApi')
  const req = createRequire(path.join(STAFF_API_DIR, 'package.json'))
  // helpers/invoke.mjs 已确保 wx-server-sdk mock 安装；此处 require 是幂等的
  const authMod = req(path.join(STAFF_API_DIR, 'middleware', 'auth.js'))
  for (const oid of list) {
    if (oid) authMod.invalidateAuthCache(oid)
  }
}

// ────────────────────────────────────────────────────────────────────────
// 顾客
// ────────────────────────────────────────────────────────────────────────

export async function createTestClient({
  userId = TEST_CLIENT_USER_ID,
  openid = TEST_CLIENT_OPENID,
  phone = TEST_CLIENT_PHONE,
  name = `${NS}_顾客`,
  boundStoreId = TEST_STORE_ID,
  pointsBalance = 0,
  customerType = '流量客',
  spendingTier = '<1990',
  memberLevel = null,
} = {}) {
  await ensureTestStore()
  await pgQuery(
    `INSERT INTO client_wechat_users (
       user_id, openid, phone, name, gender, bound_store_id,
       customer_type, spending_tier, points_balance, member_level
     )
     VALUES ($1, $2, $3, $4, '女', $5, $6::customer_type, $7::spending_tier, $8, $9::member_level)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid,
           phone = EXCLUDED.phone,
           bound_store_id = EXCLUDED.bound_store_id,
           points_balance = EXCLUDED.points_balance,
           customer_type = EXCLUDED.customer_type,
           spending_tier = EXCLUDED.spending_tier,
           member_level = EXCLUDED.member_level`,
    [userId, openid, phone, name, boundStoreId, customerType, spendingTier, pointsBalance, memberLevel]
  )
  return { userId, openid, phone }
}

// ────────────────────────────────────────────────────────────────────────
// 商品域：品项分类 + SKU
// ────────────────────────────────────────────────────────────────────────

/**
 * 创建测试商品分类 + SKU。最小可用 fixture：order.create 价格从 product_skus 读取。
 *
 * @param {object} opts
 * @param {string} opts.suffix - 唯一后缀，用于生成 categoryId/skuId（默认 '1'）
 * @param {string} opts.categoryId - 指定二级分类 ID；默认按 suffix 生成
 * @param {string} opts.specName - 指定 SKU 商品名称；默认按 suffix 生成
 * @param {string} opts.productKind - 一级品项类型（如 '护理项目' / '充值卡' / '体验卡' / '家居产品'）
 * @param {string} opts.productType - SKU 产品类型枚举值（'疗程卡' / '家居产品'，2026-05-21 '单品' 并入 '疗程卡'）
 * @param {string} opts.salesCategory - 销售分类（'自销自耗' / '他销自耗' / '他销他耗' / '生态合作'）
 * @param {number} opts.price - 标价
 * @param {number|null} opts.sessionCount - 疗程次数（多次卡>=2，单次性=1 或 null，家居=null）
 * @param {boolean} opts.isShengmei - 是否生美（护理项目用）
 * @param {boolean} opts.isExperience - 是否体验卡
 * @param {boolean} opts.isRechargeCard - 是否充值卡
 * @param {number} opts.serviceFee - 固定手工费
 * @returns {Promise<{categoryId, skuId, specName}>}
 */
export async function createTestProduct({
  suffix = '1',
  categoryId = null,
  specName: inputSpecName = null,
  productKind = '护理项目',
  productType = '疗程卡',
  salesCategory = '他销他耗',
  price = 1000,
  sessionCount = 10,
  isShengmei = true,
  isExperience = false,
  isRechargeCard = false,
  serviceFee = 0,
} = {}) {
  // 一级品项（'护理项目' / '家居产品' / '充值卡' / '体验卡'）在生产库已 seed。
  // 不再 INSERT 测试级 level-1 行，避免与生产同名 category_name 触发 LEFT JOIN 重复
  // （createConversion 的 held query 通过 si.is_experience capability 列识别"体验单品卡"）。
  // 二级分类（product_kind=该一级名，sales_category 决定提成）
  const subCatId = categoryId || `${NS}_CAT_${suffix}`
  await pgQuery(
    `INSERT INTO product_categories (
       category_id, category_name, product_kind, sales_category, sort_order, is_valid
     )
     VALUES ($1, $2, $3, $4::sales_category, 0, true)
     ON CONFLICT (category_id) DO UPDATE
       SET product_kind = EXCLUDED.product_kind,
           sales_category = EXCLUDED.sales_category`,
    [subCatId, `${NS}_品类_${suffix}`, productKind, salesCategory]
  )

  const skuId = `${NS}_SKU_${suffix}`
  const specName = inputSpecName || `${NS}_商品_${suffix}`
  await pgQuery(
    `INSERT INTO product_skus (
       sku_id, category_id, product_type, spec_name, price,
       session_count, sort_order, service_fee, is_shengmei,
       is_experience, is_enabled
     )
     VALUES ($1, $2, $3::product_type, $4, $5,
             $6, 0, $7, $8,
             $9, true)
     ON CONFLICT (sku_id) DO UPDATE
       SET category_id = EXCLUDED.category_id,
           product_type = EXCLUDED.product_type,
           spec_name = EXCLUDED.spec_name,
           price = EXCLUDED.price,
           session_count = EXCLUDED.session_count,
           service_fee = EXCLUDED.service_fee,
           is_shengmei = EXCLUDED.is_shengmei,
           is_experience = EXCLUDED.is_experience,
           is_enabled = true`,
    [
      skuId, subCatId, productType, specName, price,
      sessionCount, serviceFee, isShengmei,
      isExperience,
    ]
  )

  return { categoryId: subCatId, skuId, specName }
}

// ────────────────────────────────────────────────────────────────────────
// 销售订单
// ────────────────────────────────────────────────────────────────────────

/**
 * 创建一个销售单（默认"待确认收款"，含 sale_items 一行）。
 * 向后兼容旧 smoke：保留 saleOrderId/clientUserId/totalAmount 必填字段。
 */
export async function createTestSaleOrder({
  saleOrderId,
  clientUserId,
  storeId = TEST_STORE_ID,
  openedBy = TEST_MANAGER_EMP_ID,
  totalAmount = 300,
  status = '待支付',
  saleOrderType = '销售单',
  paymentMethod = '线下',
  skuId = null,
  productName = `${NS}_测试商品`,
  productType = '疗程卡',
  quantity = 1,
  sessionCount = null,
  isShengmei = null,
  isExperience = false,
  isRechargeCard = false,
  salesCategory = null,
  prepaidCardAmount = 0,
  // 储值卡「预选待扣」额度。两段式语义见 fengyu-staff/CLAUDE.md：开单只写
  // pending_prepaid_card_amount 且**不动 prepaid_cards.balance**，真正扣卡发生在
  // clientApi / payNotify / confirmOffline，结算后才转入 prepaid_card_amount。
  // 要构造"待结算、卡未扣"的订单必须用这个参数——写 prepaidCardAmount 造出来的是
  // 「卡已扣但余额没少」的自相矛盾态，confirmOffline 会当成没预选卡而把欠款全算现金。
  pendingPrepaidCardAmount = 0,
  preferredEmployeeId = null,
  refSaleOrderId = null,
} = {}) {
  if (!saleOrderId) throw new Error('createTestSaleOrder: saleOrderId required')
  if (!clientUserId) throw new Error('createTestSaleOrder: clientUserId required')

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // 应付 = 总额 − 已结算卡额 − 预选待扣卡额（两者都不该由顾客再掏现金）
    const payableAmount =
      Number(totalAmount) - Number(prepaidCardAmount) - Number(pendingPrepaidCardAmount)
    await client.query(
      `INSERT INTO sale_orders (
         sale_order_id, status, sale_order_type, market_name, store_id,
         sale_order_datetime, client_user_id, client_phone, customer_name,
         total_amount, prepaid_card_amount, pending_prepaid_card_amount, payable_amount, received,
         payment_method, opened_by, preferred_employee_id, allocation_status,
         ref_sale_order_id
       )
       VALUES ($1, $2::order_status, $3::sale_order_type, $4, $5,
               NOW(), $6, $7, $8,
               $9, $10, $11, $12, 0,
               $13::payment_method, $14, $15, '待分配'::allocation_status,
               $16)`,
      [
        saleOrderId, status, saleOrderType, `${NS}_市场`, storeId,
        clientUserId, TEST_CLIENT_PHONE, `${NS}_顾客`,
        totalAmount, prepaidCardAmount, pendingPrepaidCardAmount, payableAmount,
        paymentMethod, openedBy, preferredEmployeeId,
        refSaleOrderId,
      ]
    )

    const itemId = `${saleOrderId}_ITEM_1`
    await client.query(
      `INSERT INTO sale_items (
         sale_item_id, sale_order_id, store_id, item_direction,
         sku_id, product_name, product_type,
         session_count, remaining_sessions,
         unit_price, quantity, unit_real_price, sale_amount, received,
         is_experience, is_shengmei, sales_category
       )
       VALUES ($1, $2, $3, '购买'::item_direction,
               $4, $5, $6::product_type,
               $7, $7,
               $8, $9, $8, $10, $10,
               $11, $12, $13::sales_category)`,
      [
        itemId, saleOrderId, storeId,
        skuId, productName, productType,
        sessionCount,
        // unit_price / unit_real_price 取 per-session 单次价（[sale-items-money-fields]）：
        // 疗程卡（session_count>0）= 行应付总额 / (件数 × 单卡次数)，sale_amount 仍为行应付总额；
        // 家居产品（session_count 空）= totalAmount / quantity。退款封顶/提成均按单次价 × 次数算。
        sessionCount && Number(sessionCount) > 0
          ? Number(totalAmount) / (Number(quantity) * Number(sessionCount))
          : Number(totalAmount) / Number(quantity),
        quantity, totalAmount,
        isExperience, isShengmei, salesCategory,
      ]
    )

    await client.query('COMMIT')
    return { saleOrderId, saleItemId: itemId }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/**
 * 在已有 sale_order 上追加一行 sale_item（默认 createTestSaleOrder 只插 1 行；
 * 多 SKU / 多 sales_category 用例用此 helper 增补第 2/N 行）。
 *
 * 注意：调用方负责保证 sale_order_id 已存在；同时调用方需自己更新 sale_orders.total_amount/received
 * 来包含新增 item 的金额（如要让 allocation.suggest 拿到完整 received）。
 *
 * @param {object} opts
 * @param {string} opts.saleOrderId   - 已存在的销售单 ID
 * @param {string} opts.saleItemId    - 新行 ID（调用方控制，建议 ${saleOrderId}_ITEM_N）
 * @param {string} opts.skuId
 * @param {string} opts.productName
 * @param {string} opts.productType   - '疗程卡' / '家居产品'（2026-05-21 '单品' 并入 '疗程卡'）
 * @param {number} opts.quantity
 * @param {number} opts.unitPrice     - 单价（= unit_real_price 默认）
 * @param {number} opts.salesCategory - 必填
 * @returns {Promise<{saleItemId}>}
 */
export async function createTestSaleItem({
  saleOrderId,
  saleItemId,
  storeId = TEST_STORE_ID,
  skuId = null,
  productName = `${NS}_追加商品`,
  productType = '疗程卡',
  quantity = 1,
  unitPrice,
  sessionCount = null,
  salesCategory,
  isShengmei = null,
  isExperience = false,
  isRechargeCard = false,
} = {}) {
  if (!saleOrderId) throw new Error('createTestSaleItem: saleOrderId required')
  if (!saleItemId) throw new Error('createTestSaleItem: saleItemId required')
  if (unitPrice == null) throw new Error('createTestSaleItem: unitPrice required')
  if (!salesCategory) throw new Error('createTestSaleItem: salesCategory required')

  const saleAmount = Number(unitPrice) * Number(quantity)
  // unit_real_price 取 per-session 单次价（与 createTestSaleOrder 口径一致，[sale-items-money-fields]）：
  // 疗程卡（session_count>0）= 行应付总额 / (件数 × 单卡次数)；家居产品 = totalAmount / quantity。
  // 退款封顶/提成均按单次价 × 次数算，若误用总价会让退款金额翻倍。
  const unitRealPrice = sessionCount && Number(sessionCount) > 0
    ? saleAmount / (Number(quantity) * Number(sessionCount))
    : saleAmount / Number(quantity)

  await pgQuery(
    `INSERT INTO sale_items (
       sale_item_id, sale_order_id, store_id, item_direction,
       sku_id, product_name, product_type,
       session_count, remaining_sessions,
       unit_price, quantity, unit_real_price, sale_amount, received,
       is_experience, is_shengmei, sales_category
     )
     VALUES ($1, $2, $3, '购买'::item_direction,
             $4, $5, $6::product_type,
             $7, $7,
             $8, $9, $14, $10, $10,
             $11, $12, $13::sales_category)`,
    [
      saleItemId, saleOrderId, storeId,
      skuId, productName, productType,
      sessionCount,
      unitPrice, quantity, saleAmount,
      isExperience, isShengmei, salesCategory,
      unitRealPrice,
    ]
  )

  return { saleItemId }
}

// ────────────────────────────────────────────────────────────────────────
// 预约
// ────────────────────────────────────────────────────────────────────────

/**
 * 创建测试预约。
 * @param {object} opts
 * @param {string} opts.appointmentId - 必填，建议 NS 前缀（如 'TE2LS_APPT_001'）
 * @param {string} opts.status - 默认 '待确认'
 * @param {Date|string} opts.appointmentTime - 默认 现在 +1 小时
 * @param {string} opts.saleItemId - 关联购买行（可选）
 * @returns {Promise<{appointmentId}>}
 */
export async function createTestAppointment({
  appointmentId,
  status = '待确认',
  storeId = TEST_STORE_ID,
  clientUserId = TEST_CLIENT_USER_ID,
  clientName = `${NS}_顾客`,
  employeeId = TEST_MANAGER_EMP_ID,
  employeeName = `${NS}_店长`,
  saleItemId = null,
  appointmentTime = null,
  notes = null,
} = {}) {
  if (!appointmentId) throw new Error('createTestAppointment: appointmentId required')
  const at = appointmentTime || new Date(Date.now() + 60 * 60 * 1000)
  await pgQuery(
    `INSERT INTO appointments (
       appointment_id, status, store_id, client_user_id, client_name,
       employee_id, employee_name, sale_item_id, appointment_time, notes
     )
     VALUES ($1, $2::appointment_status, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (appointment_id) DO UPDATE
       SET status = EXCLUDED.status,
           appointment_time = EXCLUDED.appointment_time,
           sale_item_id = EXCLUDED.sale_item_id`,
    [appointmentId, status, storeId, clientUserId, clientName, employeeId, employeeName, saleItemId, at, notes]
  )
  return { appointmentId }
}

// ────────────────────────────────────────────────────────────────────────
// 服务单
// ────────────────────────────────────────────────────────────────────────

/**
 * 创建测试服务单（含可选 service_items）。
 *
 * @param {object} opts
 * @param {string} opts.serviceOrderId - 必填，varchar(30)，NS 前缀（如 'TE2LS_SVC_001'）
 * @param {string} opts.status - 默认 '待服务'
 * @param {Array<{saleItemId, employeeId?, sessionUsed?, serviceDuration?}>} opts.items
 * @param {string} opts.appointmentId - 可选关联预约
 * @returns {Promise<{serviceOrderId, items: [{serviceItemId}]}>}
 */
export async function createTestServiceOrder({
  serviceOrderId,
  status = '待服务',
  serviceOrderType = '售前',
  storeId = TEST_STORE_ID,
  assignedEmployeeId = TEST_MANAGER_EMP_ID,
  clientUserId = TEST_CLIENT_USER_ID,
  serviceDate = null,
  remark = null,
  appointmentId = null,
  items = [],
} = {}) {
  if (!serviceOrderId) throw new Error('createTestServiceOrder: serviceOrderId required')
  const date = serviceDate || new Date().toISOString().slice(0, 10)

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    await client.query(
      `INSERT INTO service_orders (
         service_order_id, status, service_order_type, market_name, store_id,
         service_date, assigned_employee_id, remark, appointment_id, client_user_id
       )
       VALUES ($1, $2::service_order_status, $3::service_order_type, $4, $5,
               $6, $7, $8, $9, $10)`,
      [serviceOrderId, status, serviceOrderType, `${NS}_市场`, storeId,
       date, assignedEmployeeId, remark, appointmentId, clientUserId]
    )

    const itemRefs = []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const sItemId = `${serviceOrderId}_I${i + 1}`
      await client.query(
        `INSERT INTO service_items (
           service_item_id, sale_item_id, service_order_id, session_used,
           employee_id, service_duration, unit_real_price, is_shengmei, sales_category
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::sales_category)`,
        [
          sItemId, it.saleItemId, serviceOrderId, it.sessionUsed ?? 1,
          it.employeeId ?? assignedEmployeeId, it.serviceDuration ?? 60,
          it.unitRealPrice ?? null, it.isShengmei ?? null, it.salesCategory ?? null,
        ]
      )
      itemRefs.push({ serviceItemId: sItemId })
    }

    await client.query('COMMIT')
    return { serviceOrderId, items: itemRefs }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// ────────────────────────────────────────────────────────────────────────
// 退款审批
// ────────────────────────────────────────────────────────────────────────

/**
 * 在已有销售单上创建一条"待审批"退款申请（sale_order_payments）。
 *
 * @param {object} opts
 * @param {string} opts.saleOrderId - 原销售单（必须已是 '已支付'/'部分支付'）
 * @param {number} opts.refundAmount - 退款金额（输入正数，函数自动转负）
 * @param {string} opts.refundReason - 退款原因
 * @param {string} opts.refSaleItemId - 部分退款关联的具体 sale_item（可选）
 * @param {number|null} opts.sessionCount - 退疗程卡的次数（可选）
 * @param {string} opts.operatorEmployeeId - 发起人
 * @returns {Promise<{paymentId}>}
 */
export async function createTestRefundRequest({
  saleOrderId,
  refundAmount,
  refundReason = `${NS}_e2e_refund`,
  refSaleItemId = null,
  sessionCount = null,
  operatorEmployeeId = TEST_MANAGER_EMP_ID,
  paymentMethod = '线下',
} = {}) {
  if (!saleOrderId) throw new Error('createTestRefundRequest: saleOrderId required')
  if (!refundAmount || refundAmount <= 0) throw new Error('createTestRefundRequest: refundAmount must be > 0')

  const rows = await pgQuery(
    `INSERT INTO sale_order_payments (
       sale_order_id, change_type, amount, payment_method, status, source_end,
       operator_employee_id, note, refund_reason, ref_sale_item_id, session_count, created_at
     )
     VALUES ($1, '退款'::payment_change_type, $2, $3::payment_method, '待审批'::payment_flow_status, 'staff'::payment_source_end,
             $4, NULL, $5, $6, $7, NOW())
     RETURNING id`,
    [saleOrderId, -Math.abs(refundAmount), paymentMethod, operatorEmployeeId, refundReason, refSaleItemId, sessionCount]
  )
  return { paymentId: rows[0].id }
}

// ────────────────────────────────────────────────────────────────────────
// 储值卡
// ────────────────────────────────────────────────────────────────────────

/**
 * 创建测试储值卡（一户一账户；写 prepaid_cards + 可选首充 card_transactions）。
 *
 * @param {object} opts
 * @param {string} opts.userId - 顾客 user_id（默认 TEST_CLIENT_USER_ID）
 * @param {number} opts.initialBalance - 初始余额（>0 时同步写一条 type='充值' 流水）
 * @param {string} opts.cardId - 自定义 card_id（默认 NS_CARD_<userId 尾>）
 * @param {string} opts.refOrderId - 充值流水关联订单（可选）
 * @returns {Promise<{cardId, balance}>}
 */
export async function createTestPrepaidCard({
  userId = TEST_CLIENT_USER_ID,
  initialBalance = 0,
  cardId = null,
  refOrderId = null,
} = {}) {
  const cid = cardId || `${NS}_CARD_${userId.split('_').pop()}`
  await pgQuery(
    `INSERT INTO prepaid_cards (card_id, user_id, balance)
     VALUES ($1, $2, $3)
     ON CONFLICT (card_id) DO UPDATE
       SET balance = EXCLUDED.balance`,
    [cid, userId, initialBalance]
  )
  if (Number(initialBalance) > 0) {
    await pgQuery(
      `INSERT INTO card_transactions (card_id, type, amount, ref_order_id)
       VALUES ($1, '充值'::card_transaction_type, $2, $3)`,
      [cid, initialBalance, refOrderId]
    )
  }
  return { cardId: cid, balance: Number(initialBalance) }
}

// ────────────────────────────────────────────────────────────────────────
// 优惠券
// ────────────────────────────────────────────────────────────────────────

/**
 * 创建测试券模板 + 给指定用户发一张。
 *
 * @param {object} opts
 * @param {string} opts.templateId - 自定义模板 ID（默认 NS_CTPL_1）
 * @param {string} opts.couponId - 自定义实例 ID（默认 NS_UC_<userId 尾>）
 * @param {string} opts.couponType - 现金券/品项券/折扣券
 * @param {number} opts.discountValue - 现金/品项=抵扣金额；折扣=折扣率
 * @param {number} opts.minSpend - 满减门槛
 * @param {Date|null} opts.expireAt - 默认 +30 天
 * @param {string} opts.userId - 发给谁
 * @param {string[]|null} opts.applicableCategoryIds - 适用品类（null=全部）
 * @returns {Promise<{templateId, couponId}>}
 */
export async function createTestCoupon({
  templateId = null,
  couponId = null,
  couponType = '现金券',
  discountValue = 30,
  minSpend = 200,
  expireAt = null,
  userId = TEST_CLIENT_USER_ID,
  applicableCategoryIds = null,
  applicableStoreIds = null,
  status = '未使用',
  name = `${NS}_测试券`,
} = {}) {
  const tplId = templateId || `${NS}_CTPL_1`
  const ucId = couponId || `${NS}_UC_${userId.split('_').pop()}`
  const expire = expireAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  await pgQuery(
    `INSERT INTO coupon_templates (
       template_id, name, coupon_type, discount_value, min_spend,
       applicable_category_ids, applicable_store_ids,
       validity_mode, valid_from, valid_to, is_active
     )
     VALUES ($1, $2, $3::coupon_type, $4, $5,
             $6::text[], $7::text[],
             'fixed', NOW() - INTERVAL '1 day', $8, true)
     ON CONFLICT (template_id) DO UPDATE
       SET discount_value = EXCLUDED.discount_value,
           min_spend = EXCLUDED.min_spend,
           valid_to = EXCLUDED.valid_to,
           applicable_category_ids = EXCLUDED.applicable_category_ids,
           applicable_store_ids = EXCLUDED.applicable_store_ids,
           is_active = true`,
    [tplId, name, couponType, discountValue, minSpend,
     applicableCategoryIds, applicableStoreIds, expire]
  )

  await pgQuery(
    `INSERT INTO user_coupons (coupon_id, template_id, user_id, status, expire_at)
     VALUES ($1, $2, $3, $4::coupon_status, $5)
     ON CONFLICT (coupon_id) DO UPDATE
       SET status = EXCLUDED.status,
           expire_at = EXCLUDED.expire_at`,
    [ucId, tplId, userId, status, expire]
  )
  return { templateId: tplId, couponId: ucId }
}

/**
 * 给已存在的款项行补「逐笔受领」明细（sale_payment_item_receipts，即 spir/spai）。
 *
 * 为什么夹具必须显式建它：真实链路里这行由 `utils/payment-allocatable.js` 的
 * `capturePaymentAllocatables` 在付款事务内写；夹具直接 INSERT `sale_order_payments`
 * 绕过了那一步，于是款项在「按回款逐笔」模型里没有任何可分配/可退的基数。
 *
 * 缺了它会以两种完全不同的面目暴露出来，都不指向夹具：
 *   - 分配：`allocation.savePayment` 报「saleItemId … 不属于该回款」
 *   - 退款：`refund-cascade` 的残值映射全为 0 → 「退款金额无法完整映射到商品行实收」
 *
 * @param {number} salePaymentId 款项行 id
 * @param {string} saleOrderId   订单号
 * @param {Array<{saleItemId: string, amount: number, salesCategory?: string}>} items
 */
export async function createPaymentItemReceipts(salePaymentId, saleOrderId, items) {
  for (const it of items) {
    await pgQuery(
      `INSERT INTO sale_payment_item_receipts
         (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
       VALUES ($1, $2, $3, $4, $5::sales_category, NOW())
       ON CONFLICT (sale_payment_id, sale_item_id)
       DO UPDATE SET amount = EXCLUDED.amount`,
      [salePaymentId, saleOrderId, it.saleItemId, it.amount, it.salesCategory || '他销自耗'],
    )
  }
}

/**
 * 建一笔「已支付」款项 + 配套的逐笔受领明细（真实付款链路的最小等价物）。
 *
 * 直接 INSERT `sale_order_payments` 而不配 receipts 是夹具里最常见的陷阱：
 * 订单看着已支付，但退款映射与营业额分配都读不到基数。详见 createPaymentItemReceipts。
 *
 * @param {string} saleOrderId
 * @param {{changeType?: string, amount: number, paymentMethod?: string,
 *          items: Array<{saleItemId: string, amount: number, salesCategory?: string}>}} opts
 * @returns {Promise<number>} salePaymentId
 */
export async function createPaidPayment(saleOrderId, {
  changeType = '首次支付',
  amount,
  paymentMethod = '线下',
  items,
}) {
  const rows = await pgQuery(
    `INSERT INTO sale_order_payments
       (sale_order_id, change_type, amount, payment_method, status, source_end, created_at, paid_at)
     VALUES ($1, $2::payment_change_type, $3, $4::payment_method,
             '已支付'::payment_flow_status, 'staff'::payment_source_end, NOW(), NOW())
     RETURNING id`,
    [saleOrderId, changeType, amount, paymentMethod],
  )
  const salePaymentId = rows[0].id
  await createPaymentItemReceipts(salePaymentId, saleOrderId, items)
  return salePaymentId
}

// ────────────────────────────────────────────────────────────────────────
// 清理
// ────────────────────────────────────────────────────────────────────────

/**
 * 清理所有以 prefix 开头的测试数据
 *
 * 顺序由 FK 依赖决定（被引用的表后删）。
 * 用 LIKE prefix% 锁定测试命名空间。
 */
export async function cleanupTestData(prefix = NS) {
  const like = `${prefix}%`
  // 多角色 / 多市场场景下，员工号段扩展到 19999098001 ~ 19999098020
  const testPhones = []
  for (let n = TEST_PHONE_RANGE_START; n <= TEST_PHONE_RANGE_END; n++) {
    testPhones.push(String(n))
  }

  const stmts = [
    // ─── 1) service / appointment（独立链） ───
    [`DELETE FROM service_items WHERE service_order_id LIKE $1`, [like]],
    [
      // 由 service.create 自动生成的 HLD-WX-* 服务单按 store_id / client / employee 反查
      `DELETE FROM service_items
         WHERE service_order_id IN (
           SELECT service_order_id FROM service_orders
            WHERE store_id LIKE $1
               OR assigned_employee_id LIKE $1
               OR client_user_id LIKE $1
         )`,
      [like],
    ],
    [
      `DELETE FROM service_commissions
         WHERE employee_id LIKE $1
            OR service_item_id IN (
              SELECT service_item_id FROM service_items
                WHERE service_order_id IN (
                  SELECT service_order_id FROM service_orders
                   WHERE store_id LIKE $1 OR assigned_employee_id LIKE $1 OR client_user_id LIKE $1
                )
            )`,
      [like],
    ],
    [`DELETE FROM service_orders WHERE service_order_id LIKE $1`, [like]],
    [
      `DELETE FROM service_orders
         WHERE store_id LIKE $1 OR assigned_employee_id LIKE $1 OR client_user_id LIKE $1`,
      [like],
    ],
    [`DELETE FROM appointments WHERE appointment_id LIKE $1`, [like]],
    [
      `DELETE FROM appointments
         WHERE store_id LIKE $1 OR client_user_id LIKE $1 OR employee_id LIKE $1`,
      [like],
    ],

    // ─── 2) operation_logs（先于 sale_orders）───
    [
      `DELETE FROM operation_logs WHERE target_id LIKE $1 OR target_id IN (
         SELECT sale_order_id FROM sale_orders WHERE sale_order_id LIKE $1
            OR client_user_id LIKE $1 OR opened_by LIKE $1
       )`,
      [like],
    ],
    [
      `DELETE FROM operation_logs
         WHERE operator_employee_id IN (SELECT employee_id FROM staff_wechat_users WHERE employee_id LIKE $1)`,
      [like],
    ],
    [
      `DELETE FROM messages
         WHERE recipient_id LIKE $1
            OR ref_entity_id IN (
              SELECT id::text FROM sale_order_payments
               WHERE sale_order_id IN (
                 SELECT sale_order_id FROM sale_orders WHERE sale_order_id LIKE $1
                    OR client_user_id LIKE $1 OR opened_by LIKE $1
               )
            )`,
      [like],
    ],

    // ─── 3) card_transactions（必须先于 prepaid_cards 和 sale_orders）───
    [`DELETE FROM card_transactions WHERE ref_order_id LIKE $1`, [like]],
    [
      `DELETE FROM card_transactions
         WHERE ref_order_id IN (
           SELECT sale_order_id FROM sale_orders WHERE client_user_id LIKE $1 OR opened_by LIKE $1
         )`,
      [like],
    ],
    [
      `DELETE FROM card_transactions
         WHERE card_id IN (
           SELECT card_id FROM prepaid_cards
             WHERE card_id LIKE $1
                OR user_id IN (SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1)
         )`,
      [like],
    ],

    // ─── 4) point_batches / point_transactions ───
    // point_batches 同时 FK 到交易、订单和顾客，必须先于三者清理。
    [`DELETE FROM point_batches WHERE ref_order_id LIKE $1`, [like]],
    [
      `DELETE FROM point_batches
         WHERE user_id IN (SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1)`,
      [like],
    ],
    [
      `DELETE FROM point_batches
         WHERE ref_order_id IN (
           SELECT sale_order_id FROM sale_orders
             WHERE store_id LIKE $1 OR opened_by LIKE $1 OR client_user_id LIKE $1
         )`,
      [like],
    ],
    [`DELETE FROM point_transactions WHERE ref_order_id LIKE $1`, [like]],
    [
      `DELETE FROM point_transactions
         WHERE user_id IN (SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1)`,
      [like],
    ],
    // order.create 真实开单生成 FY-XSD-WX-* 单（不带 NS 前缀），其 settlePoints 写的
    // point_transactions.user_id 可能是共享夹具客（如 FY-FIX-CLIENT-01，非 TE2LS 前缀），
    // 上两条都匹配不到 → 残留阻挡 sale_orders 删除级联。按 order 的 store_id/opened_by 兜底。
    [
      `DELETE FROM point_transactions
         WHERE ref_order_id IN (
           SELECT sale_order_id FROM sale_orders
             WHERE store_id LIKE $1 OR opened_by LIKE $1 OR client_user_id LIKE $1
         )`,
      [like],
    ],

    // ─── 4.4) inventory v3（FK → stores/org_nodes/product_skus/sale_orders/sale_items）───
    // 先删流水和明细，随后删除单据、批次、SKU、主体，避免 v3 外键阻塞后续销售单/门店/商品夹具回收。
    [
      `DELETE FROM inventory_movements
        WHERE location_id LIKE $1
           OR sku_id LIKE $1
           OR doc_id IN (
             SELECT id FROM inventory_docs
              WHERE id LIKE $1
                 OR source_org_node_id LIKE $1
                 OR target_org_node_id LIKE $1
                 OR related_sale_order_id LIKE $1
                 OR client_user_id LIKE $1
                 OR created_by LIKE $1
           )
           OR doc_item_id IN (
             SELECT id FROM inventory_doc_items
              WHERE doc_id IN (
                SELECT id FROM inventory_docs
                 WHERE id LIKE $1
                    OR source_org_node_id LIKE $1
                    OR target_org_node_id LIKE $1
                    OR related_sale_order_id LIKE $1
                    OR client_user_id LIKE $1
                    OR created_by LIKE $1
              )
           )`,
      [like],
    ],
    [
      `DELETE FROM inventory_doc_items
        WHERE sku_id LIKE $1
           OR sale_item_id LIKE $1
           OR doc_id IN (
             SELECT id FROM inventory_docs
              WHERE id LIKE $1
                 OR source_org_node_id LIKE $1
                 OR target_org_node_id LIKE $1
                 OR related_sale_order_id LIKE $1
                 OR client_user_id LIKE $1
                 OR created_by LIKE $1
           )`,
      [like],
    ],
    [
      `DELETE FROM inventory_docs
        WHERE id LIKE $1
           OR source_org_node_id LIKE $1
           OR target_org_node_id LIKE $1
           OR related_sale_order_id LIKE $1
           OR client_user_id LIKE $1
           OR created_by LIKE $1`,
      [like],
    ],
    [`DELETE FROM inventory_stock_lots WHERE location_id LIKE $1 OR sku_id LIKE $1`, [like]],
    [
      `DELETE FROM inventory_promotion_plan_items
        WHERE sku_id LIKE $1
           OR plan_id IN (
             SELECT id FROM inventory_promotion_plans
              WHERE id LIKE $1
                 OR scope_market_id LIKE $1
                 OR scope_store_id LIKE $1
                 OR created_by LIKE $1
           )`,
      [like],
    ],
    [
      `DELETE FROM inventory_promotion_plans
        WHERE id LIKE $1
           OR scope_market_id LIKE $1
           OR scope_store_id LIKE $1
           OR created_by LIKE $1`,
      [like],
    ],
    [`DELETE FROM inventory_skus WHERE sku_id LIKE $1 OR product_code LIKE $1`, [like]],
    [
      `DELETE FROM inventory_locations
        WHERE location_id LIKE $1 OR org_node_id LIKE $1 OR store_id LIKE $1`,
      [like],
    ],

    // ─── 4.5) 逐项收款/分配子表（FK→sale_order_payments + sale_items）───
    [
      `DELETE FROM sale_payment_item_allocations
         WHERE sale_payment_item_receipt_id IN (
           SELECT id FROM sale_payment_item_receipts
            WHERE sale_order_id IN (SELECT sale_order_id FROM sale_orders
              WHERE sale_order_id LIKE $1 OR client_user_id LIKE $1 OR opened_by LIKE $1 OR store_id LIKE $1)
         )`,
      [like],
    ],
    [
      `DELETE FROM sale_payment_item_receipts
         WHERE sale_order_id IN (SELECT sale_order_id FROM sale_orders
           WHERE sale_order_id LIKE $1 OR client_user_id LIKE $1 OR opened_by LIKE $1 OR store_id LIKE $1)`,
      [like],
    ],
    // sale_payment_allocatable_items（回款级分配子表，FK→sale_order_payments + sale_items）
    // 必须先于 sale_order_payments（§5）和 sale_items（§7）删除，否则 FK 阻断父表删除，
    // 残留 sop 行又经 audit_employee_id / operator_employee_id 阻断 staff_wechat_users 删除 → 夹具污染级联。
    [`DELETE FROM sale_payment_allocatable_items WHERE sale_order_id LIKE $1 OR sale_item_id LIKE $1`, [like]],
    [
      `DELETE FROM sale_payment_allocatable_items
         WHERE sale_order_id IN (SELECT sale_order_id FROM sale_orders
           WHERE sale_order_id LIKE $1 OR client_user_id LIKE $1 OR opened_by LIKE $1 OR store_id LIKE $1)`,
      [like],
    ],

    // ─── 5) sale_order_payments ───
    [`DELETE FROM sale_order_payments WHERE sale_order_id LIKE $1`, [like]],
    [
      `DELETE FROM sale_order_payments
         WHERE sale_order_id IN (SELECT sale_order_id FROM sale_orders WHERE client_user_id LIKE $1 OR opened_by LIKE $1)`,
      [like],
    ],

    // ─── 6) sale_allocations ───
    [`DELETE FROM sale_allocations WHERE sale_item_id LIKE $1`, [like]],
    [
      `DELETE FROM sale_allocations
         WHERE sale_item_id IN (SELECT sale_item_id FROM sale_items
           WHERE sale_order_id IN (SELECT sale_order_id FROM sale_orders WHERE client_user_id LIKE $1 OR opened_by LIKE $1))`,
      [like],
    ],

    // ─── 7) sale_items（自引用 ref_sale_item_id：先打断指针，再批量删）───
    [
      `UPDATE sale_items SET ref_sale_item_id = NULL
         WHERE sale_order_id IN (SELECT sale_order_id FROM sale_orders
           WHERE sale_order_id LIKE $1 OR client_user_id LIKE $1 OR opened_by LIKE $1)`,
      [like],
    ],
    [
      `DELETE FROM sale_items
         WHERE sale_order_id IN (SELECT sale_order_id FROM sale_orders
           WHERE sale_order_id LIKE $1 OR client_user_id LIKE $1 OR opened_by LIKE $1)`,
      [like],
    ],

    // ─── 8) sale_orders（自引用 ref_sale_order_id：先打断）───
    // 注：order.create 真实开单生成的 sale_order_id 格式是 FY-XSD-WX-* 不带 NS 前缀，
    // 必须按 store_id LIKE 兜底，否则残留单会阻挡 stores 删除。
    [
      `UPDATE sale_orders SET ref_sale_order_id = NULL
         WHERE sale_order_id LIKE $1 OR client_user_id LIKE $1
            OR opened_by LIKE $1 OR store_id LIKE $1`,
      [like],
    ],
    [
      `DELETE FROM sale_orders
         WHERE sale_order_id LIKE $1 OR client_user_id LIKE $1
            OR opened_by LIKE $1 OR store_id LIKE $1`,
      [like],
    ],

    // ─── 9) 券 / 卡 / 权限 ───
    [`DELETE FROM user_coupons WHERE coupon_id LIKE $1 OR template_id LIKE $1`, [like]],
    [
      `DELETE FROM user_coupons
         WHERE user_id IN (SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1)`,
      [like],
    ],
    [`DELETE FROM coupon_templates WHERE template_id LIKE $1`, [like]],
    [`DELETE FROM prepaid_cards WHERE card_id LIKE $1`, [like]],
    [
      `DELETE FROM prepaid_cards
         WHERE user_id IN (SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1)`,
      [like],
    ],
    [`DELETE FROM permission_roles WHERE employee_id LIKE $1`, [like]],

    // ─── 10) 用户主表 ───
    [`DELETE FROM client_wechat_users WHERE user_id LIKE $1`, [like]],
    [`DELETE FROM client_wechat_users WHERE phone = ANY($1::text[])`, [testPhones]],
    [`DELETE FROM staff_wechat_users WHERE employee_id LIKE $1`, [like]],
    [`DELETE FROM staff_wechat_users WHERE phone = ANY($1::text[])`, [testPhones]],

    // ─── 11) 商品域 ───
    [`DELETE FROM mall_product_skus WHERE sku_id LIKE $1`, [like]],
    [`DELETE FROM product_skus WHERE sku_id LIKE $1`, [like]],
    [`DELETE FROM product_categories WHERE category_id LIKE $1`, [like]],

    // ─── 12) 提成矩阵（FK → org_nodes，必须先于 org_nodes 删）───
    [`DELETE FROM commission_rate_matrix WHERE org_id LIKE $1`, [like]],

    // ─── 13) 门店 / 组织（门店/部门 → 市场 → 总部）───
    [`DELETE FROM stores WHERE store_id LIKE $1 OR org_node_id LIKE $1`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '门店'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '部门'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '市场'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '总部'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1`, [like]],
  ]

  // 跑 3 遍：每遍 FK 顺序可能部分失败，反复 retry 把跨 smoke 残留全清
  for (let pass = 0; pass < 3; pass++) {
    for (const [sql, params] of stmts) {
      try {
        await pgQuery(sql, params)
      } catch (e) {
        if (pass === 2) {
          console.warn(`[cleanup] skip "${sql.split('\n')[0]}…": ${e.message}`)
        }
      }
    }
  }
}
