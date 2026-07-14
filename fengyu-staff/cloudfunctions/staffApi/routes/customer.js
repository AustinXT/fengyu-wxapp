

const pg = require("../db/pg");
const { requireStaffBound, requireManager } = require("../middleware/auth");
const {
  buildStoreScopeCondition,
  isStoreInScope,
  assertCustomerInScope,
  assertEmployeeInScope,
  restrictToBoundEmployee,
  assertCustomerProfileVisible,
} = require("../utils/scope");
const { maskPhone } = require("../utils/pii");
const { maskPhoneForAuth } = require("../utils/phone-visibility");
const { logOperation } = require("../utils/operation-log");
const { shanghaiDateStr } = require("../utils/datetime");


async function assertProfileVisibleByIdentifier(auth, clientUserId, clientPhone) {
  if (!restrictToBoundEmployee(auth)) return;
  let cuid = clientUserId;
  if (!cuid && clientPhone) {
    const r = await pg.query(
      "SELECT user_id FROM client_wechat_users WHERE phone = $1 LIMIT 1",
      [clientPhone],
    );
    cuid = r[0]?.user_id;
  }
  await assertCustomerProfileVisible(pg, auth, cuid);
}


const CUSTOMER_TYPE_VALUES = ['流量客', '体验客', '小美客', '会员客'];
const SPENDING_TIER_VALUES = ['10W+', '6-10W', '3-6W', '1-3W', '1990-1W', '<1990'];
const MONTHLY_ACTIVITY_VALUES = ['二次客活', '一次客活', '0次客活'];
const CUSTOMER_STATUS_VALUES = ['保有会员-稳定', '保有会员-有效', '沉睡', '冰冻', '休眠'];


function buildProfileFilters(payload) {
  const { customerType, spendingTier, monthlyActivity, customerStatus } = payload || {};
  const columns = [];
  const values = [];
  if (customerType && customerType !== 'all' && CUSTOMER_TYPE_VALUES.includes(customerType)) {
    columns.push('c.customer_type');
    values.push(customerType);
  }
  if (spendingTier && SPENDING_TIER_VALUES.includes(spendingTier)) {
    columns.push('c.spending_tier');
    values.push(spendingTier);
  }
  if (monthlyActivity && MONTHLY_ACTIVITY_VALUES.includes(monthlyActivity)) {
    columns.push('c.monthly_activity');
    values.push(monthlyActivity);
  }
  if (customerStatus && CUSTOMER_STATUS_VALUES.includes(customerStatus)) {
    columns.push('c.customer_status');
    values.push(customerStatus);
  }
  return { columns, values };
}


function renderProfileFilters(filters, startIdx) {
  return filters.columns.map((col, i) => ` AND ${col} = $${startIdx + i}`).join('');
}


async function search(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const { keyword, phone, crossStore, profileScope } = ctx.event.payload || {};

  
  const filters = buildProfileFilters(ctx.event.payload);

  
  
  const restrictEmp = profileScope && restrictToBoundEmployee(ctx.auth);

  const limit = 20;
  let rows = [];

  if (phone) {
    
    
    const fSql = renderProfileFilters(filters, 2);
    rows = await pg.query(
      `SELECT c.user_id, c.phone, c.name, c.customer_id, c.member_level, c.customer_type,
              c.bound_store_id, s.store_name
       FROM client_wechat_users c
       LEFT JOIN stores s ON s.store_id = c.bound_store_id
       WHERE c.phone = $1${fSql}`,
      [phone.trim(), ...filters.values],
    );
  } else if (keyword && keyword.trim()) {
    const kw = `%${keyword.trim()}%`;
    if (crossStore) {
      
      
      
      const fSql = renderProfileFilters(filters, 2);
      const limitIdx = 2 + filters.values.length;
      rows = await pg.query(
        `SELECT c.user_id, c.phone, c.name, c.customer_id, c.member_level, c.customer_type,
                c.bound_store_id, c.is_cross_store_temp, s.store_name
         FROM client_wechat_users c
         LEFT JOIN stores s ON s.store_id = c.bound_store_id
         WHERE (c.phone LIKE $1 OR c.name LIKE $1)${fSql}
         LIMIT $${limitIdx}`,
        [kw, ...filters.values, limit],
      );
    } else {
      
      
      
      
      const scope = buildStoreScopeCondition(ctx.auth, 'c.bound_store_id', 2);
      const params = [kw, ...scope.params];
      let empClause = '';
      if (restrictEmp) {
        empClause = ` AND c.bound_employee_id = $${params.length + 1}`;
        params.push(ctx.auth.staffWfId);
      }
      const fStart = params.length + 1;
      const fSql = renderProfileFilters(filters, fStart);
      const limitIdx = fStart + filters.values.length;
      rows = await pg.query(
        `SELECT c.user_id, c.phone, c.name, c.customer_id, c.member_level, c.customer_type,
                c.bound_store_id, s.store_name
         FROM client_wechat_users c
         LEFT JOIN stores s ON s.store_id = c.bound_store_id
         WHERE (c.phone LIKE $1 OR c.name LIKE $1) AND ${scope.sql}${empClause}${fSql}
         LIMIT $${limitIdx}`,
        [...params, ...filters.values, limit],
      );
    }
  } else {
    
    
    
    const scope = buildStoreScopeCondition(ctx.auth, 'c.bound_store_id', 1);
    const params = [...scope.params];
    let empClause = '';
    if (restrictEmp) {
      empClause = ` AND c.bound_employee_id = $${params.length + 1}`;
      params.push(ctx.auth.staffWfId);
    }
    const fStart = params.length + 1;
    const fSql = renderProfileFilters(filters, fStart);
    const limitIdx = fStart + filters.values.length;
    rows = await pg.query(
      `SELECT c.user_id, c.phone, c.name, c.customer_id, c.member_level, c.customer_type,
              c.bound_store_id, s.store_name
       FROM client_wechat_users c
       LEFT JOIN stores s ON s.store_id = c.bound_store_id
       WHERE ${scope.sql}${empClause}${fSql}
       LIMIT $${limitIdx}`,
      [...params, ...filters.values, limit],
    );
  }

  const results = rows.map((r) => ({
    id: r.customer_id || null,
    clientUserId: r.user_id,
    customerNo: r.customer_id || null,
    name: r.name ? r.name.trim() : "",
    phone: maskPhoneForAuth(r.phone, ctx.auth),
    phoneMasked: maskPhone(r.phone),
    memberLevel: r.member_level || null,
    customerType: r.customer_type || null,
    storeName: r.store_name ? r.store_name.trim() : "",
    boundStoreId: r.bound_store_id || null,
    
    isCrossStoreTemp: r.is_cross_store_temp === true,
    lastServiceDate: null,
    lastPurchaseName: null,
    source: r.customer_id ? "both" : "miniprogram",
  }));

  
  const allClientUserIds = results.map(r => r.clientUserId).filter(Boolean);

  if (allClientUserIds.length > 0) {
    
    const svcDateRows = await pg.query(`
      SELECT DISTINCT ON (so.client_user_id)
             so.client_user_id, so.service_date
      FROM service_orders so
      WHERE so.client_user_id = ANY($1) AND so.status = '已完成'
      ORDER BY so.client_user_id, so.service_date DESC
    `, [allClientUserIds]);
    const svcDateMap = {};
    for (const r of svcDateRows) {
      svcDateMap[r.client_user_id] = r.service_date;
    }

    
    const lastPurchaseRows = await pg.query(`
      SELECT DISTINCT ON (o.client_user_id)
             o.client_user_id, si.product_name AS last_product_name
      FROM sale_orders o
      JOIN sale_items si ON si.sale_order_id = o.sale_order_id
      WHERE o.client_user_id = ANY($1)
        AND o.status IN ('已支付', '已完成')
        AND si.item_direction = '购买'
      ORDER BY o.client_user_id, o.paid_at DESC NULLS LAST, si.sale_item_id ASC
    `, [allClientUserIds]);
    const lastPurchaseMap = {};
    for (const r of lastPurchaseRows) {
      lastPurchaseMap[r.client_user_id] = r.last_product_name;
    }

    for (const item of results) {
      if (item.clientUserId) {
        item.lastServiceDate = svcDateMap[item.clientUserId] || null;
        item.lastPurchaseName = lastPurchaseMap[item.clientUserId] || null;
      }
    }
  }

  ctx.result = results;
}


