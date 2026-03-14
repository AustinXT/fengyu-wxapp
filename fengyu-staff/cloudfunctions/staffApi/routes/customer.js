/**
 * 顾客档案模块路由（员工端）
 * customer.search — 搜索顾客（双源并集：WorkFine + PG）
 * customer.calendar — 顾客消费日历
 * customer.detail — 顾客档案详情（支持 PG-only 顾客）
 * customer.paidOrders — 顾客已支付订单（含明细）
 */

const pg = require("../db/pg");
const mssql = require("../db/mssql");
const { requireStaffBound } = require("../middleware/auth");

/**
 * 搜索顾客（双源并集）
 * 数据来源 = WorkFine UDT_S_311 ∪ PG client_wechat_users，手机号去重
 */
async function search(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const { keyword, phone } = ctx.event.payload || {};

  const esc = (v) => String(v).replace(/'/g, "''");
  const isManagerRole = ctx.auth.roles.includes("manager");

  // Step 1: 查 WorkFine UDT_S_311
  let searchCondition;
  let limit = 20;
  if (phone) {
    searchCondition = `UDF_S_1478 = '${esc(phone.trim())}'`;
    limit = 1;
  } else if (keyword && keyword.trim()) {
    const k = esc(keyword.trim());
    searchCondition = `(UDF_S_1476 LIKE '%${k}%' OR UDF_S_1478 LIKE '%${k}%') AND UDF_S_6443 = '${esc(ctx.auth.storeName)}'`;
  } else {
    searchCondition = `UDF_S_6443 = '${esc(ctx.auth.storeName)}'`;
  }

  const customerRows = await mssql.query(`
    SELECT TOP ${limit}
      UDF_S_1475 AS customer_id,
      UDF_S_1476 AS name,
      UDF_S_1478 AS phone,
      UDF_S_1477 AS member_level,
      UDF_S_6443 AS store_name,
      UDF_S_6444 AS main_staff_id,
      UDF_S_1474 AS register_date
    FROM UDT_S_311
    WHERE ${searchCondition}
    ORDER BY UDF_S_1474 DESC
  `);

  // Step 2: 查 PG client_wechat_users
  let pgUsers = [];
  if (phone) {
    pgUsers = await pg.query("SELECT user_id, phone, name, bound_store_id FROM client_wechat_users WHERE phone = $1", [
      phone.trim(),
    ]);
  } else if (keyword && keyword.trim()) {
    pgUsers = await pg.query(
      "SELECT user_id, phone, name, bound_store_id FROM client_wechat_users WHERE (phone LIKE $1 OR name LIKE $1) AND bound_store_id = $2 LIMIT $3",
      [`%${keyword.trim()}%`, ctx.auth.storeId, limit],
    );
  } else {
    pgUsers = await pg.query(
      "SELECT user_id, phone, name, bound_store_id FROM client_wechat_users WHERE bound_store_id = $1 LIMIT $2",
      [ctx.auth.storeId, limit],
    );
  }

  // 构建 PG clientUserId 映射
  const pgUserMap = {};
  for (const u of pgUsers) {
    if (u.phone) pgUserMap[u.phone] = u.user_id;
  }

  // Step 3: 用 WorkFine phones 集合去重
  const wfPhones = new Set(customerRows.map((r) => (r.phone || "").trim()).filter(Boolean));
  const pgOnlyUsers = pgUsers.filter((u) => u.phone && !wfPhones.has(u.phone));

  // Step 4: PG-only 顾客姓名（client_wechat_users.name 或 sale_orders.customer_name）
  const pgNameMap = {};
  if (pgOnlyUsers.length > 0) {
    for (const u of pgOnlyUsers) {
      if (u.name) {
        pgNameMap[u.phone] = u.name;
      }
    }
    const phonesWithoutName = pgOnlyUsers.filter((u) => !u.name).map((u) => u.phone);
    if (phonesWithoutName.length > 0) {
      const nameRows = await pg.query(
        `SELECT DISTINCT ON (client_phone) client_phone, customer_name
         FROM sale_orders WHERE client_phone = ANY($1)
         ORDER BY client_phone, created_at DESC`,
        [phonesWithoutName],
      );
      for (const r of nameRows) {
        if (!pgNameMap[r.client_phone]) pgNameMap[r.client_phone] = r.customer_name;
      }
    }
  }

  // Step 5: 合并结果
  const wfResults = customerRows.map((r) => {
    const p = (r.phone || "").trim();
    const clientUserId = pgUserMap[p] || null;
    return {
      id: r.customer_id,
      clientUserId,
      customerNo: r.customer_id,
      name: r.name ? r.name.trim() : "",
      phone: isManagerRole ? r.phone || "" : maskPhone(r.phone),
      phoneMasked: maskPhone(r.phone),
      memberLevel: r.member_level,
      storeName: r.store_name ? r.store_name.trim() : "",
      mainStaffId: r.main_staff_id,
      registerDate: r.register_date,
      source: clientUserId ? "both" : "workfine",
    };
  });

  const pgOnlyResults = pgOnlyUsers.map((u) => ({
    id: null,
    clientUserId: u.user_id,
    customerNo: null,
    name: pgNameMap[u.phone] || u.name || "",
    phone: isManagerRole ? u.phone : maskPhone(u.phone),
    phoneMasked: maskPhone(u.phone),
    memberLevel: null,
    storeName: "",
    mainStaffId: null,
    registerDate: null,
    source: "miniprogram",
  }));

  // Step 6: 补充 tier（年度消费分级）和 lastServiceDate
  const allResults = [...wfResults, ...pgOnlyResults];
  const allClientUserIds = allResults.map(r => r.clientUserId).filter(Boolean);

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

    for (const item of allResults) {
      if (item.clientUserId) {
        item.tier = spendMap[item.clientUserId] || null;
        item.lastServiceDate = svcDateMap[item.clientUserId] || null;
      }
    }
  }

  ctx.result = allResults;
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
 * 顾客档案详情（支持双源）
 */
async function detail(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const { id, phone: queryPhone, clientUserId: queryClientUserId } = ctx.event.payload || {};
  if (!id && !queryPhone && !queryClientUserId) {
    throw new Error("INVALID_PARAMS: 缺少 id、phone 或 clientUserId 参数");
  }

  const esc = (v) => String(v).replace(/'/g, "''");
  const isManagerRole = ctx.auth.roles.includes("manager");

  let resolvedPhone = queryPhone;
  let resolvedClientUserId = queryClientUserId;
  if (!id && !queryPhone && queryClientUserId) {
    const pgRows = await pg.query(
      "SELECT user_id, phone, name, bound_store_id FROM client_wechat_users WHERE user_id = $1 LIMIT 1",
      [queryClientUserId],
    );
    if (pgRows.length === 0) {
      throw new Error("INVALID_PARAMS: 顾客不存在");
    }
    resolvedPhone = pgRows[0].phone;
  }

  // 尝试从 WorkFine 查询
  let customerRows = [];
  if (id) {
    customerRows = await mssql.query(`
      SELECT TOP 1
        UDF_S_1475 AS customer_id,
        UDF_S_1476 AS name,
        UDF_S_1478 AS phone,
        UDF_S_1477 AS member_level,
        UDF_S_6443 AS store_name,
        UDF_S_6444 AS main_staff_id
      FROM UDT_S_311
      WHERE UDF_S_1475 = '${esc(id)}'
    `);
  } else if (resolvedPhone) {
    customerRows = await mssql.query(`
      SELECT TOP 1
        UDF_S_1475 AS customer_id,
        UDF_S_1476 AS name,
        UDF_S_1478 AS phone,
        UDF_S_1477 AS member_level,
        UDF_S_6443 AS store_name,
        UDF_S_6444 AS main_staff_id
      FROM UDT_S_311
      WHERE UDF_S_1478 = '${esc(resolvedPhone.trim())}'
    `);
  }

  if (customerRows.length > 0) {
    const c = customerRows[0];
    const phone = c.phone || "";

    let clientUserId = resolvedClientUserId || null;
    if (!clientUserId && phone) {
      const clientUsers = await pg.query("SELECT user_id FROM client_wechat_users WHERE phone = $1 LIMIT 1", [phone]);
      if (clientUsers.length > 0) clientUserId = clientUsers[0].user_id;
    }

    // 查指定美容师名称（从 PG）
    let preferredStaffName = null;
    if (c.main_staff_id) {
      const staffRows = await pg.query(
        "SELECT name FROM staff_wechat_users WHERE employee_id = $1",
        [c.main_staff_id],
      );
      if (staffRows.length > 0) {
        preferredStaffName = staffRows[0].name || null;
      }
    }

    const { totalConsumption, yearConsumption } = await getConsumptionStats(clientUserId, phone);

    ctx.result = {
      id: c.customer_id,
      clientUserId,
      name: c.name ? c.name.trim() : "",
      phone: isManagerRole ? phone : maskPhone(phone),
      phoneMasked: maskPhone(phone),
      memberLevel: c.member_level,
      preferredStaffName,
      skinType: null,
      focusAreas: null,
      totalConsumption,
      yearConsumption,
      source: clientUserId ? "both" : "workfine",
    };
    return;
  }

  // WorkFine 无记录 → 查 PG
  let pgUser = null;
  if (resolvedPhone && queryClientUserId) {
    pgUser = { user_id: queryClientUserId, phone: resolvedPhone };
  } else {
    const phone = resolvedPhone ? resolvedPhone.trim() : "";
    if (!phone) {
      throw new Error("INVALID_PARAMS: 顾客不存在");
    }
    const pgUsers = await pg.query(
      "SELECT user_id, phone, name, bound_store_id FROM client_wechat_users WHERE phone = $1 LIMIT 1",
      [phone],
    );
    if (pgUsers.length === 0) {
      throw new Error("INVALID_PARAMS: 顾客不存在");
    }
    pgUser = pgUsers[0];
  }

  const phone = pgUser.phone || "";

  // 从 client_wechat_users 或 sale_orders 获取姓名
  let name = pgUser.name || "";
  if (!name) {
    const nameRows = await pg.query(
      `SELECT customer_name FROM sale_orders
       WHERE client_phone = $1 AND customer_name IS NOT NULL AND customer_name != ''
       ORDER BY created_at DESC LIMIT 1`,
      [phone],
    );
    if (nameRows.length > 0) name = nameRows[0].customer_name;
  }

  const { totalConsumption, yearConsumption } = await getConsumptionStats(pgUser.user_id, phone);

  ctx.result = {
    id: null,
    clientUserId: pgUser.user_id,
    name,
    phone: isManagerRole ? phone : maskPhone(phone),
    phoneMasked: maskPhone(phone),
    memberLevel: null,
    preferredStaffName: null,
    skinType: null,
    focusAreas: null,
    totalConsumption,
    yearConsumption,
    source: "miniprogram",
  };
}

/**
 * 查询消费统计
 */
async function getConsumptionStats(clientUserId, phone) {
  let totalConsumption = 0;
  let yearConsumption = 0;

  if (clientUserId) {
    const totalRows = await pg.query(
      `SELECT COALESCE(SUM(si.received::numeric), 0) AS total
       FROM sale_orders o JOIN sale_items si ON o.sale_order_id = si.sale_order_id
       WHERE o.status = '已支付' AND o.client_user_id = $1`,
      [clientUserId],
    );
    totalConsumption = Number(totalRows[0].total);

    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const yearRows = await pg.query(
      `SELECT COALESCE(SUM(si.received::numeric), 0) AS total
       FROM sale_orders o JOIN sale_items si ON o.sale_order_id = si.sale_order_id
       WHERE o.status = '已支付' AND o.client_user_id = $1 AND o.paid_at >= $2`,
      [clientUserId, yearStart],
    );
    yearConsumption = Number(yearRows[0].total);
  } else if (phone) {
    const totalRows = await pg.query(
      `SELECT COALESCE(SUM(si.received::numeric), 0) AS total
       FROM sale_orders o JOIN sale_items si ON o.sale_order_id = si.sale_order_id
       WHERE o.status = '已支付' AND o.client_phone = $1`,
      [phone],
    );
    totalConsumption = Number(totalRows[0].total);

    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const yearRows = await pg.query(
      `SELECT COALESCE(SUM(si.received::numeric), 0) AS total
       FROM sale_orders o JOIN sale_items si ON o.sale_order_id = si.sale_order_id
       WHERE o.status = '已支付' AND o.client_phone = $1 AND o.paid_at >= $2`,
      [phone, yearStart],
    );
    yearConsumption = Number(yearRows[0].total);
  }

  return { totalConsumption, yearConsumption };
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

  let whereClause, params;
  if (clientUserId) {
    whereClause = "o.status = '已支付' AND o.client_user_id = $1";
    params = [clientUserId];
  } else {
    whereClause = "o.status = '已支付' AND o.client_phone = $1";
    params = [clientPhone];
  }

  const orders = await pg.query(
    `SELECT o.sale_order_id, o.status, o.paid_at
     FROM sale_orders o
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
      si.session_count,
      si.remaining_sessions,
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
      itemName: item.product_name || "",
      spec: item.sku_spec_name || "",
      sessionCount: item.session_count,
      remainingSessions: item.remaining_sessions,
      totalSessions: item.session_count,
      productType: item.product_type || "",
    });
  }

  ctx.result = orders.map((o) => ({
    orderId: o.sale_order_id,
    saleOrderId: o.sale_order_id,
    status: o.status,
    paidAt: o.paid_at,
    items: itemsByOrder[o.sale_order_id] || [],
  }));
}

/**
 * 手机号脱敏
 */
function maskPhone(phone) {
  if (!phone) return "";
  const p = String(phone).trim();
  if (p.length <= 4) return "****";
  return "*".repeat(p.length - 4) + p.slice(-4);
}

/**
 * 顾客分类统计（基于最近服务日期 + 生日）
 * 返回各状态的顾客数量
 */
async function stats(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const storeId = ctx.auth.storeId
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const currentMonth = now.getMonth() + 1
  const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1

  // 查询所有绑定到本店的顾客及其最近服务日期
  const rows = await pg.query(`
    SELECT
      c.user_id,
      c.birthday,
      MAX(so.service_date) AS last_service_date
    FROM client_wechat_users c
    LEFT JOIN service_orders so
      ON so.client_user_id = c.user_id
      AND so.status = '已完成'
      AND so.store_id = $1
    WHERE c.bound_store_id = $1
    GROUP BY c.user_id, c.birthday
  `, [storeId])

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
  const memberRows = await pg.query(`
    SELECT COUNT(*) AS cnt FROM client_wechat_users
    WHERE bound_store_id = $1 AND customer_id IS NOT NULL
  `, [storeId])
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

  const storeId = ctx.auth.storeId
  const isManagerRole = ctx.auth.roles.includes('manager')
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const currentMonth = now.getMonth() + 1
  const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1

  // 查询所有绑定本店的顾客及其最近服务日期 + 年消费金额
  const yearStart = new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10)
  const allRows = await pg.query(`
    SELECT
      c.user_id, c.name, c.phone, c.birthday, c.member_level,
      MAX(so.service_date) AS last_service_date,
      COALESCE(annual.year_total, 0) AS year_consumption
    FROM client_wechat_users c
    LEFT JOIN service_orders so
      ON so.client_user_id = c.user_id
      AND so.status = '已完成'
      AND so.store_id = $1
    LEFT JOIN (
      SELECT o.client_user_id, SUM(si.received::numeric) AS year_total
      FROM sale_orders o
      JOIN sale_items si ON si.sale_order_id = o.sale_order_id
      WHERE o.status = '已支付' AND o.paid_at >= $2::date
      GROUP BY o.client_user_id
    ) annual ON annual.client_user_id = c.user_id
    WHERE c.bound_store_id = $1
    GROUP BY c.user_id, c.name, c.phone, c.birthday, c.member_level, annual.year_total
  `, [storeId, yearStart])

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
        birthday: r.birthday,
        tier: yearTotal >= 20000 ? 'diamond' : yearTotal >= 5000 ? 'iron' : yearTotal > 0 ? 'fan' : null,
        source: 'miniprogram',
      }
    })
  }
}

/**
 * 退换记录（退款单 + 转换单）
 */
async function refundHistory(ctx) {
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

  const orders = await pg.query(`
    SELECT o.sale_order_id, o.status, o.sale_order_type, o.total_amount,
           o.refund_reason, o.handling_fee, o.ref_sale_order_id,
           o.approved_by, o.approved_at, o.rejected_reason,
           o.created_at, o.paid_at
    FROM sale_orders o
    WHERE ${whereClause}
      AND o.sale_order_type IN ('退款', '转换')
    ORDER BY o.created_at DESC
  `, params)

  if (orders.length === 0) {
    ctx.result = []
    return
  }

  const orderIds = orders.map(o => o.sale_order_id)
  const items = await pg.query(
    `SELECT si.sale_order_id, si.sale_item_id, si.item_direction,
            si.product_name, si.sku_spec_name, si.quantity, si.received
     FROM sale_items si WHERE si.sale_order_id = ANY($1) ORDER BY si.sale_item_id`,
    [orderIds]
  )

  const itemsByOrder = {}
  for (const i of items) {
    if (!itemsByOrder[i.sale_order_id]) itemsByOrder[i.sale_order_id] = []
    itemsByOrder[i.sale_order_id].push({
      saleItemId: i.sale_item_id,
      direction: i.item_direction,
      productName: i.product_name,
      specName: i.sku_spec_name,
      quantity: i.quantity,
      received: Number(i.received),
    })
  }

  ctx.result = orders.map(o => ({
    saleOrderId: o.sale_order_id,
    type: o.sale_order_type,
    status: o.status,
    totalAmount: Number(o.total_amount),
    refundReason: o.refund_reason,
    handlingFee: o.handling_fee ? Number(o.handling_fee) : null,
    refOrderId: o.ref_sale_order_id,
    createdAt: o.created_at,
    paidAt: o.paid_at,
    approvedAt: o.approved_at,
    rejectedReason: o.rejected_reason,
    items: itemsByOrder[o.sale_order_id] || [],
  }))
}

/**
 * 赠送记录（套餐内赠品 + 福利活动）
 * 逻辑：从已支付订单中提取 received=0 或 is_bundle_sku=true+price=0 的明细行
 *       以及 sale_order_type='福利活动' 的全部订单
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

  // 福利活动订单（整单视为赠送/活动）
  const promoOrders = await pg.query(`
    SELECT o.sale_order_id, o.status, o.sale_order_type, o.total_amount,
           o.created_at, o.paid_at
    FROM sale_orders o
    WHERE ${whereClause}
      AND o.sale_order_type = '福利活动'
      AND o.status IN ('已支付', '已完成')
    ORDER BY o.created_at DESC
  `, params)

  // 套餐内赠品（received=0 的明细行，排除福利活动）
  const giftItems = await pg.query(`
    SELECT si.sale_item_id, si.sale_order_id, si.product_name, si.sku_spec_name,
           si.quantity, si.session_count, si.remaining_sessions,
           si.received, o.created_at, o.paid_at
    FROM sale_items si
    JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    WHERE ${whereClause.replace('o.', 'o.')}
      AND o.status IN ('已支付', '已完成')
      AND o.sale_order_type NOT IN ('福利活动', '退款', '转换', '回款')
      AND si.item_direction = 'purchase'
      AND si.received::numeric = 0
    ORDER BY o.created_at DESC
  `, params)

  // 福利活动订单的明细
  const promoOrderIds = promoOrders.map(o => o.sale_order_id)
  let promoItems = []
  if (promoOrderIds.length > 0) {
    promoItems = await pg.query(
      `SELECT si.sale_order_id, si.sale_item_id, si.product_name, si.sku_spec_name,
              si.quantity, si.session_count, si.remaining_sessions, si.received
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
      createdAt: i.created_at,
    })),
  }
}

module.exports = { search, calendar, detail, paidOrders, stats, listByTag, refundHistory, giftHistory };
