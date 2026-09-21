/**
 * 进销存链路冒烟 fixture：三级组织（总部 → 市场A/市场B → 门店）+ 独立库存 SKU +
 * 供应商 + 福利方案 + 三级角色会话构造器。
 *
 * 命名空间 'TE2AI'（TE2A 伞下的 inventory 子前缀）：
 *   - 生成的库存单据号（DBH-/MBH-/... 日期序号）无法带前缀，但其
 *     source/target_org_node_id 或 created_by 一定命中 TE2AI%，cleanup 据此回收。
 *   - 清理顺序按 FK 拓扑：movements → reservations → doc_items → stock_lots
 *     → docs(级联 links) → promotion → skus → suppliers → locations → staff/stores/org。
 *
 * 会话构造完全对齐 migration 0039 的三个专职角色 actions 列表；
 * roles[].actions/scopeStoreIds/scopeOrgNodeIds 必须齐全，否则
 * scopeSessionToActions 走兼容路径，测不到「同一角色绑定收紧」。
 */
import { pgQuery } from '../setup.mjs'

export const INS = 'TE2AI'

// 组织节点（org_nodes.id 即库存主体标识；门店库存主体 location_id = store_id）
export const HQ_ORG = `${INS}_HQ`
export const MKA_ORG = `${INS}_MKA`
export const MKB_ORG = `${INS}_MKB`
export const STA1_ORG = `${INS}_STA1_ORG`
export const STA1_ID = `${INS}_STA1`
export const STA2_ORG = `${INS}_STA2_ORG`
export const STA2_ID = `${INS}_STA2`
export const STB1_ORG = `${INS}_STB1_ORG`
export const STB1_ID = `${INS}_STB1`

// 员工（三级角色各一）
export const EMP_SUPPLY = `${INS}_SC`
export const EMP_MARKET_A = `${INS}_MAF`
export const EMP_MARKET_B = `${INS}_MBF`
export const EMP_STORE_A1 = `${INS}_S1C`
export const EMP_STORE_A2 = `${INS}_S2C`
export const EMP_STORE_B1 = `${INS}_SB1C`

export const SUPPLIER_ID = `${INS}_SUP1`
export const SKU_SUPPLY = `${INS}_SKU_SC`
export const SKU_SELF = `${INS}_SKU_SELF`
export const PROMO_ID = `${INS}_PROMO1`

// 与 migration 0039 的角色 actions 完全一致（字面量对齐，勿增删）
export const SUPPLY_CHAIN_ACTIONS = [
  'inventory:export', 'inventory:list', 'inventory:shipment_cancel_approve',
  'inventory:stock_list', 'inventory:supply_chain_approve',
  'inventory:supply_chain_master_data_manage', 'inventory:supply_chain_operate',
  'inventory:supply_chain_price_view',
]
export const MARKET_FINANCE_ACTIONS = [
  'inventory:export', 'inventory:list', 'inventory:market_approve',
  'inventory:market_operate', 'inventory:market_price_view',
  'inventory:market_sku_manage', 'inventory:self_purchase_receive',
  'inventory:shipment_cancel_request', 'inventory:stock_list',
]
export const STORE_OPERATOR_ACTIONS = [
  'inventory:list', 'inventory:stock_list', 'inventory:store_operate',
]

function session({ employeeId, role, scopeId, scopeType, actions, scopeStoreIds, scopeOrgNodeIds }) {
  return {
    employeeId,
    name: employeeId,
    phone: '19999089000',
    roles: [{
      role,
      scopeId,
      scopeType,
      actions: [...actions],
      scopeStoreIds: [...scopeStoreIds],
      scopeOrgNodeIds: [...scopeOrgNodeIds],
    }],
    permissions: {
      actions: [...actions],
      scopeStoreIds: [...scopeStoreIds],
      scopeOrgNodeIds: [...scopeOrgNodeIds],
    },
  }
}

export function supplyChainSession() {
  return session({
    employeeId: EMP_SUPPLY,
    role: 'inventory_supply_chain_operator',
    scopeId: HQ_ORG,
    scopeType: '总部',
    actions: SUPPLY_CHAIN_ACTIONS,
    scopeStoreIds: [],
    scopeOrgNodeIds: [HQ_ORG],
  })
}

