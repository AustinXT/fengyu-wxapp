/**
 * 顾客档案模块路由（员工端）
 * customer.search — 搜索顾客（PG 单源）
 * customer.calendar — 顾客消费日历
 * customer.detail — 顾客档案详情
 * customer.paidOrders — 顾客已支付订单（含明细）
 *
 * 运行时 100% PG，零 MSSQL 依赖。WorkFine 数据通过同步模块写入 client_wechat_users。
 */

const pg = require("../db/pg");
const { requireStaffBound, requireManager } = require("../middleware/auth");
const {
  buildStoreScopeCondition,
  isStoreInScope,
  assertCustomerInScope,
  assertEmployeeInScope,
} = require("../utils/scope");
const { maskPhone } = require("../utils/pii");

/**
 * 搜索顾客（PG 单源）
 * 数据来源 = PG client_wechat_users（含 WorkFine 同步数据）
 */
async function search(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const { keyword, phone, customerType, crossStore } = ctx.event.payload || {};

  const isManagerRole = ctx.auth.roles.includes("manager");

  // customerType 过滤：'member' = 会员客（customer_id 非空），'flow' = 流量客（customer_id 为空）
  const typeFilter = customerType === 'member'
    ? ' AND c.customer_id IS NOT NULL'
    : customerType === 'flow'
    ? ' AND c.customer_id IS NULL'
    : '';

  const limit = 20;
  let rows = [];

  if (phone) {
    rows = await pg.query(
      `SELECT c.user_id, c.phone, c.name, c.customer_id, c.member_level,
              c.bound_store_id, s.store_name
       FROM client_wechat_users c
       LEFT JOIN stores s ON s.store_id = c.bound_store_id
       WHERE c.phone = $1 AND c.bound_store_id IS NOT NULL${typeFilter}`,
      [phone.trim()],
    );
  } else if (keyword && keyword.trim()) {
    const kw = `%${keyword.trim()}%`;
    if (crossStore) {
      // 跨门店模糊检索：开单 / 充值卡选顾客用（与 phone 精确分支同口径，绑定任意门店即可见）
      rows = await pg.query(
        `SELECT c.user_id, c.phone, c.name, c.customer_id, c.member_level,
                c.bound_store_id, s.store_name
         FROM client_wechat_users c
         LEFT JOIN stores s ON s.store_id = c.bound_store_id
         WHERE (c.phone LIKE $1 OR c.name LIKE $1) AND c.bound_store_id IS NOT NULL${typeFilter}
         LIMIT $2`,
        [kw, limit],
      );
    } else {
      // 门店内模糊检索：顾客 Tab / 服务单选顾客用
      rows = await pg.query(
        `SELECT c.user_id, c.phone, c.name, c.customer_id, c.member_level,
                c.bound_store_id, s.store_name
         FROM client_wechat_users c
         LEFT JOIN stores s ON s.store_id = c.bound_store_id
         WHERE (c.phone LIKE $1 OR c.name LIKE $1) AND c.bound_store_id = $2${typeFilter}
         LIMIT $3`,
        [kw, ctx.auth.effectiveStoreId, limit],
      );
    }
  } else {
    rows = await pg.query(
      `SELECT c.user_id, c.phone, c.name, c.customer_id, c.member_level,
              c.bound_store_id, s.store_name
       FROM client_wechat_users c
       LEFT JOIN stores s ON s.store_id = c.bound_store_id
       WHERE c.bound_store_id = $1${typeFilter}
       LIMIT $2`,
      [ctx.auth.effectiveStoreId, limit],
    );
  }

  const results = rows.map((r) => ({
    id: r.customer_id || null,
    clientUserId: r.user_id,
    customerNo: r.customer_id || null,
    name: r.name ? r.name.trim() : "",
    phone: isManagerRole ? (r.phone || "") : maskPhone(r.phone),
    phoneMasked: maskPhone(r.phone),
    memberLevel: r.member_level || null,
    storeName: r.store_name ? r.store_name.trim() : "",
    tier: null,
    lastServiceDate: null,
    lastPurchaseName: null,
    source: r.customer_id ? "both" : "miniprogram",
  }));

  // 补充 tier（年度消费分级）、lastServiceDate、lastPurchaseName
  const allClientUserIds = results.map(r => r.clientUserId).filter(Boolean);

  if (allClientUserIds.length > 0) {
    // 年度消费总额 → tier
    const yearStart = new Date().getFullYear() + '-01-01';
    const spendRows = await pg.query(`
      SELECT o.client_user_id,
             COALESCE(SUM(o.total_amount::numeric), 0) AS annual_spend
      FROM sale_orders o
      WHERE o.client_user_id = ANY($1)
        AND o.status = '已支付'
        AND o.paid_at >= $2::date
      GROUP BY o.client_user_id
    `, [allClientUserIds, yearStart]);
    const spendMap = {};
    for (const r of spendRows) {
      const amt = Number(r.annual_spend);
      spendMap[r.client_user_id] = amt >= 20000 ? 'diamond' : amt >= 5000 ? 'iron' : amt > 0 ? 'fan' : null;
    }

    // 最近服务日期
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

    // 最近购买商品名
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
        item.tier = spendMap[item.clientUserId] || null;
        item.lastServiceDate = svcDateMap[item.clientUserId] || null;
        item.lastPurchaseName = lastPurchaseMap[item.clientUserId] || null;
      }
    }
  }

  ctx.result = results;
}

