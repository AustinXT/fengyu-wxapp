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
 * 美容师不可查看完整手机号
 *
 * 支持三种搜索模式：
 *   - phone 参数：精确匹配手机号（开单页使用）
 *   - keyword 参数：模糊搜索姓名/手机号（顾客列表使用）
 *   - 无参数：返回本门店默认顾客
 *
 * 返回平铺数组，含 id（WorkFine 顾客编号）、clientUserId（PG 用户 ID）、source 字段
 */
async function search(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const { keyword, phone } = ctx.event.payload || {};

  const esc = (v) => String(v).replace(/'/g, "''");
  const isManagerRole = ctx.auth.position === "门店经理";

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
    pgUsers = await pg.query("SELECT user_id, phone, bound_store_name FROM client_wechat_users WHERE phone = $1", [
      phone.trim(),
    ]);
  } else if (keyword && keyword.trim()) {
    pgUsers = await pg.query(
      "SELECT user_id, phone, bound_store_name FROM client_wechat_users WHERE phone LIKE $1 AND bound_store_name = $2 LIMIT $3",
      [`%${keyword.trim()}%`, ctx.auth.storeName, limit],
    );
  } else {
    pgUsers = await pg.query(
      "SELECT user_id, phone, bound_store_name FROM client_wechat_users WHERE bound_store_name = $1 LIMIT $2",
      [ctx.auth.storeName, limit],
    );
  }

  // 构建 PG clientUserId 映射（用于 WorkFine 结果补充）
  const pgUserMap = {};
  for (const u of pgUsers) {
    if (u.phone) pgUserMap[u.phone] = u.user_id;
  }

  // Step 3: 用 WorkFine phones 集合去重，找出仅存在于 PG 的顾客
  const wfPhones = new Set(customerRows.map((r) => (r.phone || "").trim()).filter(Boolean));
  const pgOnlyUsers = pgUsers.filter((u) => u.phone && !wfPhones.has(u.phone));

  // Step 4: 为 PG-only 顾客补充姓名（从 orders.customer_name 取最近的）
  const pgNameMap = {};
  if (pgOnlyUsers.length > 0) {
    const pgOnlyPhones = pgOnlyUsers.map((u) => u.phone);
    const nameRows = await pg.query(
      `
      SELECT DISTINCT ON (client_phone) client_phone, customer_name
      FROM orders WHERE client_phone = ANY($1)
      ORDER BY client_phone, created_at DESC
    `,
      [pgOnlyPhones],
    );
    for (const r of nameRows) {
      pgNameMap[r.client_phone] = r.customer_name;
    }
  }

  // Step 5: 合并结果
  // WorkFine 结果 → 附加 clientUserId + source
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

  // PG-only 结果 → 构造兼容格式
  const pgOnlyResults = pgOnlyUsers.map((u) => ({
    id: null,
    clientUserId: u.user_id,
    customerNo: null,
    name: pgNameMap[u.phone] || "",
    phone: isManagerRole ? u.phone : maskPhone(u.phone),
    phoneMasked: maskPhone(u.phone),
    memberLevel: null,
    storeName: u.bound_store_name || "",
    mainStaffId: null,
    registerDate: null,
    source: "miniprogram",
  }));

  ctx.result = [...wfResults, ...pgOnlyResults];
}

/**
 * 顾客消费日历
 * 查询 PG 数据库中该顾客已支付订单，按日期汇总金额
 *
 * 入账口径：仅 '已支付' 状态订单，按 paid_at 日期统计
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

  // 构建查询条件（按月查询）
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

  // 按日期汇总消费金额（实收金额）
  const rows = await pg.query(
    `
    SELECT
      DATE(o.paid_at AT TIME ZONE 'Asia/Shanghai') AS pay_date,
      COUNT(DISTINCT o.order_no) AS order_count,
      COALESCE(SUM(oi.received), 0) AS total_received
    FROM orders o
    INNER JOIN order_items oi ON o.order_no = oi.order_no
    WHERE ${whereClause}
    GROUP BY DATE(o.paid_at AT TIME ZONE 'Asia/Shanghai')
    ORDER BY pay_date
  `,
    params,
  );

  // 查询当月的订单详情（用于展开查看）
  const orderRows = await pg.query(
    `
    SELECT
      o.order_no,
      o.order_type,
      o.store_name,
      o.payment_method,
      o.paid_at,
      o.client_phone,
      o.customer_name,
      DATE(o.paid_at AT TIME ZONE 'Asia/Shanghai') AS pay_date,
      COALESCE((
        SELECT SUM(oi2.received)
        FROM order_items oi2
        WHERE oi2.order_no = o.order_no
      ), 0) AS total_received
    FROM orders o
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
      orderNo: r.order_no,
      orderType: r.order_type,
      storeName: r.store_name,
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
 * 优先用 id 查 WorkFine，id 为空时用 phone 查
 * 先查 WorkFine，再查 PG client_wechat_users
 * 从 PG orders 统计消费金额
 */