export function marketASession() {
  return session({
    employeeId: EMP_MARKET_A,
    role: 'inventory_market_finance',
    scopeId: MKA_ORG,
    scopeType: '市场',
    actions: MARKET_FINANCE_ACTIONS,
    scopeStoreIds: [STA1_ID, STA2_ID],
    scopeOrgNodeIds: [MKA_ORG, STA1_ORG, STA2_ORG],
  })
}

export function marketBSession() {
  return session({
    employeeId: EMP_MARKET_B,
    role: 'inventory_market_finance',
    scopeId: MKB_ORG,
    scopeType: '市场',
    actions: MARKET_FINANCE_ACTIONS,
    scopeStoreIds: [STB1_ID],
    scopeOrgNodeIds: [MKB_ORG, STB1_ORG],
  })
}

export function storeA1Session() {
  return session({
    employeeId: EMP_STORE_A1,
    role: 'inventory_store_operator',
    scopeId: STA1_ORG,
    scopeType: '门店',
    actions: STORE_OPERATOR_ACTIONS,
    scopeStoreIds: [STA1_ID],
    scopeOrgNodeIds: [STA1_ORG],
  })
}

export function storeA2Session() {
  return session({
    employeeId: EMP_STORE_A2,
    role: 'inventory_store_operator',
    scopeId: STA2_ORG,
    scopeType: '门店',
    actions: STORE_OPERATOR_ACTIONS,
    scopeStoreIds: [STA2_ID],
    scopeOrgNodeIds: [STA2_ORG],
  })
}

export function storeB1Session() {
  return session({
    employeeId: EMP_STORE_B1,
    role: 'inventory_store_operator',
    scopeId: STB1_ORG,
    scopeType: '门店',
    actions: STORE_OPERATOR_ACTIONS,
    scopeStoreIds: [STB1_ID],
    scopeOrgNodeIds: [STB1_ORG],
  })
}