async function calendar(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const { clientUserId, clientPhone, year, month } = ctx.event.payload || {};

  if (!clientUserId && !clientPhone) {
    throw new Error("INVALID_PARAMS: 缺少 clientUserId 或 clientPhone");
  }

  if (!year || !month) {
    throw new Error("INVALID_PARAMS: 缺少 year 或 month");
  }

  await assertProfileVisibleByIdentifier(ctx.auth, clientUserId, clientPhone);

  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 1);

  let whereClause;
  const params = [startDate, endDate];

  if (clientUserId) {
    params.push(clientUserId);
    whereClause = `
      o.status = '已支付'
      AND o.paid_at >= $1
      AND o.paid_at < $2
      AND o.client_user_id = $3
    `;
  } else {
    params.push(clientPhone);
    whereClause = `
      o.status = '已支付'
      AND o.paid_at >= $1
      AND o.paid_at < $2
      AND o.client_phone = $3
    `;
  }

  

  const rows = await pg.query(
    `
    SELECT
      DATE(o.paid_at AT TIME ZONE 'Asia/Shanghai') AS pay_date,
      COUNT(DISTINCT o.sale_order_id) AS order_count,
      COALESCE(SUM(si.received), 0) AS total_received
    FROM sale_orders o
    INNER JOIN sale_items si ON o.sale_order_id = si.sale_order_id
    WHERE ${whereClause}
    GROUP BY DATE(o.paid_at AT TIME ZONE 'Asia/Shanghai')
    ORDER BY pay_date
  `,
    params,
  );

  const orderRows = await pg.query(
    `
    SELECT
      o.sale_order_id,
      o.sale_order_type,
      o.store_id,
      o.payment_method,
      o.paid_at,
      o.client_phone,
      o.customer_name,
      DATE(o.paid_at AT TIME ZONE 'Asia/Shanghai') AS pay_date,
      o.total_amount AS total_received
    FROM sale_orders o
    WHERE ${whereClause}
    ORDER BY o.paid_at DESC
  `,
    params,
  );

  ctx.result = {
    year,
    month,
    dailySummary: rows.map((r) => ({
      date: r.pay_date,
      orderCount: parseInt(r.order_count),
      totalReceived: parseFloat(r.total_received),
    })),
    orders: orderRows.map((r) => ({
      saleOrderId: r.sale_order_id,
      orderType: r.sale_order_type,
      storeId: r.store_id,
      paymentMethod: r.payment_method,
      paidAt: r.paid_at,
      payDate: r.pay_date,
      clientPhone: r.client_phone,
      customerName: r.customer_name,
      totalReceived: parseFloat(r.total_received),
    })),
  };
}


