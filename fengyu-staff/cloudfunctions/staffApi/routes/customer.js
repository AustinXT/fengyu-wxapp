/**
 * 顾客档案模块路由（员工端）
 * customer.search — 搜索顾客（PG 单源）
 * customer.calendar — 顾客消费日历
 * customer.detail — 顾客档案详情
 * customer.paidOrders — 顾客已支付订单（含明细）
 * customer.updateName — 修改顾客姓名
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
  restrictToBoundEmployee,
  assertCustomerProfileVisible,
} = require("../utils/scope");
const { maskPhone } = require("../utils/pii");
const { maskPhoneForAuth } = require("../utils/phone-visibility");
const { logOperation, logUpdate } = require("../utils/operation-log");
const { shanghaiDateStr } = require("../utils/datetime");
const { excludeDepositRefundSql } = require("../utils/consume-filter");
const { getPointsToYuanRate, getPointsDeductionMaxRate } = require("../utils/config");

/**
 * 顾客档案子 Tab 可见性闸门（calendar/refundHistory 等）。
 * 仅门店普通员工（store_staff）触发员工级校验；店长/管理层无额外开销（直接放行）。
 * 入参可为 clientUserId 或 clientPhone（后者先解析 user_id）。
 */
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

// 顾客档案枚举筛选白名单（值须与 db/schema/enums.ts 字面量完全一致）
const CUSTOMER_TYPE_VALUES = ['流量客', '体验客', '小美客', '会员客'];
const SPENDING_TIER_VALUES = ['10W+', '6-10W', '3-6W', '1-3W', '1990-1W', '<1990'];
const MONTHLY_ACTIVITY_VALUES = ['二次客活', '一次客活', '0次客活'];
const CUSTOMER_STATUS_VALUES = ['保有会员-稳定', '保有会员-有效', '沉睡', '冰冻', '休眠'];
const CUSTOMER_SOURCE_VALUES = [
  '美团', '抖音', '小程序', '推广部', '全员地推',
  '外请团队拓客', '老带新', '转让店', '自进店', '员工或家属',
];
const WORKFINE_PROFILE_FIELD_MAP = {
  customerSource: 'customer_source',
  birthday: 'birthday',
  occupation: 'occupation',
  isMarried: 'is_married',
  skinIssue: 'skin_issue',
  wellnessPreference: 'wellness_preference',
};
const EDITABLE_PROFILE_FIELDS = new Set([
  'promoterEmployeeId',
  ...Object.keys(WORKFINE_PROFILE_FIELD_MAP),
  'isCrossStoreTemp',
]);
const PROFILE_DB_FIELD_MAP = {
  promoterEmployeeId: 'promoter_employee_id',
  customerSource: 'customer_source',
  birthday: 'birthday',
  occupation: 'occupation',
  isMarried: 'is_married',
  skinIssue: 'skin_issue',
  wellnessPreference: 'wellness_preference',
  isCrossStoreTemp: 'is_cross_store_temp',
};

function nullableText(value, fieldLabel, maxLength) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error(`INVALID_PARAMS: ${fieldLabel}必须为字符串或 null`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new Error(`INVALID_PARAMS: ${fieldLabel}不能超过${maxLength}个字符`);
  }
  return trimmed;
}

function normalizeBirthday(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('INVALID_PARAMS: 生日格式必须为 YYYY-MM-DD');
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day) {
    throw new Error('INVALID_PARAMS: 生日日期无效');
  }
  return value;
}

function normalizeProfileChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new Error('INVALID_PARAMS: changes 必须为对象');
  }
  const keys = Object.keys(changes);
  if (keys.length === 0) throw new Error('INVALID_PARAMS: 没有需要保存的档案字段');
  const unexpected = keys.filter((key) => !EDITABLE_PROFILE_FIELDS.has(key));
  if (unexpected.length > 0) {
    throw new Error(`INVALID_PARAMS: 包含不允许修改的字段：${unexpected.join('、')}`);
  }

  const normalized = {};
  for (const key of keys) {
    const value = changes[key];
    if (key === 'promoterEmployeeId') {
      normalized[key] = nullableText(value, '推荐员工', 30);
    } else if (key === 'customerSource') {
      const source = nullableText(value, '顾客来源', 30);
      if (source !== null && !CUSTOMER_SOURCE_VALUES.includes(source)) {
        throw new Error('INVALID_PARAMS: 顾客来源不在允许范围内');
      }
      normalized[key] = source;
    } else if (key === 'birthday') {
      normalized[key] = normalizeBirthday(value);
    } else if (key === 'occupation') {
      normalized[key] = nullableText(value, '职业', 50);
    } else if (key === 'isMarried') {
      if (value !== null && typeof value !== 'boolean') {
        throw new Error('INVALID_PARAMS: 婚姻状况必须为布尔值或 null');
      }
      normalized[key] = value;
    } else if (key === 'skinIssue') {
      normalized[key] = nullableText(value, '肌肤问题', 200);
    } else if (key === 'wellnessPreference') {
      normalized[key] = nullableText(value, '养生偏好', 200);
    } else if (key === 'isCrossStoreTemp') {
      if (typeof value !== 'boolean') {
        throw new Error('INVALID_PARAMS: 临时跨门店必须为布尔值');
      }
      normalized[key] = value;
    }
  }
  return normalized;
}