async function detail(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const { id, phone: queryPhone, clientUserId: queryClientUserId } = ctx.event.payload || {};
  if (!id && !queryPhone && !queryClientUserId) {
    throw new Error("INVALID_PARAMS: 缺少 id、phone 或 clientUserId 参数");
  }

  const esc = (v) => String(v).replace(/'/g, "''");
  const isManagerRole = ctx.auth.position === "门店经理";

  // 如果传了 clientUserId 但没有 id/phone，先从 PG 查出 phone 再尝试 WorkFine
  let resolvedPhone = queryPhone;
  let resolvedClientUserId = queryClientUserId;
  if (!id && !queryPhone && queryClientUserId) {
    const pgRows = await pg.query(
      "SELECT user_id, phone, bound_store_name FROM client_wechat_users WHERE user_id = $1 LIMIT 1",
      [queryClientUserId],
    );
    if (pgRows.length === 0) {
      throw new Error("INVALID_PARAMS: 顾客不存在");
    }
    resolvedPhone = pgRows[0].phone;
  }

  // 尝试从 WorkFine 查询顾客基本信息
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

  // WorkFine 有记录 → 走原有逻辑
  if (customerRows.length > 0) {
    const c = customerRows[0];
    const phone = c.phone || "";

    // 从 PG 查顾客是否已注册小程序
    let clientUserId = resolvedClientUserId || null;
    if (!clientUserId && phone) {
      const clientUsers = await pg.query("SELECT user_id FROM client_wechat_users WHERE phone = $1 LIMIT 1", [phone]);
      if (clientUsers.length > 0) clientUserId = clientUsers[0].user_id;
    }

    // 查指定美容师名称
    let preferredStaffName = null;
    if (c.main_staff_id) {
      try {
        const staffRows = await mssql.query(`
          SELECT UDF_S_1155 AS name FROM UDT_S_287
          WHERE UDF_S_1147 = '${esc(c.main_staff_id)}'
        `);
        if (staffRows.length > 0) {
          preferredStaffName = staffRows[0].name ? staffRows[0].name.trim() : null;
        }
      } catch (_) {}
    }

    // 消费统计
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

  // WorkFine 无记录 → 查 PG client_wechat_users（PG-only 顾客）
  // 如果已通过 clientUserId 查过 PG，直接用缓存的结果
  let pgUser = null;
  if (resolvedPhone && queryClientUserId) {
    // 已经从 clientUserId 查出了 phone，直接构造
    pgUser = { user_id: queryClientUserId, phone: resolvedPhone };
  } else {
    const phone = resolvedPhone ? resolvedPhone.trim() : "";
    if (!phone) {
      throw new Error("INVALID_PARAMS: 顾客不存在");
    }
    const pgUsers = await pg.query(
      "SELECT user_id, phone, bound_store_name FROM client_wechat_users WHERE phone = $1 LIMIT 1",
      [phone],
    );
    if (pgUsers.length === 0) {
      throw new Error("INVALID_PARAMS: 顾客不存在");
    }
    pgUser = pgUsers[0];
  }

  const phone = pgUser.phone || "";

  // 从 orders 获取姓名
  const nameRows = await pg.query(
    `
    SELECT customer_name FROM orders
    WHERE client_phone = $1 AND customer_name IS NOT NULL AND customer_name != ''
    ORDER BY created_at DESC LIMIT 1
  `,
    [phone],
  );
  const name = nameRows.length > 0 ? nameRows[0].customer_name : "";

  // 消费统计
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
 * 查询消费统计（累计 + 年度）
 * 优先用 clientUserId 查，否则用 phone 查
 */
async function getConsumptionStats(clientUserId, phone) {
  let totalConsumption = 0;
  let yearConsumption = 0;

  if (clientUserId) {
    const totalRows = await pg.query(
      `
      SELECT COALESCE(SUM(oi.received::numeric), 0) AS total
      FROM orders o JOIN order_items oi ON o.order_no = oi.order_no
      WHERE o.status = '已支付' AND o.client_user_id = $1
    `,
      [clientUserId],
    );
    totalConsumption = Number(totalRows[0].total);

    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const yearRows = await pg.query(
      `
      SELECT COALESCE(SUM(oi.received::numeric), 0) AS total
      FROM orders o JOIN order_items oi ON o.order_no = oi.order_no
      WHERE o.status = '已支付' AND o.client_user_id = $1 AND o.paid_at >= $2
    `,
      [clientUserId, yearStart],
    );
    yearConsumption = Number(yearRows[0].total);
  } else if (phone) {
    const totalRows = await pg.query(
      `
      SELECT COALESCE(SUM(oi.received::numeric), 0) AS total
      FROM orders o JOIN order_items oi ON o.order_no = oi.order_no
      WHERE o.status = '已支付' AND o.client_phone = $1
    `,
      [phone],
    );
    totalConsumption = Number(totalRows[0].total);

    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const yearRows = await pg.query(
      `
      SELECT COALESCE(SUM(oi.received::numeric), 0) AS total
      FROM orders o JOIN order_items oi ON o.order_no = oi.order_no
      WHERE o.status = '已支付' AND o.client_phone = $1 AND o.paid_at >= $2
    `,
      [phone, yearStart],
    );
    yearConsumption = Number(yearRows[0].total);
  }

  return { totalConsumption, yearConsumption };
}

/**
 * 顾客已支付订单（含明细）
 * 用于创建服务单时选择核销项目
 * 查询 PG orders + order_items，返回有剩余次数的订单明细
 */
async function paidOrders(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const { clientUserId, clientPhone } = ctx.event.payload || {};
  if (!clientUserId && !clientPhone) {
    throw new Error("INVALID_PARAMS: 缺少 clientUserId 或 clientPhone");
  }

  // 查询已支付订单
  let whereClause, params;
  if (clientUserId) {
    whereClause = "o.status = '已支付' AND o.client_user_id = $1";
    params = [clientUserId];
  } else {
    whereClause = "o.status = '已支付' AND o.client_phone = $1";
    params = [clientPhone];
  }

  const orders = await pg.query(
    `
    SELECT o.order_no, o.status, o.paid_at
    FROM orders o
    WHERE ${whereClause}
    ORDER BY o.paid_at DESC
  `,
    params,
  );

  if (orders.length === 0) {
    ctx.result = [];
    return;
  }

  // 查询所有订单的明细
  const orderNos = orders.map((o) => o.order_no);
  const items = await pg.query(
    `
    SELECT
      oi.order_no,
      oi.item_flow_no,
      oi.session_count,
      oi.remaining_sessions,
      oi.sku_id,
      m.product_type,
      m.sku_display_name,
      p.name AS spu_name
    FROM order_items oi
    LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
    LEFT JOIN product_spu p ON m.spu_id = p.spu_id
    WHERE oi.order_no = ANY($1)
    ORDER BY oi.item_flow_no
  `,
    [orderNos],
  );

  // 按订单分组
  const itemsByOrder = {};
  for (const item of items) {
    if (!itemsByOrder[item.order_no]) itemsByOrder[item.order_no] = [];
    itemsByOrder[item.order_no].push({
      itemFlowNo: item.item_flow_no,
      itemName: item.spu_name || "",
      spec: item.sku_display_name || "",
      sessionCount: item.session_count,
      remainingSessions: item.remaining_sessions,
      totalSessions: item.session_count,
      productType: item.product_type || "",
    });
  }

  ctx.result = orders.map((o) => ({
    orderId: o.order_no,
    orderNo: o.order_no,
    status: o.status,
    paidAt: o.paid_at,
    items: itemsByOrder[o.order_no] || [],
  }));
}

/**
 * 手机号脱敏：显示后4位，其余替换为 *
 */
function maskPhone(phone) {
  if (!phone) return "";
  const p = String(phone).trim();
  if (p.length <= 4) return "****";
  return "*".repeat(p.length - 4) + p.slice(-4);
}

module.exports = { search, calendar, detail, paidOrders };