async function detail(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const { id, phone: queryPhone, clientUserId: queryClientUserId } = ctx.event.payload || {};
  if (!id && !queryPhone && !queryClientUserId) {
    throw new Error("INVALID_PARAMS: 缺少 id、phone 或 clientUserId 参数");
  }

  const selectCols = `c.user_id, c.phone, c.name, c.customer_id, c.member_level,
    c.bound_employee_id, c.skin_type, c.improvement_focus, c.gender, c.notes,
    c.bound_store_id, s.store_name`;

  const fromClause = `FROM client_wechat_users c
    LEFT JOIN stores s ON s.store_id = c.bound_store_id`;

  
  let pgUser = null;
  if (id) {
    const rows = await pg.query(
      `SELECT ${selectCols} ${fromClause} WHERE c.customer_id = $1 LIMIT 1`,
      [id],
    );
    if (rows.length > 0) pgUser = rows[0];
  }

  if (!pgUser && queryClientUserId) {
    const rows = await pg.query(
      `SELECT ${selectCols} ${fromClause} WHERE c.user_id = $1 LIMIT 1`,
      [queryClientUserId],
    );
    if (rows.length > 0) pgUser = rows[0];
  }

  if (!pgUser && queryPhone && queryPhone.trim()) {
    const rows = await pg.query(
      `SELECT ${selectCols} ${fromClause} WHERE c.phone = $1 LIMIT 1`,
      [queryPhone.trim()],
    );
    if (rows.length > 0) pgUser = rows[0];
  }

  if (!pgUser) {
    throw new Error("INVALID_PARAMS: 顾客不存在");
  }

  
  if (pgUser.bound_store_id && !isStoreInScope(ctx.auth, pgUser.bound_store_id)) {
    throw new Error('PERMISSION_DENIED: 顾客不在当前门店范围内')
  }
  
  if (restrictToBoundEmployee(ctx.auth) && pgUser.bound_employee_id !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 顾客未分配给当前员工')
  }

  const phone = pgUser.phone || "";

  
  let name = pgUser.name || "";
  if (!name && phone) {
    const nameRows = await pg.query(
      `SELECT customer_name FROM sale_orders
       WHERE client_phone = $1 AND customer_name IS NOT NULL AND customer_name != ''
       ORDER BY created_at DESC LIMIT 1`,
      [phone],
    );
    if (nameRows.length > 0) name = nameRows[0].customer_name;
  }

  
  let preferredStaffName = null;
  if (pgUser.bound_employee_id) {
    const staffRows = await pg.query(
      "SELECT name FROM staff_wechat_users WHERE employee_id = $1",
      [pgUser.bound_employee_id],
    );
    if (staffRows.length > 0) preferredStaffName = staffRows[0].name || null;
  }

  const { totalConsumption, yearConsumption } = await getConsumptionStats(pgUser.user_id);

  
  const clientUserId = pgUser.user_id;
  const [visitInfo, purchaseInfo, legacyCountRow] = await Promise.all([
    getVisitInfo(clientUserId),
    getTopProduct(clientUserId),
    
    phone
      ? pg.query(
          `SELECT COUNT(*)::int AS cnt FROM sale_orders
           WHERE legacy_source = 'workfine' AND status = '未审核' AND client_phone = $1`,
          [phone],
        )
      : Promise.resolve([{ cnt: 0 }]),
  ]);
  const legacyOrderCount = legacyCountRow[0]?.cnt || 0;

  ctx.result = {
    id: pgUser.customer_id || null,
    clientUserId,
    name,
    gender: pgUser.gender || null,
    phone: maskPhoneForAuth(phone, ctx.auth),
    phoneMasked: maskPhone(phone),
    memberLevel: pgUser.member_level || null,
    storeName: pgUser.store_name ? pgUser.store_name.trim() : "",
    preferredStaffName,
    skinType: pgUser.skin_type || null,
    focusAreas: pgUser.improvement_focus || null,
    notes: pgUser.notes || null,
    lastServiceDate: visitInfo.lastServiceDate,
    visitFrequency: visitInfo.visitFrequency,
    topProductName: purchaseInfo,
    totalConsumption,
    yearConsumption,
    source: pgUser.customer_id ? "both" : "miniprogram",
    legacyOrderCount,
  };
}


async function getVisitInfo(clientUserId) {
  if (!clientUserId) return { lastServiceDate: null, visitFrequency: null };

  const rows = await pg.query(`
    SELECT
      MAX(so.service_date) AS last_date,
      COUNT(DISTINCT so.service_date) FILTER (WHERE so.service_date >= CURRENT_DATE - INTERVAL '90 days') AS visit_count_90d
    FROM service_orders so
    WHERE so.client_user_id = $1 AND so.status = '已完成'
  `, [clientUserId]);

  const lastDate = rows[0].last_date || null;
  const count90d = parseInt(rows[0].visit_count_90d) || 0;

  let visitFrequency = null;
  if (count90d >= 12) visitFrequency = '一周一次以上';
  else if (count90d >= 6) visitFrequency = '两周一次';
  else if (count90d >= 3) visitFrequency = '一月一次';
  else if (count90d >= 1) visitFrequency = '偶尔到店';

  return { lastServiceDate: lastDate, visitFrequency };
}


async function getTopProduct(clientUserId) {
  if (!clientUserId) return null;

  const rows = await pg.query(`
    SELECT si.product_name, COUNT(*) AS cnt
    FROM sale_orders o
    JOIN sale_items si ON si.sale_order_id = o.sale_order_id
    WHERE o.client_user_id = $1
      AND o.status IN ('已支付', '已完成')
      AND si.item_direction = '购买'
    GROUP BY si.product_name
    ORDER BY cnt DESC
    LIMIT 1
  `, [clientUserId]);

  return rows.length > 0 ? rows[0].product_name : null;
}