async function upsertOrgNode(id, name, type, parentId) {
  await pgQuery(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, $3::org_node_type, $4, 0, true)
     ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, is_active = true`,
    [id, name, type, parentId],
  ).catch(async (e) => {
    // org_nodes.type 在部分环境是 text 列；枚举 cast 失败时回退纯文本写入
    if (!/org_node_type/.test(String(e.message))) throw e
    await pgQuery(
      `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
       VALUES ($1, $2, $3, $4, 0, true)
       ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, is_active = true`,
      [id, name, type, parentId],
    )
  })
}

async function upsertStore(storeId, name, orgNodeId) {
  await pgQuery(
    `INSERT INTO stores (store_id, store_name, org_node_id, opening_date, is_closed)
     VALUES ($1, $2, $3, CURRENT_DATE, false)
     ON CONFLICT (store_id) DO UPDATE SET org_node_id = EXCLUDED.org_node_id, is_closed = false`,
    [storeId, name, orgNodeId],
  )
}

async function upsertStaff(employeeId, name, storeId, orgNodeId, phoneTail) {
  await pgQuery(
    `INSERT INTO staff_wechat_users (
       employee_id, openid, phone, name, gender, store_id, org_node_id,
       position_name, skills, is_resigned, hired_at
     )
     VALUES ($1, $2, $3, $4, '女', $5, $6, '库存员', ARRAY[]::text[], false, CURRENT_DATE)
     ON CONFLICT (employee_id) DO UPDATE
       SET store_id = EXCLUDED.store_id, org_node_id = EXCLUDED.org_node_id, is_resigned = false`,
    [employeeId, `${employeeId}_OPENID`, `1999908${phoneTail}`, name, storeId, orgNodeId],
  )
}

/** 与 admin/staff 的 syncInventoryLocations 同构，把 org/store 夹具落到库存主体表。 */
export async function syncInventoryLocationsFixture() {
  await pgQuery(`
    INSERT INTO inventory_locations (location_id, location_type, name, org_node_id, parent_location_id, is_active)
    SELECT id, type, name, id, parent_id, is_active
      FROM org_nodes
     WHERE type IN ('总部', '市场') AND id LIKE '${INS}%'
    ON CONFLICT (location_id) DO UPDATE
      SET name = EXCLUDED.name, parent_location_id = EXCLUDED.parent_location_id,
          org_node_id = EXCLUDED.org_node_id, is_active = EXCLUDED.is_active, updated_at = NOW()
  `)
  await pgQuery(`
    INSERT INTO inventory_locations (location_id, location_type, name, org_node_id, store_id, parent_location_id, is_active)
    SELECT s.store_id, '门店', s.store_name, s.org_node_id, s.store_id, o.parent_id,
           COALESCE(o.is_active, false) AND NOT s.is_closed
      FROM stores s
      LEFT JOIN org_nodes o ON o.id = s.org_node_id
     WHERE s.store_id LIKE '${INS}%'
    ON CONFLICT (location_id) DO UPDATE
      SET name = EXCLUDED.name, org_node_id = EXCLUDED.org_node_id, store_id = EXCLUDED.store_id,
          parent_location_id = EXCLUDED.parent_location_id, is_active = EXCLUDED.is_active, updated_at = NOW()
  `)
}

/**
 * 建立三级组织 + 员工 + 供应商 + 库存 SKU + 福利方案（幂等）。
 * SKU_SUPPLY 采用公式价：核算价 4000 × 市场折扣 0.25 = 市场进货价 1000（说明.md §1.5 示例）。
 */
export async function ensureInventoryFixture() {
  // 库存切流门禁：一次性测试库无 cutover 行时初始化为已初始化；
  // 已存在行（如显式指向开发库）绝不覆盖——尊重目标库的真实切流状态。
  await pgQuery(
    `INSERT INTO inventory_cutover_states (cutover_key, status)
     VALUES ('workfine_inventory', '已初始化')
     ON CONFLICT (cutover_key) DO NOTHING`,
  )
  await upsertOrgNode(HQ_ORG, `${INS}_总部`, '总部', null)
  await upsertOrgNode(MKA_ORG, `${INS}_市场A`, '市场', HQ_ORG)
  await upsertOrgNode(MKB_ORG, `${INS}_市场B`, '市场', HQ_ORG)
  await upsertOrgNode(STA1_ORG, `${INS}_门店A1`, '门店', MKA_ORG)
  await upsertOrgNode(STA2_ORG, `${INS}_门店A2`, '门店', MKA_ORG)
  await upsertOrgNode(STB1_ORG, `${INS}_门店B1`, '门店', MKB_ORG)
  await upsertStore(STA1_ID, `${INS}_门店A1`, STA1_ORG)
  await upsertStore(STA2_ID, `${INS}_门店A2`, STA2_ORG)
  await upsertStore(STB1_ID, `${INS}_门店B1`, STB1_ORG)
  await upsertStaff(EMP_SUPPLY, `${INS}_供应链员`, null, HQ_ORG, '9001')
  await upsertStaff(EMP_MARKET_A, `${INS}_市场A财务`, null, MKA_ORG, '9002')
  await upsertStaff(EMP_MARKET_B, `${INS}_市场B财务`, null, MKB_ORG, '9003')
  await upsertStaff(EMP_STORE_A1, `${INS}_门店A1库存员`, STA1_ID, STA1_ORG, '9004')
  await upsertStaff(EMP_STORE_A2, `${INS}_门店A2库存员`, STA2_ID, STA2_ORG, '9005')
  await upsertStaff(EMP_STORE_B1, `${INS}_门店B1库存员`, STB1_ID, STB1_ORG, '9006')
  await syncInventoryLocationsFixture()

  await pgQuery(
    `INSERT INTO inventory_suppliers (supplier_id, name, is_active)
     VALUES ($1, $2, true)
     ON CONFLICT (supplier_id) DO UPDATE SET is_active = true`,
    [SUPPLIER_ID, `${INS}_供应商1`],
  )

  await pgQuery(
    `INSERT INTO inventory_skus (
       sku_id, product_code, product_name, spec_name, source_type,
       supplier, supplier_id,
       retail_price, accounting_price, market_purchase_discount,
       market_purchase_price, market_purchase_price_mode,
       supply_chain_purchase_price, store_purchase_price,
       market_staff_purchase_price, item_company_purchase_price,
       is_reportable, is_active
     ) VALUES ($1, $2, $3, '瓶', '供应链', $5, $4,
       5980, 4000, 0.25, 1000, '公式', 800, 1200, 900, 850, true, true)
     ON CONFLICT (sku_id) DO UPDATE
       SET is_active = true, is_reportable = true,
           supplier = $5, supplier_id = $4,
           market_purchase_price = 1000, store_purchase_price = 1200,
           supply_chain_purchase_price = 800, market_staff_purchase_price = 900`,
    [SKU_SUPPLY, `${INS}-SC-001`, `${INS}_供应链产品`, SUPPLIER_ID, `${INS}_供应商1`],
  )
  await pgQuery(
    `INSERT INTO inventory_skus (
       sku_id, product_code, product_name, spec_name, source_type, owner_market_id,
       supplier, supplier_id,
       market_purchase_price, store_purchase_price, is_reportable, is_active
     ) VALUES ($1, $2, $3, '件', '市场自采', $4, $6, $5, 30, 40, true, true)
     ON CONFLICT (sku_id) DO UPDATE
       SET is_active = true, is_reportable = true, owner_market_id = $4,
           supplier = $6, supplier_id = $5,
           market_purchase_price = 30, store_purchase_price = 40`,
    [SKU_SELF, `${INS}-SELF-001`, `${INS}_市场A自采品`, MKA_ORG, SUPPLIER_ID, `${INS}_供应商1`],
  )

  // 福利方案：市场A 专属单品阶梯，报货 ≥5 每单位减 50（说明.md §2）
  await pgQuery(
    `INSERT INTO inventory_promotion_plans (
       id, plan_no, name, starts_at, ends_at, scope_market_id, rule_type, status
     ) VALUES ($1, $2, $3, CURRENT_DATE - 1, CURRENT_DATE + 1, $4, '单品阶梯', '启用')
     ON CONFLICT (id) DO UPDATE
       SET starts_at = CURRENT_DATE - 1, ends_at = CURRENT_DATE + 1, status = '启用'`,
    [PROMO_ID, `${INS}-PROMO-0001`, `${INS}_阶梯福利`, MKA_ORG],
  )
  const promoItems = await pgQuery(
    `SELECT id FROM inventory_promotion_plan_items WHERE plan_id = $1`, [PROMO_ID],
  )
  if (promoItems.length === 0) {
    await pgQuery(
      `INSERT INTO inventory_promotion_plan_items (
         plan_id, sku_id, market_unit_discount, report_min_quantity, is_tiered
       ) VALUES ($1, $2, 50, 5, true)`,
      [PROMO_ID, SKU_SUPPLY],
    )
  }
}

/**
 * 种子批次（退货/调货链的初始库存；正向链自身经业务动作生成批次）。
 * DB 触发器强制批次从零余额开始且余额只能经 inventory_movements 写入
 * （migration 0009 guard），因此走「零余额建批次 + 追加一条入库流水」的合法路径。
 */
export async function insertSeedLot({
  locationId,
  skuId,
  skuName,
  quantity,
  batchNo = 'SEED',
  isGift = false,
  supplyChainUnitCost = null,
  marketStandardUnitPrice = null,
  marketUnitDiscount = null,
  marketActualUnitPrice = null,
  storeStandardUnitPrice = null,
  storeUnitDiscount = null,
  storeActualUnitPrice = null,
}) {
  const lotKey = `${INS}-seed|${locationId}|${skuId}|${batchNo}|${isGift ? 'gift' : 'normal'}`
  const rows = await pgQuery(
    `INSERT INTO inventory_stock_lots (
       location_id, sku_id, lot_key, sku_name, batch_no, expiry_date_key, is_gift,
       quantity_on_hand, supply_chain_unit_cost,
       market_standard_unit_price, market_unit_discount, market_actual_unit_price,
       store_standard_unit_price, store_unit_discount, store_actual_unit_price
     ) VALUES ($1, $2, $3, $4, $5, '', $6, 0, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (location_id, lot_key) DO UPDATE SET updated_at = NOW()
     RETURNING id, quantity_on_hand`,
    [
      locationId, skuId, lotKey, skuName, batchNo, isGift,
      supplyChainUnitCost, marketStandardUnitPrice, marketUnitDiscount,
      marketActualUnitPrice, storeStandardUnitPrice, storeUnitDiscount,
      storeActualUnitPrice,
    ],
  )
  const lotId = Number(rows[0].id)
  const current = Number(rows[0].quantity_on_hand)
  const delta = quantity - current
  if (Math.abs(delta) > 1e-9) {
    await pgQuery(
      `INSERT INTO inventory_movements (
         movement_key, lot_id, location_id, sku_id, direction,
         quantity_delta, quantity_before, quantity_after, remark
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'e2e 种子库存')`,
      [
        `${INS}-seed:${lotId}:${Date.now()}`, lotId, locationId, skuId,
        delta > 0 ? '入库' : '出库', delta, current, quantity,
      ],
    )
  }
  return lotId
}

export async function lotQuantity(lotId) {
  const rows = await pgQuery(
    `SELECT quantity_on_hand FROM inventory_stock_lots WHERE id = $1`, [lotId],
  )
  return rows.length ? Number(rows[0].quantity_on_hand) : null
}

export async function docHeader(docId) {
  const rows = await pgQuery(
    `SELECT id, doc_type, status, source_org_node_id, target_org_node_id,
            market_id, supplier_id, total_quantity, total_amount
       FROM inventory_docs WHERE id = $1`,
    [docId],
  )
  return rows[0] ?? null
}

export async function docItems(docId) {
  return pgQuery(
    `SELECT id, sku_id, is_gift, quantity, request_quantity, fulfilled_quantity,
            supplier_id, market_id,
            standard_unit_price, unit_discount, actual_unit_price, amount,
            supply_chain_unit_cost, market_actual_unit_price, store_actual_unit_price, lot_id
       FROM inventory_doc_items WHERE doc_id = $1 ORDER BY id`,
    [docId],
  )
}

export async function locationLots(locationId, skuId) {
  return pgQuery(
    `SELECT id, is_gift, batch_no, quantity_on_hand, supply_chain_unit_cost,
            market_standard_unit_price, market_unit_discount, market_actual_unit_price,
            store_standard_unit_price, store_unit_discount, store_actual_unit_price
       FROM inventory_stock_lots
      WHERE location_id = $1 AND sku_id = $2
      ORDER BY id`,
    [locationId, skuId],
  )
}

/** FK 拓扑序回收 TE2AI 命名空间（含无前缀单据号：按端点/创建人反查）。 */
export async function cleanupInventoryFixture() {
  const like = `${INS}%`
  const docSet = `
    SELECT id FROM inventory_docs
     WHERE source_org_node_id LIKE $1
        OR target_org_node_id LIKE $1
        OR created_by LIKE $1
  `
  const stmts = [
    [`DELETE FROM inventory_movements
       WHERE location_id LIKE $1 OR sku_id LIKE $1 OR doc_id IN (${docSet})`, [like]],
    [`DELETE FROM inventory_stock_reservations
       WHERE location_id LIKE $1 OR sku_id LIKE $1 OR request_doc_id IN (${docSet})`, [like]],
    [`DELETE FROM inventory_doc_links
       WHERE from_doc_id IN (${docSet}) OR to_doc_id IN (${docSet})`, [like]],
    [`DELETE FROM inventory_doc_items
       WHERE sku_id LIKE $1 OR doc_id IN (${docSet})`, [like]],
    [`DELETE FROM inventory_stock_lots WHERE location_id LIKE $1 OR sku_id LIKE $1`, [like]],
    [`DELETE FROM inventory_docs WHERE id IN (${docSet})`, [like]],
    [`DELETE FROM inventory_promotion_plan_items
       WHERE sku_id LIKE $1 OR plan_id IN (
         SELECT id FROM inventory_promotion_plans WHERE id LIKE $1 OR scope_market_id LIKE $1
       )`, [like]],
    [`DELETE FROM inventory_promotion_plans WHERE id LIKE $1 OR scope_market_id LIKE $1`, [like]],
    [`DELETE FROM inventory_skus WHERE sku_id LIKE $1 OR product_code LIKE $1`, [like]],
    [`DELETE FROM inventory_suppliers WHERE supplier_id LIKE $1`, [like]],
    [`DELETE FROM inventory_locations
       WHERE location_id LIKE $1 OR org_node_id LIKE $1 OR store_id LIKE $1`, [like]],
    [`DELETE FROM operation_logs
       WHERE operator_employee_id LIKE $1 OR target_id LIKE $1`, [like]],
    [`DELETE FROM permission_roles WHERE employee_id LIKE $1`, [like]],
    [`DELETE FROM staff_wechat_users WHERE employee_id LIKE $1`, [like]],
    [`DELETE FROM stores WHERE store_id LIKE $1`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '门店'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '市场'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1`, [like]],
  ]
  for (const [sqlText, params] of stmts) {
    try {
      await pgQuery(sqlText, params)
    } catch (e) {
      console.warn(`[inv-cleanup] skip "${sqlText.trim().split('\n')[0]}…": ${e.message}`)
    }
  }
}