/**
 * 顾客消费日历
 */
async function calendar(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const { clientUserId, clientPhone, year, month } = ctx.event.payload || {};

  if (!clientUserId && !clientPhone) {
    throw new Error("INVALID_PARAMS: 缺少 clientUserId 或 clientPhone");
  }

  if (!year || !month) {
    throw new Error("INVALID_PARAMS: 缺少 year 或 month");
  }

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

  // Store scope filter
  const calScope = buildStoreScopeCondition(ctx.auth, 'o.store_id', params.length + 1)
  whereClause += ` AND ${calScope.sql}`
  params.push(...calScope.params)

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

/**
 * 顾客档案详情（PG 单源）
 */
async function detail(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const { id, phone: queryPhone, clientUserId: queryClientUserId } = ctx.event.payload || {};
  if (!id && !queryPhone && !queryClientUserId) {
    throw new Error("INVALID_PARAMS: 缺少 id、phone 或 clientUserId 参数");
  }

  const isManagerRole = ctx.auth.roles.includes("manager");

  const selectCols = `c.user_id, c.phone, c.name, c.customer_id, c.member_level,
    c.bound_employee_id, c.skin_type, c.improvement_focus, c.gender, c.notes,
    c.bound_store_id, s.store_name`;

  const fromClause = `FROM client_wechat_users c
    LEFT JOIN stores s ON s.store_id = c.bound_store_id`;

  // 按优先级依次查找：customer_id → user_id → phone
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

  // Scope check: customer must belong to a store within current employee's scope
  if (pgUser.bound_store_id && !isStoreInScope(ctx.auth, pgUser.bound_store_id)) {
    throw new Error('PERMISSION_DENIED: 顾客不在当前门店范围内')
  }

  const phone = pgUser.phone || "";

  // 姓名回退：client_wechat_users.name → sale_orders.customer_name
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

  // 指定美容师名称
  let preferredStaffName = null;
  if (pgUser.bound_employee_id) {
    const staffRows = await pg.query(
      "SELECT name FROM staff_wechat_users WHERE employee_id = $1",
      [pgUser.bound_employee_id],
    );
    if (staffRows.length > 0) preferredStaffName = staffRows[0].name || null;
  }

  const { totalConsumption, yearConsumption } = await getConsumptionStats(pgUser.user_id);

  // 到店信息（上次到店 + 到店频率 + 常购商品），并行查询
  const clientUserId = pgUser.user_id;
  const [visitInfo, purchaseInfo, legacyCountRow] = await Promise.all([
    getVisitInfo(clientUserId),
    getTopProduct(clientUserId),
    // 历史订单待核对数（按 phone 匹配；未绑定 client_user_id 的 legacy 行也算）
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
    phone: isManagerRole ? phone : maskPhone(phone),
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

/**
 * 到店信息（上次到店日期 + 到店频率）
 * 频率基于近 90 天内的服务单去重天数计算
 */
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

/**
 * 常购商品（购买次数最多的商品名称）
 */
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

/**
 * 查询消费统计（单次查询同时计算累计 + 年度）
 */
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

/**
 * 顾客已支付订单（含明细）
 */
async function paidOrders(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const { clientUserId, clientPhone } = ctx.event.payload || {};
  if (!clientUserId && !clientPhone) {
    throw new Error("INVALID_PARAMS: 缺少 clientUserId 或 clientPhone");
  }

  // scope 守卫：传 clientUserId 时校验该顾客 bound_store_id ∈ 当前 scope
  if (clientUserId) {
    await assertCustomerInScope(pg, ctx.auth, clientUserId)
  }

  // 强制按 scope 过滤：员工只能看到顾客在 scope 内购买的订单/卡，跨 scope 卡不可见
  let whereClause, params;
  if (clientUserId) {
    whereClause = "o.status = '已支付' AND o.client_user_id = $1";
    params = [clientUserId];
  } else {
    whereClause = "o.status = '已支付' AND o.client_phone = $1";
    params = [clientPhone];
  }
  const paidScope = buildStoreScopeCondition(ctx.auth, 'o.store_id', params.length + 1)
  whereClause += ` AND ${paidScope.sql}`
  params.push(...paidScope.params)

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
      si.sku_spec_name,
      si.product_name
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
      storeId: item.store_id,
      itemName: item.product_name || "",
      spec: item.sku_spec_name || "",
      sessionCount: item.session_count,
      remainingSessions: item.remaining_sessions,
      totalSessions: item.session_count,
      paidSessions: item.paid_sessions,
      productType: item.product_type || "",
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

/**
 * 顾客分类统计（基于最近服务日期 + 生日）
 * 返回各状态的顾客数量
 */
async function stats(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const currentMonth = now.getMonth() + 1
  const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1

  // scope 过滤：兼容门店模式(单一)+管理层模式(多门店)
  const cScope = buildStoreScopeCondition(ctx.auth, 'c.bound_store_id', 1)
  const soScope = buildStoreScopeCondition(ctx.auth, 'so.store_id', 1 + cScope.params.length)
  const rows = await pg.query(`
    SELECT
      c.user_id,
      c.birthday,
      MAX(so.service_date) AS last_service_date
    FROM client_wechat_users c
    LEFT JOIN service_orders so
      ON so.client_user_id = c.user_id
      AND so.status = '已完成'
      AND ${soScope.sql}
    WHERE ${cScope.sql}
    GROUP BY c.user_id, c.birthday
  `, [...cScope.params, ...soScope.params])

  let active = 0, atRisk = 0, lost = 0, sleeping = 0, birthday = 0, birthdayNext = 0

  for (const r of rows) {
    // 活跃度分类
    if (r.last_service_date) {
      const diffDays = Math.floor((new Date(today) - new Date(r.last_service_date)) / 86400000)
      if (diffDays <= 30) active++
      else if (diffDays <= 60) atRisk++
      else if (diffDays <= 90) lost++
      else sleeping++
    } else {
      sleeping++
    }
    // 生日
    if (r.birthday) {
      const bMonth = new Date(r.birthday).getMonth() + 1
      if (bMonth === currentMonth) birthday++
      if (bMonth === nextMonth) birthdayNext++
    }
  }

  // 会员客/流量客统计
  const memberScope = buildStoreScopeCondition(ctx.auth, 'bound_store_id', 1)
  const memberRows = await pg.query(`
    SELECT COUNT(*) AS cnt FROM client_wechat_users
    WHERE ${memberScope.sql} AND customer_id IS NOT NULL
  `, memberScope.params)
  const memberCount = Number(memberRows[0].cnt)

  ctx.result = {
    active, atRisk, lost, sleeping, birthday, birthdayNext,
    total: rows.length,
    memberCount,
    flowCount: rows.length - memberCount,
  }
}

/**
 * 按标签筛选顾客列表
 * tag: active | atRisk | lost | sleeping | birthday | birthdayNext
 */
async function listByTag(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { tag, page = 1, pageSize = 20 } = ctx.event.payload || {}
  if (!tag) {
    throw new Error('INVALID_PARAMS: 缺少 tag 参数')
  }

  const isManagerRole = ctx.auth.roles.includes('manager')
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const currentMonth = now.getMonth() + 1
  const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1

  // 查询所有绑定本店的顾客及其最近服务日期 + 年消费金额（兼容门店/管理层 scope）
  const yearStart = new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10)
  const cScope = buildStoreScopeCondition(ctx.auth, 'c.bound_store_id', 1)
  const soScope = buildStoreScopeCondition(ctx.auth, 'so.store_id', 1 + cScope.params.length)
  const yearStartIdx = 1 + cScope.params.length + soScope.params.length
  const allRows = await pg.query(`
    SELECT
      c.user_id, c.name, c.phone, c.birthday, c.member_level,
      MAX(so.service_date) AS last_service_date,
      COALESCE(annual.year_total, 0) AS year_consumption
    FROM client_wechat_users c
    LEFT JOIN service_orders so
      ON so.client_user_id = c.user_id
      AND so.status = '已完成'
      AND ${soScope.sql}
    LEFT JOIN (
      SELECT o.client_user_id, SUM(si.received::numeric) AS year_total
      FROM sale_orders o
      JOIN sale_items si ON si.sale_order_id = o.sale_order_id
      WHERE o.status = '已支付' AND o.paid_at >= $${yearStartIdx}::date
      GROUP BY o.client_user_id
    ) annual ON annual.client_user_id = c.user_id
    WHERE ${cScope.sql}
    GROUP BY c.user_id, c.name, c.phone, c.birthday, c.member_level, annual.year_total
  `, [...cScope.params, ...soScope.params, yearStart])

  // 按 tag 过滤
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

  // 分页
  const offset = (page - 1) * pageSize
  const paged = filtered.slice(offset, offset + pageSize)

  // 最近购买商品名（仅查分页后的用户，减少查询量）
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
      const yearTotal = Number(r.year_consumption) || 0
      return {
        id: null,
        clientUserId: r.user_id,
        name: r.name || '',
        phone: isManagerRole ? (r.phone || '') : maskPhone(r.phone),
        phoneMasked: maskPhone(r.phone),
        memberLevel: r.member_level,
        lastServiceDate: r.last_service_date,
        lastPurchaseName: lastPurchaseMap[r.user_id] || null,
        birthday: r.birthday,
        tier: yearTotal >= 20000 ? 'diamond' : yearTotal >= 5000 ? 'iron' : yearTotal > 0 ? 'fan' : null,
        source: 'miniprogram',
      }
    })
  }
}

/**
 * 退换记录
 *
 * 数据源 = sale_order_payments[change_type='退款'] + 转换单
 *   退款：从 sale_order_payments[change_type='退款']（refund_reason / audit_* / note 已合并到主表）
 *   转换：保留原 sale_orders[sale_order_type='转换单'] 路径
 *
 * scope：staff 端必须加 store_id 过滤（audit-CC3 P0-CC3-02）
 */
async function refundHistory(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { clientUserId, clientPhone, page = 1, pageSize = 50 } = ctx.event.payload || {}
  if (!clientUserId && !clientPhone) throw new Error('INVALID_PARAMS: 缺少 clientUserId 或 clientPhone')

  // 退款流水（来自 sale_order_payments）+ store_id scope
  let refundParams, refundClientWhere
  if (clientUserId) {
    refundClientWhere = 'so.client_user_id = $1'
    refundParams = [clientUserId]
  } else {
    refundClientWhere = 'so.client_phone = $1'
    refundParams = [clientPhone]
  }
  let refundWhere = refundClientWhere
  // Store scope filter
  const refundScope = buildStoreScopeCondition(ctx.auth, 'so.store_id', refundParams.length + 1)
  refundWhere += ` AND ${refundScope.sql}`
  refundParams.push(...refundScope.params)
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

  // 转换单（仍保留 sale_orders 路径）+ store_id scope
  let convParams, convClientWhere
  if (clientUserId) {
    convClientWhere = 'o.client_user_id = $1'
    convParams = [clientUserId]
  } else {
    convClientWhere = 'o.client_phone = $1'
    convParams = [clientPhone]
  }
  let convWhere = convClientWhere
  // Store scope filter
  const convScope = buildStoreScopeCondition(ctx.auth, 'o.store_id', convParams.length + 1)
  convWhere += ` AND ${convScope.sql}`
  convParams.push(...convScope.params)
  const convRows = await pg.query(`
    SELECT o.sale_order_id, o.status, o.sale_order_type, o.total_amount,
           o.created_at, o.paid_at
    FROM sale_orders o
    WHERE ${convWhere}
      AND o.sale_order_type = '转换单'
    ORDER BY o.created_at DESC
  `, convParams)

  // 转换单的明细
  const convOrderIds = convRows.map(o => o.sale_order_id)
  let convItems = []
  if (convOrderIds.length > 0) {
    convItems = await pg.query(
      `SELECT si.sale_order_id, si.sale_item_id, si.item_direction,
              si.product_name, si.sku_spec_name, si.quantity, si.received
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
      specName: i.sku_spec_name,
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
      saleOrderId: r.sale_order_id,    // 此处指向"原销售单"
      type: '退款',
      status: r.status,
      totalAmount: Number(r.amount),    // 已含负号
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

  // 合并 + 按时间倒序（与历史返回结构兼容：扁平数组）
  ctx.result = [...refunds, ...conversions].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )
}

/**
 * 赠送记录（套餐内赠品 + 组合套餐）
 * 逻辑：从已支付订单中提取 received=0 或 is_bundle_sku=true+price=0 的明细行
 *       以及原组合套餐类型的订单（已合并为销售单）
 */
async function giftHistory(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { clientUserId, clientPhone } = ctx.event.payload || {}
  if (!clientUserId && !clientPhone) throw new Error('INVALID_PARAMS: 缺少 clientUserId 或 clientPhone')

  let whereClause, params
  if (clientUserId) {
    whereClause = "o.client_user_id = $1"
    params = [clientUserId]
  } else {
    whereClause = "o.client_phone = $1"
    params = [clientPhone]
  }

  // Store scope filter
  const giftScope = buildStoreScopeCondition(ctx.auth, 'o.store_id', params.length + 1)
  whereClause += ` AND ${giftScope.sql}`
  params.push(...giftScope.params)

  // 组合套餐订单（整单视为赠送/活动）
  const promoOrders = await pg.query(`
    SELECT o.sale_order_id, o.status, o.sale_order_type, o.total_amount,
           o.created_at, o.paid_at
    FROM sale_orders o
    WHERE ${whereClause}
      AND FALSE -- TODO: 组合套餐已合并为销售单，需另行标记
      AND o.status IN ('已支付', '已完成')
    ORDER BY o.created_at DESC
  `, params)

  // 套餐内赠品（received=0 的明细行，排除组合套餐）
  const giftItems = await pg.query(`
    SELECT si.sale_item_id, si.sale_order_id, si.product_name, si.sku_spec_name,
           si.quantity, si.session_count, si.remaining_sessions, si.paid_sessions,
           si.received, o.created_at, o.paid_at
    FROM sale_items si
    JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    WHERE ${whereClause}
      AND o.status IN ('已支付', '已完成')
      AND o.sale_order_type NOT IN ('内部单', '转换单', '寄存单')
      AND si.item_direction = '购买'
      AND si.received::numeric = 0
    ORDER BY o.created_at DESC
  `, params)

  // 组合套餐订单的明细
  const promoOrderIds = promoOrders.map(o => o.sale_order_id)
  let promoItems = []
  if (promoOrderIds.length > 0) {
    promoItems = await pg.query(
      `SELECT si.sale_order_id, si.sale_item_id, si.product_name, si.sku_spec_name,
              si.quantity, si.session_count, si.remaining_sessions, si.paid_sessions, si.received
       FROM sale_items si WHERE si.sale_order_id = ANY($1) ORDER BY si.sale_item_id`,
      [promoOrderIds]
    )
  }

  const promoItemsByOrder = {}
  for (const i of promoItems) {
    if (!promoItemsByOrder[i.sale_order_id]) promoItemsByOrder[i.sale_order_id] = []
    promoItemsByOrder[i.sale_order_id].push({
      productName: i.product_name,
      specName: i.sku_spec_name,
      quantity: i.quantity,
      sessionCount: i.session_count,
      remainingSessions: i.remaining_sessions,
      paidSessions: i.paid_sessions,
    })
  }

  ctx.result = {
    promoOrders: promoOrders.map(o => ({
      saleOrderId: o.sale_order_id,
      type: o.sale_order_type,
      status: o.status,
      totalAmount: Number(o.total_amount),
      createdAt: o.created_at,
      paidAt: o.paid_at,
      items: promoItemsByOrder[o.sale_order_id] || [],
    })),
    giftItems: giftItems.map(i => ({
      saleItemId: i.sale_item_id,
      saleOrderId: i.sale_order_id,
      productName: i.product_name,
      specName: i.sku_spec_name,
      quantity: i.quantity,
      sessionCount: i.session_count,
      remainingSessions: i.remaining_sessions,
      paidSessions: i.paid_sessions,
      createdAt: i.created_at,
    })),
  }
}

/**
 * 更新顾客备注
 */
async function updateNotes(ctx) {
  await requireManager()(ctx, async () => {})

  const { clientUserId, notes } = ctx.event.payload || {}
  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')
  if (typeof notes !== 'string') throw new Error('INVALID_PARAMS: notes 必须为字符串')

  const trimmed = notes.trim().slice(0, 500)

  // scope 守卫：assertCustomerInScope 校验顾客存在 + bound_store_id ∈ 当前 scope
  // （store 模式 = effectiveStoreId；management 模式 = scopeStoreIds）
  await assertCustomerInScope(pg, ctx.auth, clientUserId)

  await pg.query(
    'UPDATE client_wechat_users SET notes = $1, updated_at = NOW() WHERE user_id = $2',
    [trimmed || null, clientUserId]
  )

  // Audit log
  await pg.query(
    `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    ['customer.updateNotes', 'client_wechat_users', clientUserId,
     JSON.stringify({ notesLength: trimmed ? trimmed.length : 0 }), 'staffApi']
  )

  ctx.result = { message: '备注已保存' }
}

/**
 * 查询顾客储值卡余额（店长专用，跨店共享）
 * payload: { customerUserId: string }
 * 返回: { cardId: string|null, balance: number }
 */
async function customerBalance(ctx) {
  await requireManager()(ctx, async () => {})

  const { customerUserId } = ctx.event.payload || {}
  if (!customerUserId) {
    throw new Error('INVALID_PARAMS: 缺少 customerUserId')
  }

  // scope 守卫：店长只能查 scope 内顾客余额（prepaid_cards 跨店共享，无 store_id 列）
  await assertCustomerInScope(pg, ctx.auth, customerUserId)

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

/**
 * 客户分配（店长将顾客分配给美容师）
 */
async function assign(ctx) {
  await requireManager()(ctx, async () => {})

  const { clientUserId, employeeId } = ctx.event.payload || {}
  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')
  if (!employeeId) throw new Error('INVALID_PARAMS: 缺少 employeeId')

  // scope 守卫：顾客与员工都必须 ∈ 当前 scope
  await assertCustomerInScope(pg, ctx.auth, clientUserId)
  await assertEmployeeInScope(pg, ctx.auth, employeeId)

  const staffRows = await pg.query(
    'SELECT name FROM staff_wechat_users WHERE employee_id = $1',
    [employeeId]
  )
  if (staffRows.length === 0) {
    throw new Error('INVALID_PARAMS: 员工不存在')
  }

  await pg.query(
    'UPDATE client_wechat_users SET bound_employee_id = $1, updated_at = NOW() WHERE user_id = $2',
    [employeeId, clientUserId]
  )

  // Audit log
  await pg.query(
    `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    ['customer.assign', 'client_wechat_users', clientUserId,
     JSON.stringify({ employeeId, employeeName: staffRows[0].name }), 'staffApi']
  )

  ctx.result = {
    message: '分配成功',
    employeeName: staffRows[0].name,
  }
}

module.exports = { search, calendar, detail, paidOrders, stats, listByTag, refundHistory, giftHistory, updateNotes, assign, customerBalance };