async function getConsumptionStats(clientUserId) {
  if (!clientUserId) return { totalConsumption: 0, yearConsumption: 0 };

  const yearStart = new Date(new Date().getFullYear(), 0, 1);
  const rows = await pg.query(
    `SELECT
       COALESCE(SUM(si.received::numeric), 0) AS total,
       COALESCE(SUM(CASE WHEN o.paid_at >= $2 THEN si.received::numeric ELSE 0 END), 0) AS year_total
     FROM sale_orders o
     JOIN sale_items si ON o.sale_order_id = si.sale_order_id
     WHERE o.status = '已支付' AND o.client_user_id = $1`,
    [clientUserId, yearStart],
  );
  return {
    totalConsumption: Number(rows[0].total),
    yearConsumption: Number(rows[0].year_total),
  };
}


async function paidOrders(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const payload = ctx.event.payload || {};
  let clientUserId = payload.clientUserId;
  const clientPhone = payload.clientPhone;
  if (!clientUserId && !clientPhone) {
    throw new Error("INVALID_PARAMS: 缺少 clientUserId 或 clientPhone");
  }

  
  
  if (!clientUserId && clientPhone) {
    const r = await pg.query(
      "SELECT user_id FROM client_wechat_users WHERE phone = $1 LIMIT 1",
      [clientPhone],
    );
    clientUserId = r[0]?.user_id || null;
  }

  
  if (clientUserId) {
    await assertCustomerInScope(pg, ctx.auth, clientUserId)
  }

  
  
  
  let whereClause, params;
  if (clientUserId) {
    whereClause = "o.status IN ('已支付', '部分支付') AND o.client_user_id = $1";
    params = [clientUserId];
  } else {
    
    
    const scope = buildStoreScopeCondition(ctx.auth, "o.store_id", 2);
    whereClause = `o.status IN ('已支付', '部分支付') AND o.client_phone = $1 AND ${scope.sql}`;
    params = [clientPhone, ...scope.params];
  }

  const orders = await pg.query(
    `SELECT o.sale_order_id, o.status, o.paid_at, o.store_id, s.store_name
     FROM sale_orders o
     LEFT JOIN stores s ON s.store_id = o.store_id
     WHERE ${whereClause}
     ORDER BY o.paid_at DESC`,
    params,
  );

  if (orders.length === 0) {
    ctx.result = [];
    return;
  }

  const orderIds = orders.map((o) => o.sale_order_id);
  const items = await pg.query(
    `SELECT
      si.sale_order_id,
      si.sale_item_id,
      si.store_id,
      si.session_count,
      si.remaining_sessions,
      si.paid_sessions,
      si.sku_id,
      si.product_type,
      si.product_name,
      si.unit_real_price
    FROM sale_items si
    JOIN sale_orders o ON si.sale_order_id = o.sale_order_id
    WHERE si.sale_order_id = ANY($1)
      -- M12：历史订单（workfine 拉取）的 NULL 卡不下发（后端过滤，前端 uniform-disabled 保留给非 legacy NULL 卡）
      AND NOT (si.paid_sessions IS NULL AND o.legacy_source = 'workfine')
      -- 在途退款冻结：原订单存在 '待审批' 退款时排除整单的卡
      AND NOT EXISTS (
        SELECT 1 FROM sale_order_payments sop
        WHERE sop.sale_order_id = si.sale_order_id
          AND sop.change_type = '退款' AND sop.status = '待审批'
      )
      -- 审批后隐藏已退完的卡：仅当订单存在已审批退款时按 paid_sessions 有效余量判定（不影响无退款的分期卡）
      AND (
        NOT EXISTS (
          SELECT 1 FROM sale_order_payments sop
          WHERE sop.sale_order_id = si.sale_order_id
            AND sop.change_type = '退款' AND sop.status = '已支付'
        )
        OR si.paid_sessions IS NULL
        OR si.paid_sessions > (si.session_count - si.remaining_sessions)
      )
    ORDER BY si.sale_item_id`,
    [orderIds],
  );

  const itemsByOrder = {};
  for (const item of items) {
    if (!itemsByOrder[item.sale_order_id]) itemsByOrder[item.sale_order_id] = [];
    itemsByOrder[item.sale_order_id].push({
      saleItemId: item.sale_item_id,
      storeId: item.store_id,
      itemName: item.product_name || "",
      spec: item.product_name || "",
      sessionCount: item.session_count,
      remainingSessions: item.remaining_sessions,
      totalSessions: item.session_count,
      paidSessions: item.paid_sessions,
      productType: item.product_type || "",
      unitRealPrice: item.unit_real_price != null ? Number(item.unit_real_price).toFixed(2) : "",
    });
  }

  ctx.result = orders.map((o) => ({
    orderId: o.sale_order_id,
    saleOrderId: o.sale_order_id,
    status: o.status,
    paidAt: o.paid_at,
    storeId: o.store_id,
    storeName: o.store_name || "",
    items: itemsByOrder[o.sale_order_id] || [],
  }));
}