function normalizeDbProfileValue(field, value) {
  if (value === undefined || value === null) return null;
  if (field === 'birthday') {
    if (value instanceof Date) {
      const year = value.getFullYear();
      const month = String(value.getMonth() + 1).padStart(2, '0');
      const day = String(value.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    return String(value).slice(0, 10);
  }
  return value;
}

/**
 * 顾客档案拓展筛选条件构造（顾客 Tab 拓展筛选区用）。
 * customerType 现按 customer_type 枚举等值过滤（'all'/缺省不过滤）；
 * 另支持 spendingTier / monthlyActivity / customerStatus 三个枚举维度。
 * 仅接受白名单内取值，非法/空值忽略（容错，不抛错）。
 * @returns {{columns: string[], values: string[]}}
 */
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

/** 把枚举筛选渲染成 ` AND col = $n ...`，占位符从 startIdx 起。 */
function renderProfileFilters(filters, startIdx) {
  return filters.columns.map((col, i) => ` AND ${col} = $${startIdx + i}`).join('');
}

/**
 * 搜索顾客（PG 单源）
 * 数据来源 = PG client_wechat_users（含 WorkFine 同步数据）
 */
async function search(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const { keyword, phone, crossStore, profileScope } = ctx.event.payload || {};

  // 拓展筛选：customer_type / spending_tier / monthly_activity / customer_status 等值过滤
  const filters = buildProfileFilters(ctx.event.payload);

  // 顾客档案浏览（profileScope，仅顾客 Tab 传）：门店普通员工只见绑定本人的顾客。
  // 业务流程选顾客（开单/充值卡/服务单/提货）不传 profileScope，不受此限制。
  const restrictEmp = profileScope && restrictToBoundEmployee(ctx.auth);

  const limit = 20;
  let rows = [];

  if (phone) {
    // 精确手机号定位：账户级资产（积分/储值卡/会员等级）不跟门店绑定，
    // 故含已解绑（bound_store_id IS NULL）顾客也应可被定位查看。
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
      // 跨门店模糊检索：开单 / 充值卡 / 服务单选顾客用（与 phone 精确分支同口径，
      // 账户级资产不跟门店绑定——含已解绑顾客、其他门店顾客、临时跨店顾客）
      // is_cross_store_temp（需求21）随行返回，供前端判断「临时跨店顾客是否允许跨门店开单」
      // ⚠️ 临时跨店顾客的 bound_store_id 可能是其他门店，故 crossStore 模式不按门店过滤，
      //    只要手机号/姓名匹配即返回（前端凭 isCrossStoreTemp 标记判断是否允许操作）
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
      // 门店内模糊检索：顾客 Tab / 服务单选顾客用
      // 顾客 Tab（profileScope）普通员工额外按 bound_employee_id 收紧
      // 门店范围对齐统一 helper：门店模式=单一 effectiveStoreId；管理层模式=ANY(scopeStoreIds)
      // $1 = kw，门店范围从 $2 起
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
    // 无 keyword 全量拉取：门店范围对齐统一 helper
    // 门店模式=单一 effectiveStoreId；管理层模式=ANY(scopeStoreIds)
    // （修复管理层模式 effectiveStoreId=null 致 bound_store_id=NULL 空数组）
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
    // 临时跨门店标记（需求21）：仅 crossStore 分支 SELECT 带出，其它分支为 undefined → false
    isCrossStoreTemp: r.is_cross_store_temp === true,
    lastServiceDate: null,
    lastPurchaseName: null,
    source: r.customer_id ? "both" : "miniprogram",
  }));

  // 补充 lastServiceDate、lastPurchaseName
  const allClientUserIds = results.map(r => r.clientUserId).filter(Boolean);

  if (allClientUserIds.length > 0) {
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

  // 交易数据跟顾客走：消费日历不再按门店过滤（顾客可见性已由 assertProfileVisibleByIdentifier 守护）

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

  const selectCols = `c.user_id, c.phone, c.name, c.customer_id, c.member_level,
    c.bound_employee_id, c.skin_type, c.improvement_focus,
    c.skin_issue, c.wellness_preference, c.gender, c.notes, c.customer_source,
    c.promoter_employee_id, c.is_cross_store_temp, c.updated_at,
    COALESCE(promoter.name, c.promoter_employee_name) AS promoter_employee_name,
    c.inviter_user_id, c.invited_at, c.customer_type,
    c.spending_tier, c.monthly_activity, c.customer_status, c.birthday,
    c.occupation, c.is_married, c.wechat_name, c.points_balance,
    c.bound_store_id, s.store_name, inviter.name AS inviter_name,
    inviter.phone AS inviter_phone`;

  const fromClause = `FROM client_wechat_users c
    LEFT JOIN stores s ON s.store_id = c.bound_store_id
    LEFT JOIN staff_wechat_users promoter ON promoter.employee_id = c.promoter_employee_id
    LEFT JOIN client_wechat_users inviter ON inviter.user_id = c.inviter_user_id`;

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
  // 顾客档案主闸门：门店普通员工只能查看绑定本人的顾客
  if (restrictToBoundEmployee(ctx.auth) && pgUser.bound_employee_id !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 顾客未分配给当前员工')
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

  const {
    totalConsumption,
    yearConsumption,
    totalActualConsumption,
    yearActualConsumption,
  } = await getConsumptionStats(pgUser.user_id);

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
    phone: maskPhoneForAuth(phone, ctx.auth),
    phoneMasked: maskPhone(phone),
    memberLevel: pgUser.member_level || null,
    storeName: pgUser.store_name ? pgUser.store_name.trim() : "",
    preferredStaffName,
    customerSource: pgUser.customer_source || null,
    promoterEmployeeId: pgUser.promoter_employee_id || null,
    promoterEmployeeName: pgUser.promoter_employee_name || null,
    inviterName: pgUser.inviter_name || null,
    inviterPhone: maskPhoneForAuth(pgUser.inviter_phone || '', ctx.auth),
    invitedAt: pgUser.invited_at || null,
    customerType: pgUser.customer_type || null,
    spendingTier: pgUser.spending_tier || null,
    monthlyActivity: pgUser.monthly_activity || null,
    customerStatus: pgUser.customer_status || null,
    birthday: normalizeDbProfileValue('birthday', pgUser.birthday),
    occupation: pgUser.occupation || null,
    isMarried: pgUser.is_married,
    wechatName: pgUser.wechat_name || null,
    skinType: pgUser.skin_type || null,
    focusAreas: pgUser.improvement_focus || null,
    skinIssue: pgUser.skin_issue || null,
    wellnessPreference: pgUser.wellness_preference || null,
    isCrossStoreTemp: pgUser.is_cross_store_temp === true,
    updatedAt: pgUser.updated_at instanceof Date
      ? pgUser.updated_at.toISOString()
      : String(pgUser.updated_at || ''),
    notes: pgUser.notes || null,
    pointsBalance: Number(pgUser.points_balance) || 0,
    lastServiceDate: visitInfo.lastServiceDate,
    visitFrequency: visitInfo.visitFrequency,
    topProductName: purchaseInfo,
    totalConsumption,
    yearConsumption,
    totalActualConsumption,
    yearActualConsumption,
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
 * 查询顾客消费和实耗统计（单次查询同时计算累计 + 年度）
 *
 * 兼容历史订单（WorkFine 同步订单无 sale_items 明细）：
 * - 有明细的订单：汇总 sale_items.received（精确到品项）
 * - 无明细的历史订单：使用 sale_orders.received（订单级汇总）
 *
 * 状态口径：'已支付', '部分支付', '已完成'（与 paidOrders 对齐）。
 * WorkFine 历史导入及退款归零后的销售单都可能是 '已完成'，仍须计入有效订单。
 * 单据口径：仅销售单、转换单计入消费；寄存单只是剩余服务权益初始化，不能重复计入。
 */
async function getConsumptionStats(clientUserId) {
  if (!clientUserId) {
    return {
      totalConsumption: 0,
      yearConsumption: 0,
      totalActualConsumption: 0,
      yearActualConsumption: 0,
    };
  }

  const yearStart = `${shanghaiDateStr().slice(0, 4)}-01-01`;
  const rows = await pg.query(
    `WITH order_stats AS (
       SELECT
       COALESCE(SUM(
         CASE
           WHEN EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_order_id = o.sale_order_id)
           THEN (SELECT SUM(si2.received::numeric) FROM sale_items si2 WHERE si2.sale_order_id = o.sale_order_id)
           ELSE o.received::numeric
         END
       ), 0) AS total
       FROM sale_orders o
       WHERE o.status IN ('已支付', '部分支付', '已完成')
         AND o.sale_order_type IN ('销售单', '转换单')
         AND o.client_user_id = $1
     ), year_payment_stats AS (
       SELECT
       COALESCE(SUM(
         sop.amount::numeric
       ), 0) AS year_total
       FROM sale_order_payments sop
       JOIN sale_orders o ON o.sale_order_id = sop.sale_order_id
       WHERE sop.status = '已支付'
         AND o.sale_order_type IN ('销售单', '转换单')
         AND o.client_user_id = $1
         AND o.legacy_source IS DISTINCT FROM 'workfine'
         AND sop.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Shanghai')
         AND sop.paid_at < (($2::date + INTERVAL '1 year') AT TIME ZONE 'Asia/Shanghai')
     ), legacy_year_stats AS (
       SELECT
       COALESCE(SUM(
         CASE
           WHEN EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_order_id = o.sale_order_id)
           THEN (SELECT SUM(si2.received::numeric) FROM sale_items si2 WHERE si2.sale_order_id = o.sale_order_id)
           ELSE o.received::numeric
         END
       ), 0) AS year_total
       FROM sale_orders o
       WHERE o.status IN ('已支付', '部分支付', '已完成')
         AND o.sale_order_type IN ('销售单', '转换单')
         AND o.client_user_id = $1
         AND o.legacy_source = 'workfine'
         AND o.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Shanghai')
         AND o.paid_at < (($2::date + INTERVAL '1 year') AT TIME ZONE 'Asia/Shanghai')
     ), actual_stats AS (
       SELECT
         COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS total_actual_consumption,
         COALESCE(SUM(CASE WHEN so.service_date >= $2::date
           THEN sit.unit_real_price::numeric * sit.session_used ELSE 0 END), 0) AS year_actual_consumption
       FROM service_orders so
       JOIN service_items sit ON sit.service_order_id = so.service_order_id
       WHERE so.client_user_id = $1
         AND so.status = '已完成'
         AND ${excludeDepositRefundSql('so')}
     )
     SELECT order_stats.total,
            year_payment_stats.year_total + legacy_year_stats.year_total AS year_total,
            actual_stats.total_actual_consumption, actual_stats.year_actual_consumption
       FROM order_stats
       CROSS JOIN year_payment_stats
       CROSS JOIN legacy_year_stats
       CROSS JOIN actual_stats`,
    [clientUserId, yearStart],
  );
  const stats = rows[0] || {};
  return {
    totalConsumption: Number(stats.total || 0),
    yearConsumption: Number(stats.year_total || 0),
    totalActualConsumption: Number(stats.total_actual_consumption || 0),
    yearActualConsumption: Number(stats.year_actual_consumption || 0),
  };
}

/**
 * 顾客已支付订单（含明细）
 */
async function paidOrders(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const payload = ctx.event.payload || {};
  let clientUserId = payload.clientUserId;
  const clientPhone = payload.clientPhone;
  if (!clientUserId && !clientPhone) {
    throw new Error("INVALID_PARAMS: 缺少 clientUserId 或 clientPhone");
  }

  // 手机号 → clientUserId：统一走 clientUserId 守卫分支
  //（复用现有 assertCustomerInScope 可见性逻辑，不引入新逻辑）
  if (!clientUserId && clientPhone) {
    const r = await pg.query(
      "SELECT user_id FROM client_wechat_users WHERE phone = $1 LIMIT 1",
      [clientPhone],
    );
    clientUserId = r[0]?.user_id || null;
  }

  // scope 守卫：校验该顾客 bound_store_id ∈ 当前 scope（可见性逻辑保持原样）
  if (clientUserId) {
    await assertCustomerInScope(pg, ctx.auth, clientUserId)
  }

  // 交易数据跟顾客走：放开订单门店过滤，按顾客查全量（含跨门店订单/卡）
  // 状态口径：有效收款订单（已支付 + 部分支付 + 已完成）。部分支付疗程卡按 paid_sessions 限额核销（与 service.create 后端、
  //   admin getAvailableSaleItems 一致）；待支付单 paid_sessions=0，不进入可核销卡数据源。
  let whereClause, params;
  if (clientUserId) {
    whereClause = "o.status IN ('已支付', '部分支付', '已完成') AND o.client_user_id = $1";
    params = [clientUserId];
  } else {
    // 极端：手机号无对应顾客（如有 client_phone 无账户的 legacy 单）——无顾客可绑，数据不「跟顾客走」，
    // 退回门店 scope 过滤，否则任意已绑定员工可凭手机号枚举全门店已支付订单（越权）。
    const scope = buildStoreScopeCondition(ctx.auth, "o.store_id", 2);
    whereClause = `o.status IN ('已支付', '部分支付', '已完成') AND o.client_phone = $1 AND ${scope.sql}`;
    params = [clientPhone, ...scope.params];
  }

  const orders = await pg.query(
    `SELECT
       o.sale_order_id,
       o.status,
       o.sale_order_datetime,
       o.paid_at,
       o.store_id,
       s.store_name,
       o.sale_order_type,
       o.document_type,
       o.market_name,
       o.legacy_source
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
      si.sale_item_group_id,
      si.store_id,
      si.sku_id,
      si.item_direction,
      si.ref_sale_item_id,
      si.session_count,
      si.remaining_sessions,
      si.paid_sessions,
      si.quantity,
      si.product_type,
      si.product_name,
      si.unit_price,
      si.unit_real_price,
      si.sale_amount,
      si.received,
      si.pending_received,
      si.expire_date,
      si.remark,
      si.sales_category,
      si.picked_up_quantity,
      -- 行级欠款：仅「订单确实未付清」且「该卡未买满次数」时才算。
      -- 订单已付清但行 received 不足的是行级分摊缺口（已知数据问题），不是顾客欠款；
      -- 寄存单 total_amount<=0 → paid_sessions=session_count，天然不进此分支（其 sale_amount 只是原价快照）。
      CASE
        WHEN o.status = '部分支付'
         AND si.paid_sessions IS NOT NULL
         AND si.paid_sessions < si.session_count
         AND NOT EXISTS (
           SELECT 1 FROM sale_order_payments sop
           WHERE sop.sale_order_id = si.sale_order_id
             AND sop.change_type = '退款' AND sop.status = '已支付'
         )
         -- 1 元阈值：瀑布分摊的 ROUND 尾差会造出 ¥0.01 的假欠款，不值得推给顾客
         AND (si.sale_amount::numeric - si.received::numeric) >= 1
        THEN GREATEST(0, si.sale_amount::numeric - si.received::numeric)::numeric(12, 2)
        ELSE NULL
      END AS unpaid_amount,
      o.remark AS order_remark,
      COALESCE(ps.unit, CASE WHEN si.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit,
      ps.category_id,
      pc.category_name,
      pc.product_kind,
      COALESCE(pc_parent.display_color, pc.display_color) AS category_color
    FROM sale_items si
    JOIN sale_orders o ON si.sale_order_id = o.sale_order_id
    LEFT JOIN product_skus ps ON si.sku_id = ps.sku_id
    LEFT JOIN product_categories pc ON ps.category_id = pc.category_id
    LEFT JOIN product_categories pc_parent ON pc_parent.category_name = pc.product_kind AND pc_parent.product_kind IS NULL
    WHERE si.sale_order_id = ANY($1)
      AND si.product_type = '疗程卡'
      AND (
        si.item_direction = '购买'
        OR (o.sale_order_type = '转换单' AND si.item_direction = '转入')
      )
      -- M12：历史订单（workfine 拉取）的 NULL 卡不下发（后端过滤，前端 uniform-disabled 保留给非 legacy NULL 卡）
      AND NOT (si.paid_sessions IS NULL AND o.legacy_source = 'workfine')
      -- 在途退款冻结：原订单存在 '待审批' 退款时排除整单的卡
      AND NOT EXISTS (
        SELECT 1 FROM sale_order_payments sop
        WHERE sop.sale_order_id = si.sale_order_id
          AND sop.change_type = '退款' AND sop.status = '待审批'
      )
      -- issue #122：改按物理剩余次数下发。部分支付导致 paid_sessions=0 的卡以前被整行剔除，
      -- 顾客档案看不到这张卡；现在照常展示（可用次数 0 + 待付清标注），核销限额仍走 paid_sessions
      -- （service.create/start/finalize 三处独立校验，不受本过滤影响）。
      -- 历史 NULL 行保留为 disabled 灰显（legacy workfine NULL 已在上方排除）。
      AND (
        si.paid_sessions IS NULL
        OR si.remaining_sessions > 0
      )
      -- ⚠ 退款不减 remaining_sessions（Model X，见 utils/refund.js）：paid_sessions 是"已退卡从卡包
      -- 消失"的唯一机制。放宽展示门槛时必须把这条守卫补回来，否则已退款的卡会重新出现在卡包里。
      -- 与 clientApi/routes/order.js 的 appointableItems 同款守卫。
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
      saleItemGroupId: item.sale_item_group_id || null,
      storeId: item.store_id,
      skuId: item.sku_id || null,
      itemDirection: item.item_direction || '',
      refSaleItemId: item.ref_sale_item_id || null,
      itemName: item.product_name || "",
      spec: "",
      sessionCount: item.session_count,
      remainingSessions: item.remaining_sessions,
      totalSessions: item.session_count,
      paidSessions: item.paid_sessions,
      quantity: Number(item.quantity || 1),
      productType: item.product_type || "",
      unit: item.unit || (item.product_type === '家居产品' ? '盒' : '次'),
      unitPrice: item.unit_price != null ? Number(item.unit_price).toFixed(2) : "",
      unitRealPrice: item.unit_real_price != null ? Number(item.unit_real_price).toFixed(2) : "",
      saleAmount: item.sale_amount != null ? Number(item.sale_amount).toFixed(2) : "",
      received: item.received != null ? Number(item.received).toFixed(2) : "",
      pendingReceived: item.pending_received != null ? Number(item.pending_received).toFixed(2) : "",
      // 仅订单未付清且该卡未买满次数时有值；已付清/寄存单/NULL 卡一律 null
      unpaidAmount: item.unpaid_amount != null ? Number(item.unpaid_amount) : null,
      expireDate: item.expire_date || null,
      remark: item.remark || null,
      salesCategory: item.sales_category || null,
      pickedUpQuantity: item.picked_up_quantity != null ? Number(item.picked_up_quantity) : null,
      orderRemark: typeof item.order_remark === "string" && item.order_remark.trim()
        ? item.order_remark.trim()
        : null,
      categoryId: item.category_id || "",
      categoryName: item.category_name || "",
      category: item.category_name || "",
      categoryColor: item.category_color || "",
      productKind: item.product_kind || "",
    });
  }

  ctx.result = orders.map((o) => ({
    orderId: o.sale_order_id,
    saleOrderId: o.sale_order_id,
    status: o.status,
    saleOrderDatetime: o.sale_order_datetime,
    paidAt: o.paid_at,
    storeId: o.store_id,
    storeName: o.store_name || "",
    saleOrderType: o.sale_order_type || "",
    documentType: o.document_type || null,
    marketName: o.market_name || "",
    legacySource: o.legacy_source || null,
    items: itemsByOrder[o.sale_order_id] || [],
  }));
}

function mapHomeProductRow(row) {
  const pickedQuantity = Number(row.picked_quantity || 0)
  const refundedQuantity = Number(row.refunded_quantity || 0)
  const convertedQuantity = Number(row.converted_quantity || 0)
  const remainingQuantity = Number(row.remaining_quantity || 0)
  const paidQuantity = Number(row.paid_quantity || 0)
  const pendingPickupQuantity = Number(row.pending_pickup_quantity || 0)
  // 待付清行的欠款金额：received 是行级净实收（已扣该行退款），故对退过款的行
  // sale_amount - received 会把"退掉的钱"误算成欠款；寄存单行 SQL 已置 NULL。
  const unpaidAmount =
    refundedQuantity > 0 || row.unpaid_amount == null ? null : Number(row.unpaid_amount)
  let status
  if (row.refund_pending) status = '退款处理中'
  else if (pendingPickupQuantity > 0) status = pickedQuantity > 0 ? '部分提货' : '待提货'
  // 「待付清」必须与欠款金额绑定：只有真的算得出欠款才这么标。
  // 否则寄存单（金额列留空）和退款后仍有剩余的行会被误标成待付清/已完成。
  else if (unpaidAmount > 0) status = '待付清'
  // 还有未交付份额但算不出欠款（寄存单、退款后剩余）——是待提，不是已完成。
  else if (remainingQuantity > 0) status = '待提货'
  // #125：整行折抵后 settled=purchased，于是 pending=0、remaining=0、refunded=0，
  // 不看 convertedQuantity 会把「已转走」误判成「已提货」。
  else status = (refundedQuantity > 0 || convertedQuantity > 0) ? '已完成' : '已提货'

  return {
    saleItemId: row.sale_item_id,
    saleItemGroupId: row.sale_item_group_id || null,
    saleOrderId: row.sale_order_id,
    productName: row.product_name || '家居产品',
    unit: row.unit || '盒',
    purchasedQuantity: Number(row.purchased_quantity || 0),
    paidQuantity,
    pickedQuantity,
    refundedQuantity,
    convertedQuantity,
    remainingQuantity,
    pendingPickupQuantity,
    unpaidAmount,
    status,
    storeId: row.store_id,
    storeName: row.store_name || null,
    purchasedAt: row.purchased_at,
  }
}

/** 顾客已购家居产品资产；交易数据跟顾客走，跨店只读展示。 */
async function homeProducts(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  let clientUserId = payload.clientUserId
  const clientPhone = payload.clientPhone
  if (!clientUserId && !clientPhone) {
    throw new Error('INVALID_PARAMS: 缺少 clientUserId 或 clientPhone')
  }

  if (!clientUserId && clientPhone) {
    const users = await pg.query(
      'SELECT user_id FROM client_wechat_users WHERE phone = $1 LIMIT 1',
      [clientPhone],
    )
    clientUserId = users[0]?.user_id || null
  }
  if (!clientUserId) {
    ctx.result = []
    return
  }

  // 顾客档案子页统一闸门：门店普通员工只能读取分配给自己的顾客。
  // 查询结果可跨订单门店展示，但不能借此绕过顾客档案的可见性范围。
  await assertCustomerProfileVisible(pg, ctx.auth, clientUserId)

  const rows = await pg.query(
    `WITH pickup_totals AS (
       SELECT sale_item_id, SUM(pickup_quantity)::int AS picked_quantity
         FROM pickup_records
        GROUP BY sale_item_id
     ), conversion_totals AS (
       -- 2026-09-14 #125：家居转出数量并入 picked_up_quantity（"已结算"），这里单独聚合出来，
       -- 避免把"已转换"算进"已退款"。只有「已关闭」完成过 rollback（数量已退回），故只排除它；
       -- 其余状态（含"支付失败"）扣减仍然生效，必须计入已转换。删除订单的转出行已随主单消失。
       SELECT out_item.ref_sale_item_id AS sale_item_id,
              SUM(out_item.quantity)::int AS converted_quantity
         FROM sale_items out_item
         JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id
        WHERE out_item.item_direction = '转出'
          AND out_item.product_type = '家居产品'
          AND out_item.ref_sale_item_id IS NOT NULL
          AND conv_order.status <> '已关闭'
        GROUP BY out_item.ref_sale_item_id
     ), home_product_rows AS (
       SELECT COALESCE(si.sale_item_group_id, si.sale_item_id) AS sale_item_group_id,
              si.sale_item_id,
              si.sale_order_id,
              COALESCE(si.product_name, '家居产品') AS product_name,
              COALESCE(ps.unit, '盒') AS unit,
              si.quantity::int AS purchased_quantity,
              LEAST(si.quantity, GREATEST(0, COALESCE(si.picked_up_quantity, 0)))::int AS settled_quantity,
              LEAST(
                LEAST(si.quantity, GREATEST(0, COALESCE(si.picked_up_quantity, 0))),
                GREATEST(0, COALESCE(pt.picked_quantity, 0))
              )::int AS picked_quantity,
              LEAST(
                LEAST(si.quantity, GREATEST(0, COALESCE(si.picked_up_quantity, 0))),
                GREATEST(0, COALESCE(ct.converted_quantity, 0))
              )::int AS converted_quantity,
              CASE
                -- 寄存单：货本就属于顾客，全额可提（sale_amount 只是原价快照，received 不代表欠款）。
                -- 判据与 #120 展示侧 is_deposit 同源；刻意不用疗程卡那条 total_amount<=0——后者会连带覆盖
                -- 转换单/零总额单，且 total_amount 无 CHECK 约束，负值会静默放行。
                WHEN o.sale_order_type = '寄存单' THEN si.quantity
                WHEN si.sale_amount <= 0 THEN si.quantity
                ELSE LEAST(
                  si.quantity,
                  FLOOR(GREATEST(0, si.received::numeric) * si.quantity / NULLIF(si.sale_amount::numeric, 0))::int
                )
              END AS paid_quantity,
              si.sale_amount::numeric AS row_sale_amount,
              GREATEST(0, si.received::numeric) AS row_received,
              (o.sale_order_type = '寄存单') AS is_deposit,
              o.store_id,
              s.store_name,
              COALESCE(o.paid_at, o.sale_order_datetime, o.created_at) AS purchased_at,
              EXISTS (
                SELECT 1 FROM sale_order_payments sop
                 WHERE sop.sale_order_id = o.sale_order_id
                   AND sop.change_type = '退款'
                   AND sop.status = '待审批'
              ) AS refund_pending
         FROM sale_items si
         JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
         LEFT JOIN stores s ON s.store_id = o.store_id
         LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
         LEFT JOIN pickup_totals pt ON pt.sale_item_id = si.sale_item_id
         LEFT JOIN conversion_totals ct ON ct.sale_item_id = si.sale_item_id
        WHERE o.client_user_id = $1
          AND o.status IN ('已支付', '部分支付', '已完成')
          -- #145/#153：转换单换入的家居与购买行同权（与疗程卡侧放行写法同源）。
          -- sale_amount>0 的转入行，received 已由 paid-sessions STEP 1.6 重建为「转出旧卡
          -- 价值 + 本单净到账」，FLOOR(received × qty / sale_amount) 天然成立；sale_amount<=0
          -- 的转入行走上方赠品分支全额可提（STEP 1.6 带 sale_amount>0 过滤，刻意不碰 0 元行，
          -- 与购买侧 0 元赠品行同口径）。两类都不需要为「转入」另加满付分支。
          AND (
            si.item_direction = '购买'
            OR (o.sale_order_type = '转换单' AND si.item_direction = '转入')
          )
          AND si.product_type = '家居产品'
     ), home_products AS (
       SELECT sale_item_group_id,
              MIN(si.sale_item_id) AS sale_item_id,
              MIN(si.sale_order_id) AS sale_order_id,
              MIN(COALESCE(si.product_name, '家居产品')) AS product_name,
              MIN(si.unit) AS unit,
              SUM(si.purchased_quantity)::int AS purchased_quantity,
              SUM(si.settled_quantity)::int AS settled_quantity,
              SUM(si.picked_quantity)::int AS picked_quantity,
              SUM(si.converted_quantity)::int AS converted_quantity,
              SUM(si.paid_quantity)::int AS paid_quantity,
              SUM(si.row_sale_amount) AS sale_amount_total,
              SUM(si.row_received) AS received_total,
              BOOL_OR(si.is_deposit) AS is_deposit,
              MIN(si.store_id) AS store_id,
              MIN(si.store_name) AS store_name,
              MAX(si.purchased_at) AS purchased_at,
              BOOL_OR(si.refund_pending) AS refund_pending
         FROM home_product_rows si
      GROUP BY sale_item_group_id
     ), home_product_balances AS (
       SELECT *,
              GREATEST(0, settled_quantity - picked_quantity - converted_quantity)::int AS refunded_quantity,
              (purchased_quantity - settled_quantity)::int AS remaining_quantity,
              LEAST(
                purchased_quantity - settled_quantity,
                -- #145/#153：已折抵转走的件数必须一并扣除。picked_up_quantity 混装了
                -- 「已提货 + 已退款 + 已折抵」三义，而 received 已扣过退款（STEP 1.5），
                -- 所以这里只能减「已提 + 已折抵」——退款靠 paid_quantity 反映，再减一次就是重复扣减。
                GREATEST(paid_quantity - picked_quantity - converted_quantity, 0)
              )::int AS pending_pickup_quantity,
              -- 寄存单的 sale_amount 只是原价快照、received 恒为历史值，两者相减不是欠款
              -- （寄存的货本就属于顾客）。金额列一律留空，与导出口径一致。
              CASE WHEN is_deposit THEN NULL
                   ELSE GREATEST(0, sale_amount_total - received_total)::numeric(12, 2)
              END AS unpaid_amount
         FROM home_products
     )
     SELECT *
       FROM home_product_balances
      WHERE picked_quantity > 0 OR remaining_quantity > 0 OR converted_quantity > 0
   ORDER BY (pending_pickup_quantity > 0) DESC,
            purchased_at DESC,
            sale_item_id`,
    [clientUserId],
  )

  ctx.result = rows.map(mapHomeProductRow)
}

/**
 * 顾客消费记录（全状态 + 跨门店，仅展示用）
 *
 * 与 paidOrders 的区别 / 为何独立成 action：
 *   paidOrders 返回「已支付/部分支付」订单并对 items 做退款冻结过滤，前端复用它提取
 *   疗程卡 Tab 的可核销卡（→ service.create 核销次数；部分支付卡按 paid_sessions 限额核销）。
 *   本 action（orders）查全部状态供消费记录列表展示，items 不参与核销，
 *   故待支付/已关闭等非可核销订单也展示（仅记录，不可点选核销）。
 *   故消费记录列表独立成此 action：查全部状态、跨门店，items 仅作展示，不参与核销。
 */
async function orderHistory(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const payload = ctx.event.payload || {};
  let clientUserId = payload.clientUserId;
  const clientPhone = payload.clientPhone;
  if (!clientUserId && !clientPhone) {
    throw new Error("INVALID_PARAMS: 缺少 clientUserId 或 clientPhone");
  }

  // 手机号 → clientUserId：统一走 clientUserId 守卫分支（与 paidOrders 一致）
  if (!clientUserId && clientPhone) {
    const r = await pg.query(
      "SELECT user_id FROM client_wechat_users WHERE phone = $1 LIMIT 1",
      [clientPhone],
    );
    clientUserId = r[0]?.user_id || null;
  }

  // scope 守卫：校验该顾客 bound_store_id ∈ 当前 scope（可见性逻辑与 paidOrders 一致）
  if (clientUserId) {
    await assertCustomerInScope(pg, ctx.auth, clientUserId);
  }

  // 交易数据跟顾客走：放开门店过滤 + 不限状态，按顾客查全量（含跨门店、各状态）
  let whereClause, params;
  if (clientUserId) {
    whereClause = "o.client_user_id = $1";
    params = [clientUserId];
  } else {
    // 极端：手机号无对应顾客——无顾客可绑则退回门店 scope 过滤，杜绝凭手机号越权枚举全门店订单（与 paidOrders 一致）。
    const scope = buildStoreScopeCondition(ctx.auth, "o.store_id", 2);
    whereClause = `o.client_phone = $1 AND ${scope.sql}`;
    params = [clientPhone, ...scope.params];
  }

  // 待支付订单 paid_at 为 NULL，按 COALESCE(paid_at, created_at) 排序避免乱序
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

  // 消费记录仅展示商品名，不做 paidOrders 的退款冻结/可核销过滤
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
      spec: "",
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

/**
 * 服务记录（顾客档案「服务记录」Tab）
 *
 * 交易数据跟顾客走：放开门店过滤 + 不限状态，按 client_user_id 查全量服务单（含跨门店、各状态）。
 * 可见性由 assertCustomerInScope（bound_store_id ∈ scope）守护，与 orderHistory 同口径。
 * 点进详情走 service.detail（已支持顾客档案场景的跨门店只读放行）。
 */
async function serviceHistory(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const payload = ctx.event.payload || {};
  let clientUserId = payload.clientUserId;
  const clientPhone = payload.clientPhone;
  if (!clientUserId && !clientPhone) {
    throw new Error("INVALID_PARAMS: 缺少 clientUserId 或 clientPhone");
  }

  // 手机号 → clientUserId（service_orders 仅有 client_user_id，无 client_phone 列）
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

  // scope 守卫：校验该顾客 bound_store_id ∈ 当前 scope（与 orderHistory 一致）
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

  // 批量查询服务明细摘要（项目名）
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
      spec: "",
    });
  }

  // 批量查询员工姓名
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

/**
 * 返回顾客档案顶部状态卡片对应的 tag。
 * 会员客按每日重算的 customer_status 分类；非会员客按最近服务日期实时分类。
 * stats 和 listByTag 必须共用此函数，否则会出现卡片数量与点击后列表不一致。
 */
function customerActivityTag(row, today) {
  if (row.customer_type === '会员客' && row.customer_status) {
    switch (row.customer_status) {
      case '保有会员-稳定':
      case '保有会员-有效': return 'active';
      case '沉睡': return 'atRisk';
      case '冰冻': return 'lost';
      case '休眠':
      default: return 'sleeping';
    }
  }

  if (!row.last_service_date) return 'sleeping';
  const diffDays = Math.floor((new Date(today) - new Date(row.last_service_date)) / 86400000);
  if (diffDays <= 30) return 'active';
  if (diffDays <= 60) return 'atRisk';
  if (diffDays <= 90) return 'lost';
  return 'sleeping';
}

/**
 * 顾客分类统计（基于最近服务日期 + 生日）
 * 返回各状态的顾客数量
 */
async function stats(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const now = new Date()
  const today = shanghaiDateStr(now)
  const currentMonth = now.getMonth() + 1
  const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1

  // scope 过滤：兼容门店模式(单一)+管理层模式(多门店)
  // 普通员工（store_staff）顾客统计仅覆盖绑定本人的顾客
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
    switch (customerActivityTag(r, today)) {
      case 'active': active++; break
      case 'atRisk': atRisk++; break
      case 'lost': lost++; break
      case 'sleeping': sleeping++; break
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

  const now = new Date()
  const today = shanghaiDateStr(now)
  const currentMonth = now.getMonth() + 1
  const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1

  // 查询所有绑定本店的顾客及其最近服务日期（兼容门店/管理层 scope）
  // 普通员工（store_staff）仅覆盖绑定本人的顾客
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
      c.customer_type, c.customer_status,
      MAX(so.service_date) AS last_service_date
    FROM client_wechat_users c
    LEFT JOIN service_orders so
      ON so.client_user_id = c.user_id
      AND so.status = '已完成'
      AND ${soScope.sql}
    WHERE ${cWhere}
    GROUP BY c.user_id, c.name, c.phone, c.birthday, c.member_level,
             c.customer_type, c.customer_status
  `, [...cParams, ...soScope.params])

  // 按 tag 过滤
  const filtered = allRows.filter(r => {
    if (tag === 'birthday') {
      return r.birthday && (new Date(r.birthday).getMonth() + 1) === currentMonth
    }
    if (tag === 'birthdayNext') {
      return r.birthday && (new Date(r.birthday).getMonth() + 1) === nextMonth
    }
    if (['active', 'atRisk', 'lost', 'sleeping'].includes(tag)) {
      return customerActivityTag(r, today) === tag
    }
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
      return {
        id: null,
        clientUserId: r.user_id,
        name: r.name || '',
        phone: maskPhoneForAuth(r.phone, ctx.auth),
        phoneMasked: maskPhone(r.phone),
        memberLevel: r.member_level,
        lastServiceDate: r.last_service_date,
        lastPurchaseName: lastPurchaseMap[r.user_id] || null,
        birthday: normalizeDbProfileValue('birthday', r.birthday),
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

  await assertProfileVisibleByIdentifier(ctx.auth, clientUserId, clientPhone)

  // 退款流水（来自 sale_order_payments）+ store_id scope
  let refundParams, refundClientWhere
  if (clientUserId) {
    refundClientWhere = 'so.client_user_id = $1'
    refundParams = [clientUserId]
  } else {
    refundClientWhere = 'so.client_phone = $1'
    refundParams = [clientPhone]
  }
  // 交易数据跟顾客走：退款流水不再按门店过滤（顾客可见性已由 assertProfileVisibleByIdentifier 守护）
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

  // 转换单（仍保留 sale_orders 路径）+ store_id scope
  let convParams, convClientWhere
  if (clientUserId) {
    convClientWhere = 'o.client_user_id = $1'
    convParams = [clientUserId]
  } else {
    convClientWhere = 'o.client_phone = $1'
    convParams = [clientPhone]
  }
  // 交易数据跟顾客走：转换单不再按门店过滤
  const convWhere = convClientWhere
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
      specName: null,
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
 * 搜索顾客的推荐员工候选（仅当前门店有效店长）。
 * 可检索全部在职员工（跨店），本店员工优先展示。
 */
async function searchPromoterEmployees(ctx) {
  await requireManager()(ctx, async () => {})

  const { clientUserId, keyword } = ctx.event.payload || {}
  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')
  if (typeof keyword !== 'string' || keyword.trim().length < 2) {
    throw new Error('INVALID_PARAMS: 请输入至少2个字符搜索员工')
  }

  const { boundStoreId } = await assertCustomerInScope(pg, ctx.auth, clientUserId)
  const pattern = `%${keyword.trim()}%`
  const rows = await pg.query(`
    SELECT u.employee_id, u.name, u.phone, u.store_id, s.store_name
    FROM staff_wechat_users u
    LEFT JOIN stores s ON s.store_id = u.store_id
    WHERE u.is_resigned = false
      AND (u.name ILIKE $2 OR u.phone ILIKE $2)
    ORDER BY (u.store_id = $1) DESC, u.name
    LIMIT 20
  `, [boundStoreId, pattern])

  ctx.result = rows.map((row) => ({
    employeeId: row.employee_id,
    name: row.name || '',
    phoneMasked: maskPhone(row.phone || ''),
    storeName: row.store_name || '',
  }))
}

/**
 * 更新顾客基本档案（仅当前门店有效店长）。
 */
async function updateProfile(ctx) {
  await requireManager()(ctx, async () => {})

  const { clientUserId, expectedUpdatedAt, changes } = ctx.event.payload || {}
  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')
  if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt.trim()) {
    throw new Error('INVALID_PARAMS: 缺少 expectedUpdatedAt')
  }
  const normalized = normalizeProfileChanges(changes)

  ctx.result = await pg.transaction(async (client) => {
    const beforeResult = await client.query(`
      SELECT user_id, bound_store_id, promoter_employee_id, promoter_employee_name,
             customer_source, birthday, occupation, is_married, skin_issue,
             wellness_preference, is_cross_store_temp, workfine_override_fields, updated_at
      FROM client_wechat_users
      WHERE user_id = $1
      FOR UPDATE
    `, [clientUserId])
    const before = beforeResult.rows[0]
    if (!before) throw new Error('PERMISSION_DENIED: 顾客不存在')
    if (!isStoreInScope(ctx.auth, before.bound_store_id)) {
      throw new Error('PERMISSION_DENIED: 顾客不在当前门店范围内')
    }

    let promoterName = before.promoter_employee_name || null
    if (Object.prototype.hasOwnProperty.call(normalized, 'promoterEmployeeId')) {
      const promoterId = normalized.promoterEmployeeId
      if (promoterId) {
        const promoterResult = await client.query(`
          SELECT employee_id, name
          FROM staff_wechat_users
          WHERE employee_id = $1 AND is_resigned = false
          LIMIT 1
        `, [promoterId])
        const promoter = promoterResult.rows[0]
        if (!promoter) {
          throw new Error('PERMISSION_DENIED: 推荐员工不存在或已离职')
        }
        promoterName = promoter.name || null
      } else {
        promoterName = null
      }
    }

    const actualChanges = {}
    for (const [field, value] of Object.entries(normalized)) {
      const oldValue = normalizeDbProfileValue(field, before[PROFILE_DB_FIELD_MAP[field]])
      if (JSON.stringify(oldValue) !== JSON.stringify(value)) actualChanges[field] = value
    }

    if (Object.keys(actualChanges).length === 0) {
      return {
        updatedAt: before.updated_at instanceof Date
          ? before.updated_at.toISOString()
          : String(before.updated_at || ''),
        changes: {},
      }
    }

    const setClauses = []
    const params = []
    const param = (value) => {
      params.push(value)
      return `$${params.length}`
    }
    for (const [field, value] of Object.entries(actualChanges)) {
      setClauses.push(`${PROFILE_DB_FIELD_MAP[field]} = ${param(value)}`)
      if (field === 'promoterEmployeeId') {
        setClauses.push(`promoter_employee_name = ${param(promoterName)}`)
      }
    }

    const overrideFields = Object.keys(actualChanges)
      .filter((field) => Object.prototype.hasOwnProperty.call(WORKFINE_PROFILE_FIELD_MAP, field))
      .map((field) => WORKFINE_PROFILE_FIELD_MAP[field])
    if (overrideFields.length > 0) {
      const overrideParam = param(overrideFields)
      setClauses.push(`workfine_override_fields = ARRAY(
        SELECT DISTINCT unnest(workfine_override_fields || ${overrideParam}::text[])
      )`)
    }
    setClauses.push('updated_at = NOW()')
    params.push(clientUserId, expectedUpdatedAt)
    const userIdParam = `$${params.length - 1}`
    const updatedAtParam = `$${params.length}`

    const updateResult = await client.query(`
      UPDATE client_wechat_users
      SET ${setClauses.join(', ')}
      WHERE user_id = ${userIdParam}
        AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', ${updatedAtParam}::timestamptz)
      RETURNING updated_at
    `, params)
    if (updateResult.rows.length === 0) {
      throw new Error('CONFLICT: 顾客档案已被其他人修改，请刷新后重试')
    }

    const auditBefore = {}
    const auditAfter = {}
    for (const [field, value] of Object.entries(actualChanges)) {
      auditBefore[field] = normalizeDbProfileValue(field, before[PROFILE_DB_FIELD_MAP[field]])
      auditAfter[field] = value
    }
    if (Object.prototype.hasOwnProperty.call(actualChanges, 'promoterEmployeeId')) {
      auditBefore.promoterEmployeeName = before.promoter_employee_name || null
      auditAfter.promoterEmployeeName = promoterName
    }
    await logUpdate(client, ctx, 'customer.update', 'customer', clientUserId, auditBefore, auditAfter)

    return {
      updatedAt: updateResult.rows[0].updated_at instanceof Date
        ? updateResult.rows[0].updated_at.toISOString()
        : String(updateResult.rows[0].updated_at || ''),
      changes: {
        ...actualChanges,
        ...(Object.prototype.hasOwnProperty.call(actualChanges, 'promoterEmployeeId')
          ? { promoterEmployeeName: promoterName }
          : {}),
      },
    }
  })
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

  await pg.transaction(async (client) => {
    await client.query(
      'UPDATE client_wechat_users SET notes = $1, updated_at = NOW() WHERE user_id = $2',
      [trimmed || null, clientUserId]
    )
    // Audit log
    await logOperation(client, ctx, 'customer.updateNotes', 'customer', clientUserId, {
      _v: 3,
      notesLength: trimmed ? trimmed.length : 0,
    })
  })

  ctx.result = { message: '备注已保存' }
}

/**
 * 修改顾客姓名（店长专用）
 */
async function updateName(ctx) {
  await requireManager()(ctx, async () => {})

  const { clientUserId, name } = ctx.event.payload || {}
  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')
  if (typeof name !== 'string') throw new Error('INVALID_PARAMS: name 必须为字符串')

  const trimmed = name.trim()
  if (!trimmed) throw new Error('INVALID_PARAMS: 顾客姓名不能为空')
  if (trimmed.length > 50) throw new Error('INVALID_PARAMS: 顾客姓名不能超过50个字符')

  // 顾客必须存在且归属当前门店 scope。
  await assertCustomerInScope(pg, ctx.auth, clientUserId)
  const beforeRows = await pg.query(
    'SELECT name FROM client_wechat_users WHERE user_id = $1',
    [clientUserId],
  )
  const oldName = beforeRows[0]?.name || null

  await pg.transaction(async (client) => {
    await client.query(
      'UPDATE client_wechat_users SET name = $1, updated_at = NOW() WHERE user_id = $2',
      [trimmed, clientUserId],
    )
    // 与 admin 修改顾客档案共用 customer.update，审计中心可统一展示和筛选。
    await logOperation(client, ctx, 'customer.update', 'customer', clientUserId, {
      _v: 3,
      _t: 'update',
      changes: {
        name: { from: oldName, to: trimmed },
      },
    })
  })

  ctx.result = { message: '顾客姓名已更新', name: trimmed }
}

/**
 * 查询顾客储值卡余额与积分抵扣配置（店长专用，跨店共享）
 * payload: { customerUserId: string }
 * 返回: { cardId: string|null, balance: number, pointsBalance: number, pointsToYuanRate: number, pointsDeductionMaxRate: number }
 */
async function customerBalance(ctx) {
  await requireManager()(ctx, async () => {})

  const { customerUserId } = ctx.event.payload || {}
  if (!customerUserId) {
    throw new Error('INVALID_PARAMS: 缺少 customerUserId')
  }

  // scope 守卫：储值卡余额是账户级资产（prepaid_cards 跨店共享，无 store_id 列），
  // 不跟门店绑定。放行「scope 内 OR 已解绑（bound_store_id IS NULL）OR 临时跨店
  // （is_cross_store_temp）」——解绑/临时跨店顾客的余额仍可查（同 card.recharge/card.inflow
  // 放行口径：外店可给临时跨店顾客充值，开单结算层必须能看到余额）；
  // 仅「仍绑定他店」的普通顾客继续 PERMISSION_DENIED。
  const scopeRows = await pg.query(
    'SELECT bound_store_id, is_cross_store_temp FROM client_wechat_users WHERE user_id = $1',
    [customerUserId]
  )
  if (scopeRows.length === 0) {
    throw new Error('PERMISSION_DENIED: 顾客不存在')
  }
  const boundStoreId = scopeRows[0].bound_store_id
  if (boundStoreId !== null && !isStoreInScope(ctx.auth, boundStoreId) && !scopeRows[0].is_cross_store_temp) {
    throw new Error('PERMISSION_DENIED: 顾客不在当前门店范围内')
  }

  const [rows, pointsRows, pointsToYuanRate, pointsDeductionMaxRate] = await Promise.all([
    pg.query('SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1', [customerUserId]),
    pg.query('SELECT points_balance FROM client_wechat_users WHERE user_id = $1', [customerUserId]),
    getPointsToYuanRate(),
    getPointsDeductionMaxRate(),
  ])

  const pointsBalance = Number(pointsRows[0]?.points_balance) || 0

  if (rows.length === 0) {
    ctx.result = { cardId: null, balance: 0, pointsBalance, pointsToYuanRate, pointsDeductionMaxRate }
    return
  }

  ctx.result = {
    cardId: rows[0].card_id,
    balance: Number(rows[0].balance),
    pointsBalance,
    pointsToYuanRate,
    pointsDeductionMaxRate,
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

  await pg.transaction(async (client) => {
    await client.query(
      `UPDATE client_wechat_users
       SET bound_employee_id = $1, bound_employee_name = $2, updated_at = NOW()
       WHERE user_id = $3`,
      [employeeId, staffRows[0].name || null, clientUserId]
    )
    // Audit log
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

/**
 * 顾客预约记录（顾客档案 Tab）
 * 按 clientUserId|clientPhone 查该顾客全部预约 + store_id scope + 普通员工档案闸门。
 * 顾客已通过档案闸门（普通员工仅见绑定本人的顾客），故不再按 employee_id 过滤预约行，
 * 展示该顾客完整预约历史。
 */
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

/**
 * 顾客手机号变更记录（顾客档案 Tab）
 * 镜像 admin getCustomerPhoneChangeLogs：
 *   auth.rebindPhone（顾客自助换绑，已下线但保留历史） + customer.update(detail.changes 含 phone)
 */
async function phoneChangeLogs(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { clientUserId, clientPhone, page = 1, pageSize = 50 } = ctx.event.payload || {}
  if (!clientUserId && !clientPhone) {
    throw new Error('INVALID_PARAMS: 缺少 clientUserId 或 clientPhone')
  }
  const safePage = Math.max(1, Number(page) || 1)
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 50))
  const offset = (safePage - 1) * safePageSize

  // 手机号变更日志按 client_user_id 关联，先解析 user_id
  let cuid = clientUserId
  if (!cuid && clientPhone) {
    const r = await pg.query(
      'SELECT user_id FROM client_wechat_users WHERE phone = $1 LIMIT 1',
      [clientPhone],
    )
    cuid = r[0]?.user_id
  }
  if (!cuid) { ctx.result = []; return }

  // 档案闸门（门店 scope + 普通员工 bound_employee_id）
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
    LIMIT $2 OFFSET $3
  `, [cuid, safePageSize, offset])

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
    // auth.rebindPhone：operator 为空 + detail.clientUserId 存在 → 顾客自助
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

/**
 * 顾客优惠券（顾客档案「顾客优惠券」Tab）
 *
 * 交易/权益数据跟顾客走：按 client_user_id 查全量 user_coupons（含跨门店、各状态）。
 * 可见性由 assertCustomerProfileVisible 守护：门店 scope + 普通员工仅可见绑定本人的顾客。
 * SQL 镜像 clientApi coupon.list：懒清扫过期 → JOIN 模板 → COALESCE 面值 → 按状态固定序 + 到期升序，
 * 批量解析适用门店/品类名。返回 shape 与 client coupon.list 对齐。
 */
async function coupons(ctx) {
  await requireStaffBound()(ctx, async () => {});

  const payload = ctx.event.payload || {};
  let clientUserId = payload.clientUserId;
  const clientPhone = payload.clientPhone;
  if (!clientUserId && !clientPhone) {
    throw new Error("INVALID_PARAMS: 缺少 clientUserId 或 clientPhone");
  }

  // 手机号 → clientUserId
  if (!clientUserId && clientPhone) {
    const r = await pg.query(
      "SELECT user_id FROM client_wechat_users WHERE phone = $1 LIMIT 1",
      [clientPhone],
    );
    clientUserId = r[0]?.user_id || null;
  }

  // 档案闸门：门店 scope + 普通员工 bound_employee_id。
  // 极端：手机号无对应顾客——无可查之券，直接返回空（杜绝凭手机号越权枚举）。
  if (!clientUserId) {
    ctx.result = { coupons: [] };
    return;
  }
  await assertCustomerProfileVisible(pg, ctx.auth, clientUserId);

  // 懒清扫过期券（系统无 cron 批量置过期，查询前顺手扫，保证「已过期」准确）
  await pg.query(
    `UPDATE user_coupons SET status = '已过期'
     WHERE user_id = $1 AND status = '未使用' AND expire_at <= NOW()`,
    [clientUserId],
  );

  const coupons = await pg.query(
    `SELECT
       uc.coupon_id, uc.status, uc.expire_at, uc.used_at, uc.created_at,
       uc.used_sale_order_id, uc.template_id,
       ct.name, ct.coupon_type,
       COALESCE(uc.face_value_override, ct.discount_value) AS discount_value,
       ct.min_spend,
       ct.applicable_category_ids, ct.applicable_store_ids,
       ct.description
     FROM user_coupons uc
     JOIN coupon_templates ct ON uc.template_id = ct.template_id
     WHERE uc.user_id = $1
     ORDER BY
       CASE uc.status
         WHEN '未使用' THEN 0
         WHEN '已使用' THEN 1
         WHEN '已过期' THEN 2
       END,
       uc.expire_at ASC`,
    [clientUserId],
  );

  // 批量解析适用门店名
  const storeIds = new Set();
  for (const c of coupons) {
    if (c.applicable_store_ids) for (const id of c.applicable_store_ids) storeIds.add(id);
  }
  const storeNameMap = {};
  if (storeIds.size > 0) {
    const storeRows = await pg.query(
      "SELECT store_id, store_name FROM stores WHERE store_id = ANY($1)",
      [Array.from(storeIds)],
    );
    for (const r of storeRows) storeNameMap[r.store_id] = r.store_name;
  }

  // 批量解析适用品类名
  const categoryIds = new Set();
  for (const c of coupons) {
    if (c.applicable_category_ids) for (const id of c.applicable_category_ids) categoryIds.add(id);
  }
  const categoryNameMap = {};
  if (categoryIds.size > 0) {
    const catRows = await pg.query(
      "SELECT category_id, category_name FROM product_categories WHERE category_id = ANY($1)",
      [Array.from(categoryIds)],
    );
    for (const r of catRows) categoryNameMap[r.category_id] = r.category_name;
  }

  ctx.result = {
    coupons: coupons.map((c) => ({
      couponId: c.coupon_id,
      templateId: c.template_id,
      name: c.name,
      couponType: c.coupon_type,
      discountValue: c.discount_value,
      minSpend: c.min_spend,
      status: c.status,
      expireAt: c.expire_at,
      usedAt: c.used_at,
      usedSaleOrderId: c.used_sale_order_id,
      createdAt: c.created_at,
      description: c.description,
      applicableStoreNames: c.applicable_store_ids
        ? c.applicable_store_ids.map((id) => storeNameMap[id] || id)
        : null,
      applicableCategoryNames: c.applicable_category_ids
        ? c.applicable_category_ids.map((id) => categoryNameMap[id] || id)
        : null,
    })),
  };
}

module.exports = { search, calendar, detail, paidOrders, homeProducts, orderHistory, serviceHistory, stats, listByTag, refundHistory, searchPromoterEmployees, updateProfile, updateName, updateNotes, assign, customerBalance, appointments, phoneChangeLogs, coupons };