async function orderHistory(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const payload = ctx.event.payload || {};
  let clientUserId = payload.clientUserId;
  const clientPhone = payload.clientPhone;
  if (!clientUserId && !clientPhone) {
    throw new Error("INVALID_PARAMS: 缺少 clientUserId 或 clientPhone");
  }

  
  if (!clientUserId && clientPhone) {
    const r = await pg.query(
      "SELECT user_id FROM client_wechat_users WHERE phone = $1 LIMIT 1",
      [clientPhone],
    );
    clientUserId = r[0]?.user_id || null;
  }

  
  if (clientUserId) {
    await assertCustomerInScope(pg, ctx.auth, clientUserId);
  }

  
  let whereClause, params;
  if (clientUserId) {
    whereClause = "o.client_user_id = $1";
    params = [clientUserId];
  } else {
    
    const scope = buildStoreScopeCondition(ctx.auth, "o.store_id", 2);
    whereClause = `o.client_phone = $1 AND ${scope.sql}`;
    params = [clientPhone, ...scope.params];
  }

  
  const orders = await pg.query(
    `SELECT o.sale_order_id, o.status, o.paid_at, o.created_at,
            o.payable_amount, o.received, o.store_id, s.store_name, o.remark
     FROM sale_orders o
     LEFT JOIN stores s ON s.store_id = o.store_id
     WHERE ${whereClause}
     ORDER BY COALESCE(o.paid_at, o.created_at) DESC`,
    params,
  );

  if (orders.length === 0) {
    ctx.result = [];
    return;
  }

  
  const orderIds = orders.map((o) => o.sale_order_id);
  const items = await pg.query(
    `SELECT si.sale_order_id, si.sale_item_id, si.product_name, si.product_type
     FROM sale_items si
     WHERE si.sale_order_id = ANY($1)
     ORDER BY si.sale_item_id`,
    [orderIds],
  );

  const itemsByOrder = {};
  for (const item of items) {
    if (!itemsByOrder[item.sale_order_id]) itemsByOrder[item.sale_order_id] = [];
    itemsByOrder[item.sale_order_id].push({
      saleItemId: item.sale_item_id,
      itemName: item.product_name || "",
      spec: item.product_name || "",
      productType: item.product_type || "",
    });
  }

  ctx.result = orders.map((o) => ({
    orderId: o.sale_order_id,
    saleOrderId: o.sale_order_id,
    status: o.status,
    payableAmount: o.payable_amount,
    received: o.received,
    paidAt: o.paid_at,
    createdAt: o.created_at,
    storeId: o.store_id,
    storeName: o.store_name || "",
    remark: o.remark || "",
    items: itemsByOrder[o.sale_order_id] || [],
  }));
}


async function serviceHistory(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const payload = ctx.event.payload || {};
  let clientUserId = payload.clientUserId;
  const clientPhone = payload.clientPhone;
  if (!clientUserId && !clientPhone) {
    throw new Error("INVALID_PARAMS: 缺少 clientUserId 或 clientPhone");
  }

  
  if (!clientUserId && clientPhone) {
    const r = await pg.query(
      "SELECT user_id FROM client_wechat_users WHERE phone = $1 LIMIT 1",
      [clientPhone],
    );
    clientUserId = r[0]?.user_id || null;
  }
  if (!clientUserId) {
    ctx.result = [];
    return;
  }

  
  await assertCustomerInScope(pg, ctx.auth, clientUserId);

  const serviceOrders = await pg.query(
    `SELECT so.service_order_id, so.status, so.service_date,
            so.assigned_employee_id, so.client_user_id, so.appointment_id,
            so.started_at, so.completed_at, so.created_at,
            so.store_id, s.store_name
     FROM service_orders so
     LEFT JOIN stores s ON s.store_id = so.store_id
     WHERE so.client_user_id = $1
     ORDER BY so.service_date DESC, so.created_at DESC`,
    [clientUserId],
  );

  if (serviceOrders.length === 0) {
    ctx.result = [];
    return;
  }

  
  const soIds = serviceOrders.map((s) => s.service_order_id);
  const itemsSummary = await pg.query(
    `SELECT si.service_order_id, COALESCE(sli.product_name, '') AS product_name
     FROM service_items si
     LEFT JOIN sale_items sli ON si.sale_item_id = sli.sale_item_id
     WHERE si.service_order_id = ANY($1)
     ORDER BY si.sale_item_id`,
    [soIds],
  );
  const itemsMap = {};
  for (const i of itemsSummary) {
    if (!itemsMap[i.service_order_id]) itemsMap[i.service_order_id] = [];
    itemsMap[i.service_order_id].push({
      itemName: i.product_name,
      spec: i.product_name || "",
    });
  }

  
  const staffWfIds = [...new Set(serviceOrders.map((s) => s.assigned_employee_id).filter(Boolean))];
  const staffNameMap = {};
  if (staffWfIds.length > 0) {
    const staffRows = await pg.query(
      "SELECT employee_id, name FROM staff_wechat_users WHERE employee_id = ANY($1)",
      [staffWfIds],
    );
    for (const r of staffRows) staffNameMap[r.employee_id] = r.name || "";
  }

  ctx.result = serviceOrders.map((so) => ({
    id: so.service_order_id,
    serviceOrderId: so.service_order_id,
    status: so.status,
    serviceTime: so.service_date,
    startTime: so.started_at,
    completedTime: so.completed_at,
    staffName: staffNameMap[so.assigned_employee_id] || "",
    appointmentId: so.appointment_id,
    storeId: so.store_id,
    storeName: so.store_name || "",
    items: itemsMap[so.service_order_id] || [],
  }));
}


async function stats(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const now = new Date()
  const today = shanghaiDateStr(now)
  const currentMonth = now.getMonth() + 1
  const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1

  
  
  const restrictEmp = restrictToBoundEmployee(ctx.auth)
  const cScope = buildStoreScopeCondition(ctx.auth, 'c.bound_store_id', 1)
  let cWhere = cScope.sql
  const cParams = [...cScope.params]
  if (restrictEmp) {
    cWhere += ` AND c.bound_employee_id = $${cParams.length + 1}`
    cParams.push(ctx.auth.staffWfId)
  }
  const soScope = buildStoreScopeCondition(ctx.auth, 'so.store_id', cParams.length + 1)
  const rows = await pg.query(`
    SELECT
      c.user_id,
      c.birthday,
      c.customer_type,
      c.customer_status,
      MAX(so.service_date) AS last_service_date
    FROM client_wechat_users c
    LEFT JOIN service_orders so
      ON so.client_user_id = c.user_id
      AND so.status = '已完成'
      AND ${soScope.sql}
    WHERE ${cWhere}
    GROUP BY c.user_id, c.birthday, c.customer_type, c.customer_status
  `, [...cParams, ...soScope.params])

  let active = 0, atRisk = 0, lost = 0, sleeping = 0, birthday = 0, birthdayNext = 0

  for (const r of rows) {
    
    
    
    
    
    if (r.customer_type === '会员客' && r.customer_status) {
      switch (r.customer_status) {
        case '保有会员-稳定':
        case '保有会员-有效': active++; break
        case '沉睡': atRisk++; break
        case '冰冻': lost++; break
        case '休眠': sleeping++; break
        default: sleeping++
      }
    } else if (r.last_service_date) {
      const diffDays = Math.floor((new Date(today) - new Date(r.last_service_date)) / 86400000)
      if (diffDays <= 30) active++
      else if (diffDays <= 60) atRisk++
      else if (diffDays <= 90) lost++
      else sleeping++
    } else {
      sleeping++
    }
    
    if (r.birthday) {
      const bMonth = new Date(r.birthday).getMonth() + 1
      if (bMonth === currentMonth) birthday++
      if (bMonth === nextMonth) birthdayNext++
    }
  }

  
  const memberScope = buildStoreScopeCondition(ctx.auth, 'bound_store_id', 1)
  let memberWhere = memberScope.sql
  const memberParams = [...memberScope.params]
  if (restrictEmp) {
    memberWhere += ` AND bound_employee_id = $${memberParams.length + 1}`
    memberParams.push(ctx.auth.staffWfId)
  }
  const memberRows = await pg.query(`
    SELECT COUNT(*) AS cnt FROM client_wechat_users
    WHERE ${memberWhere} AND customer_type = '会员客'
  `, memberParams)
  const memberCount = Number(memberRows[0].cnt)

  ctx.result = {
    active, atRisk, lost, sleeping, birthday, birthdayNext,
    total: rows.length,
    memberCount,
    flowCount: rows.length - memberCount,
  }
}


async function listByTag(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { tag, page = 1, pageSize = 20 } = ctx.event.payload || {}
  if (!tag) {
    throw new Error('INVALID_PARAMS: 缺少 tag 参数')
  }

  const now = new Date()
  const today = shanghaiDateStr(now)
  const currentMonth = now.getMonth() + 1
  const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1

  
  
  const restrictEmp = restrictToBoundEmployee(ctx.auth)
  const cScope = buildStoreScopeCondition(ctx.auth, 'c.bound_store_id', 1)
  let cWhere = cScope.sql
  const cParams = [...cScope.params]
  if (restrictEmp) {
    cWhere += ` AND c.bound_employee_id = $${cParams.length + 1}`
    cParams.push(ctx.auth.staffWfId)
  }
  const soScope = buildStoreScopeCondition(ctx.auth, 'so.store_id', cParams.length + 1)
  const allRows = await pg.query(`
    SELECT
      c.user_id, c.name, c.phone, c.birthday, c.member_level,
      MAX(so.service_date) AS last_service_date
    FROM client_wechat_users c
    LEFT JOIN service_orders so
      ON so.client_user_id = c.user_id
      AND so.status = '已完成'
      AND ${soScope.sql}
    WHERE ${cWhere}
    GROUP BY c.user_id, c.name, c.phone, c.birthday, c.member_level
  `, [...cParams, ...soScope.params])

  
  const filtered = allRows.filter(r => {
    if (tag === 'birthday') {
      return r.birthday && (new Date(r.birthday).getMonth() + 1) === currentMonth
    }
    if (tag === 'birthdayNext') {
      return r.birthday && (new Date(r.birthday).getMonth() + 1) === nextMonth
    }
    const diffDays = r.last_service_date
      ? Math.floor((new Date(today) - new Date(r.last_service_date)) / 86400000)
      : Infinity
    if (tag === 'active') return diffDays <= 30
    if (tag === 'atRisk') return diffDays > 30 && diffDays <= 60
    if (tag === 'lost') return diffDays > 60 && diffDays <= 90
    if (tag === 'sleeping') return diffDays > 90
    return true
  })

  
  const offset = (page - 1) * pageSize
  const paged = filtered.slice(offset, offset + pageSize)

  
  const pagedUserIds = paged.map(r => r.user_id).filter(Boolean)
  const lastPurchaseMap = {}
  if (pagedUserIds.length > 0) {
    const lastPurchaseRows = await pg.query(`
      SELECT DISTINCT ON (o.client_user_id)
             o.client_user_id, si.product_name AS last_product_name
      FROM sale_orders o
      JOIN sale_items si ON si.sale_order_id = o.sale_order_id
      WHERE o.client_user_id = ANY($1)
        AND o.status IN ('已支付', '已完成')
        AND si.item_direction = '购买'
      ORDER BY o.client_user_id, o.paid_at DESC NULLS LAST, si.sale_item_id ASC
    `, [pagedUserIds])
    for (const r of lastPurchaseRows) {
      lastPurchaseMap[r.client_user_id] = r.last_product_name
    }
  }

  ctx.result = {
    total: filtered.length,
    customers: paged.map(r => {
      return {
        id: null,
        clientUserId: r.user_id,
        name: r.name || '',
        phone: maskPhoneForAuth(r.phone, ctx.auth),
        phoneMasked: maskPhone(r.phone),
        memberLevel: r.member_level,
        lastServiceDate: r.last_service_date,
        lastPurchaseName: lastPurchaseMap[r.user_id] || null,
        birthday: r.birthday,
        source: 'miniprogram',
      }
    })
  }
}


async function refundHistory(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { clientUserId, clientPhone, page = 1, pageSize = 50 } = ctx.event.payload || {}
  if (!clientUserId && !clientPhone) throw new Error('INVALID_PARAMS: 缺少 clientUserId 或 clientPhone')

  await assertProfileVisibleByIdentifier(ctx.auth, clientUserId, clientPhone)

  
  let refundParams, refundClientWhere
  if (clientUserId) {
    refundClientWhere = 'so.client_user_id = $1'
    refundParams = [clientUserId]
  } else {
    refundClientWhere = 'so.client_phone = $1'
    refundParams = [clientPhone]
  }
  
  const refundWhere = refundClientWhere
  refundParams.push(pageSize, (page - 1) * pageSize)
  const refundRows = await pg.query(`
    SELECT
      sop.id AS payment_id,
      sop.sale_order_id,
      sop.amount,
      sop.status,
      sop.created_at,
      sop.paid_at,
      sop.payment_method,
      sop.refund_reason,
      sop.audit_at,
      sop.audit_remark,
      sop.note AS detail_note,
      so.client_user_id,
      so.store_id
    FROM sale_order_payments sop
    JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
    WHERE sop.change_type = '退款'
      AND ${refundWhere}
    ORDER BY sop.created_at DESC
    LIMIT $${refundParams.length - 1} OFFSET $${refundParams.length}
  `, refundParams)

  
  let convParams, convClientWhere
  if (clientUserId) {
    convClientWhere = 'o.client_user_id = $1'
    convParams = [clientUserId]
  } else {
    convClientWhere = 'o.client_phone = $1'
    convParams = [clientPhone]
  }
  
  const convWhere = convClientWhere
  const convRows = await pg.query(`
    SELECT o.sale_order_id, o.status, o.sale_order_type, o.total_amount,
           o.created_at, o.paid_at
    FROM sale_orders o
    WHERE ${convWhere}
      AND o.sale_order_type = '转换单'
    ORDER BY o.created_at DESC
  `, convParams)

  
  const convOrderIds = convRows.map(o => o.sale_order_id)
  let convItems = []
  if (convOrderIds.length > 0) {
    convItems = await pg.query(
      `SELECT si.sale_order_id, si.sale_item_id, si.item_direction,
              si.product_name, si.quantity, si.received
       FROM sale_items si WHERE si.sale_order_id = ANY($1) ORDER BY si.sale_item_id`,
      [convOrderIds]
    )
  }
  const convItemsByOrder = {}
  for (const i of convItems) {
    if (!convItemsByOrder[i.sale_order_id]) convItemsByOrder[i.sale_order_id] = []
    convItemsByOrder[i.sale_order_id].push({
      saleItemId: i.sale_item_id,
      direction: i.item_direction,
      productName: i.product_name,
      specName: i.product_name,
      quantity: i.quantity,
      received: Number(i.received),
    })
  }

  const refunds = refundRows.map(r => {
    let parsedDetail = null
    if (r.detail_note) {
      try {
        parsedDetail = typeof r.detail_note === 'string' ? JSON.parse(r.detail_note) : r.detail_note
      } catch (_) {}
    }
    return {
      paymentId: r.payment_id,
      saleOrderId: r.sale_order_id,    
      type: '退款',
      status: r.status,
      totalAmount: Number(r.amount),    
      refundReason: r.refund_reason,
      handlingFee: parsedDetail?.handlingFee ?? null,
      refOrderId: r.sale_order_id,
      paymentMethod: r.payment_method,
      createdAt: r.created_at,
      paidAt: r.paid_at,
      approvedAt: r.audit_at,
      rejectedReason: r.status === '已作废' ? r.audit_remark : null,
      items: parsedDetail?.items || [],
    }
  })

  const conversions = convRows.map(o => ({
    saleOrderId: o.sale_order_id,
    type: o.sale_order_type,
    status: o.status,
    totalAmount: Number(o.total_amount),
    createdAt: o.created_at,
    paidAt: o.paid_at,
    items: convItemsByOrder[o.sale_order_id] || [],
  }))

  
  ctx.result = [...refunds, ...conversions].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )
}


async function updateNotes(ctx) {
  await requireManager()(ctx, async () => {})

  const { clientUserId, notes } = ctx.event.payload || {}
  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')
  if (typeof notes !== 'string') throw new Error('INVALID_PARAMS: notes 必须为字符串')

  const trimmed = notes.trim().slice(0, 500)

  
  
  await assertCustomerInScope(pg, ctx.auth, clientUserId)

  await pg.transaction(async (client) => {
    await client.query(
      'UPDATE client_wechat_users SET notes = $1, updated_at = NOW() WHERE user_id = $2',
      [trimmed || null, clientUserId]
    )
    
    await logOperation(client, ctx, 'customer.updateNotes', 'customer', clientUserId, {
      _v: 3,
      notesLength: trimmed ? trimmed.length : 0,
    })
  })

  ctx.result = { message: '备注已保存' }
}


async function customerBalance(ctx) {
  await requireManager()(ctx, async () => {})

  const { customerUserId } = ctx.event.payload || {}
  if (!customerUserId) {
    throw new Error('INVALID_PARAMS: 缺少 customerUserId')
  }

  
  
  
  const scopeRows = await pg.query(
    'SELECT bound_store_id FROM client_wechat_users WHERE user_id = $1',
    [customerUserId]
  )
  if (scopeRows.length === 0) {
    throw new Error('PERMISSION_DENIED: 顾客不存在')
  }
  const boundStoreId = scopeRows[0].bound_store_id
  if (boundStoreId !== null && !isStoreInScope(ctx.auth, boundStoreId)) {
    throw new Error('PERMISSION_DENIED: 顾客不在当前门店范围内')
  }

  const rows = await pg.query(
    'SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1',
    [customerUserId]
  )

  if (rows.length === 0) {
    ctx.result = { cardId: null, balance: 0 }
    return
  }

  ctx.result = {
    cardId: rows[0].card_id,
    balance: Number(rows[0].balance),
  }
}


async function assign(ctx) {
  await requireManager()(ctx, async () => {})

  const { clientUserId, employeeId } = ctx.event.payload || {}
  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')
  if (!employeeId) throw new Error('INVALID_PARAMS: 缺少 employeeId')

  
  await assertCustomerInScope(pg, ctx.auth, clientUserId)
  await assertEmployeeInScope(pg, ctx.auth, employeeId)

  const staffRows = await pg.query(
    'SELECT name FROM staff_wechat_users WHERE employee_id = $1',
    [employeeId]
  )
  if (staffRows.length === 0) {
    throw new Error('INVALID_PARAMS: 员工不存在')
  }

  await pg.transaction(async (client) => {
    await client.query(
      'UPDATE client_wechat_users SET bound_employee_id = $1, updated_at = NOW() WHERE user_id = $2',
      [employeeId, clientUserId]
    )
    
    await logOperation(client, ctx, 'customer.assign', 'customer', clientUserId, {
      _v: 3,
      employeeId,
      employeeName: staffRows[0].name,
    })
  })

  ctx.result = {
    message: '分配成功',
    employeeName: staffRows[0].name,
  }
}


async function appointments(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { clientUserId, clientPhone } = ctx.event.payload || {}
  if (!clientUserId && !clientPhone) {
    throw new Error('INVALID_PARAMS: 缺少 clientUserId 或 clientPhone')
  }

  await assertProfileVisibleByIdentifier(ctx.auth, clientUserId, clientPhone)

  let clientWhere, params
  if (clientUserId) {
    clientWhere = 'a.client_user_id = $1'
    params = [clientUserId]
  } else {
    clientWhere = 'wu.phone = $1'
    params = [clientPhone]
  }
  const scope = buildStoreScopeCondition(ctx.auth, 'a.store_id', params.length + 1)
  params.push(...scope.params)

  const rows = await pg.query(`
    SELECT
      a.appointment_id, a.status, a.client_user_id, a.client_name,
      a.employee_name, a.appointment_time, a.notes, a.checkin_at, a.created_at,
      COALESCE(si.product_name, '到店预约') AS service_name
    FROM appointments a
    LEFT JOIN sale_items si ON a.sale_item_id = si.sale_item_id
    LEFT JOIN client_wechat_users wu ON a.client_user_id = wu.user_id
    WHERE ${clientWhere} AND ${scope.sql}
    ORDER BY a.appointment_time DESC
  `, params)

  ctx.result = rows.map(a => ({
    id: a.appointment_id,
    customerName: a.client_name,
    clientUserId: a.client_user_id,
    staffName: a.employee_name,
    appointmentTime: a.appointment_time,
    statusText: a.status,
    serviceItemName: a.service_name || '',
    remark: a.notes || '',
    checkinAt: a.checkin_at,
    createdAt: a.created_at,
  }))
}


async function phoneChangeLogs(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { clientUserId, clientPhone } = ctx.event.payload || {}
  if (!clientUserId && !clientPhone) {
    throw new Error('INVALID_PARAMS: 缺少 clientUserId 或 clientPhone')
  }

  
  let cuid = clientUserId
  if (!cuid && clientPhone) {
    const r = await pg.query(
      'SELECT user_id FROM client_wechat_users WHERE phone = $1 LIMIT 1',
      [clientPhone],
    )
    cuid = r[0]?.user_id
  }
  if (!cuid) { ctx.result = []; return }

  
  await assertCustomerProfileVisible(pg, ctx.auth, cuid)

  const rows = await pg.query(`
    SELECT id, created_at, action, detail, source, operator_employee_id, operator_name
    FROM operation_logs
    WHERE (
      (action = 'auth.rebindPhone' AND target_type = 'client_user' AND target_id = $1)
      OR (action = 'customer.update' AND target_type = 'customer' AND target_id = $1
          AND (detail -> 'changes' ? 'phone'))
    )
    ORDER BY created_at DESC
    LIMIT 200
  `, [cuid])

  ctx.result = rows.map(r => {
    const detail = r.detail || {}
    if (r.action === 'customer.update') {
      const phoneDiff = (detail.changes && detail.changes.phone) || {}
      return {
        id: r.id,
        createdAt: r.created_at,
        oldPhone: maskPhoneForAuth(phoneDiff.from ?? null, ctx.auth),
        newPhone: maskPhoneForAuth(phoneDiff.to ?? null, ctx.auth),
        operatorLabel: r.operator_name || r.operator_employee_id || '—',
        source: 'admin',
      }
    }
    
    const operatorLabel = r.operator_employee_id
      ? (r.operator_name || r.operator_employee_id)
      : (detail.clientUserId ? '顾客自助' : (r.operator_name || '—'))
    return {
      id: r.id,
      createdAt: r.created_at,
      oldPhone: maskPhoneForAuth(detail.oldPhone ?? null, ctx.auth),
      newPhone: maskPhoneForAuth(detail.newPhone ?? null, ctx.auth),
      operatorLabel,
      source: 'client',
    }
  })
}

module.exports = { search, calendar, detail, paidOrders, orderHistory, serviceHistory, stats, listByTag, refundHistory, updateNotes, assign, customerBalance, appointments, phoneChangeLogs };
