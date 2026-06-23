// Organization
export interface OrgNode {
  id: string
  name: string
  type: '总部' | '市场' | '门店' | '部门'
  parentId: string | null
  sortOrder: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface Store {
  storeId: string
  storeName: string
  orgNodeId: string | null
  openingDate: string | null
  bedCount: number | null
  isClosed: boolean
  /** 闭店日期（YYYY-MM-DD）；NULL 表示在营。与 isClosed 双写一致 */
  closedAt: string | null
  coverImage: string | null
  images: string[] | null
  district: string | null
  streetAddress: string | null
  latitude: string | null
  longitude: string | null
  phone: string | null
  businessHours: string | null
  description: string | null
  announcement: string | null
  parkingInfo: string | null
  /** 拉卡拉聚合支付：门店在拉卡拉侧的商户号（来自关联商户 lakala_merchants 的快照） */
  lakalaMerchantNo: string | null
  /** 拉卡拉聚合支付：门店在拉卡拉侧的终端号（store-level 独立配置） */
  lakalaTermNo: string | null
  /** 关联拉卡拉商户 ID（N:1，stores.lakala_merchant_id；arch-007） */
  lakalaMerchantId: string | null
  /** 是否开启拉卡拉真实支付通道；false=回 mock 兜底，true=走 special_create */
  lakalaEnabled: boolean
  createdAt: string
  updatedAt: string
  // joined
  marketName?: string
}

export interface Employee {
  employeeId: string
  openid: string | null
  phone: string | null
  name: string | null
  gender: string | null
  idCard: string | null
  storeId: string | null
  orgNodeId: string | null
  positionName: string | null
  /** 头像 URL（cloud:// 或 https://；通过 image-upload 组件 toHttpUrl 渲染） */
  avatarUrl: string | null
  birthday: string | null
  skills: string[] | null
  /** 是否缴纳社保；默认否 */
  socialInsurance: boolean
  isResigned: boolean
  /** 入职日期（YYYY-MM-DD） */
  hiredAt: string | null
  /** 请假开始时间（墙钟 YYYY-MM-DD HH:mm:ss）；与 leaveEnd 成对，请假期间顾客端不可预约 */
  leaveStart: string | null
  /** 请假结束时间（墙钟 YYYY-MM-DD HH:mm:ss） */
  leaveEnd: string | null
  /** 是否出差支援；true 时可被本门店外的开单 / 营业额分配选中（跨门店共享），每日 03:00 cron 重置 */
  isOnBusinessTrip: boolean
  /** 离职日期（YYYY-MM-DD）；NULL 表示在职。与 isResigned 双写一致 */
  resignedAt: string | null
  /** 离职原因（自由文本）；NULL 表示在职或未填 */
  resignationReason: string | null
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
  // joined
  storeName?: string
  departmentName?: string
  marketName?: string
}

export interface Customer {
  userId: string
  openid: string | null
  phone: string | null
  customerId: string | null
  name: string | null
  gender: string | null
  boundStoreId: string | null
  boundEmployeeId: string | null
  /** 临时跨门店标记（需求21）；true 时可被非绑定门店的店长开单（跨店临时消费），每日 03:00 cron 重置 */
  isCrossStoreTemp: boolean
  memberLevel: string | null
  /** 最近一次升级时间（ISO 字符串） */
  memberLevelUpgradedAt: string | null
  /** 保级截止时间（ISO 字符串）；NULL 或 ≤now 表示保级期已过 */
  memberLevelLockedUntil: string | null
  customerSource: string | null
  promoterEmployeeId: string | null
  customerType: string
  spendingTier: string
  monthlyActivity: string | null
  customerStatus: string | null
  birthday: string | null
  occupation: string | null
  isMarried: boolean | null
  wechatName: string | null
  skinType: string | null
  improvementFocus: string | null
  skinIssue: string | null
  wellnessPreference: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
  // joined
  storeName?: string
  employeeName?: string
  promoterName?: string
  marketName?: string
}

/** 积分流水 */
export interface PointTransaction {
  id: number
  userId: string
  type: string
  amount: number
  refOrderId: string | null
  createdAt: string
  // joined
  customerName: string | null
  customerPhone: string | null
  memberLevel: string | null
  storeId: string | null
  storeName: string | null
  marketName: string | null
}

/** 积分流水汇总统计 */
export interface PointTransactionSummary {
  totalEarn: number
  totalSpend: number
  netChange: number
  txnCount: number
  userCount: number
}

/** 充值卡流水 */
export interface AdminCardTransaction {
  id: number
  cardId: string
  userId: string
  type: '充值' | '扣款'
  amount: number
  balance: number
  refOrderId: string | null
  createdAt: string
  // joined
  customerName: string | null
  customerPhone: string | null
  memberLevel: string | null
  /**
   * 顾客当前绑定门店（近似"卡账户所属门店"）。
   * 自 2026-04-24 prepaid_cards.store_id 被 DROP 后，储值卡跨店共享，
   * 此字段退回为 `client_wechat_users.bound_store_id`，可能为 null。
   */
  storeId: string | null
  storeName: string | null
  marketName: string | null
}

/** 充值卡流水汇总统计 */
export interface CardTransactionSummary {
  totalRecharge: number
  totalDeduct: number
  netChange: number
  txnCount: number
  userCount: number
}

export interface SkillTag {
  id: string
  name: string
  sortOrder: number
  isValid: boolean
  createdAt: string
  updatedAt: string
}

/**
 * 品项一级分类名称。完全数据库驱动，由 `product_categories WHERE productKind IS NULL`
 * 行决定，运营在 admin "品项分类 → 品项一级分类管理" 内增删。
 *
 * 不再用字面量联合类型——4/17 会议要求拆分护理项目→招牌/王牌/明星，未来还会变化。
 */
export type ProductKind = string
export type ProductType = '疗程卡' | '家居产品'
export type OrderStatus = '待支付' | '已支付' | '已完成' | '支付失败' | '已关闭' | '待审批' | '部分支付'
/**
 * 销售单据类型（saleOrders.sale_order_type）
 *
 * 2026-04-26 sale-order-domain-refactor 重构：5 → 3 值
 * 删除：'回款单'（迁至 sale_order_payments[change_type='回款']）
 *       '退款单'（迁至 sale_order_payments[change_type='退款', amount<0]）
 * 2026-05-18 B5：+'寄存单'（WorkFine 剩余次数初始化，金额维度不入统计，
 *       次数维度可生成 service_orders 核销）
 */
export type SaleOrderType = '销售单' | '内部单' | '转换单' | '寄存单'
export type PaymentMethod = '微信' | '支付宝' | '线下' | '无'
export type ServiceOrderStatus = '待服务' | '服务中' | '待客户确认' | '已完成' | '已取消'
export type ServiceOrderType = '售前' | '售后'
export type AppointmentStatus = '待确认' | '已确认' | '已完成' | '已取消' | '已关闭'
export type SalesCategory = '自销自耗' | '他销自耗' | '他销他耗' | '生态合作'
export type AllocationStatus = '待分配' | '已分配'
export type ItemDirection = '购买' | '转出' | '转入' | '退出'
export type CouponType = '现金券' | '品项券' | '折扣券'
export type CouponStatus = '未使用' | '已使用' | '已过期'
export type RoleType = 'admin' | 'manager' | 'finance' | 'hr' | 'product' | 'customer_mgr' | 'staff'

/** 角色中文名（全局唯一权威定义，所有展示/错误提示均引用此常量） */
export const ROLE_LABELS: Record<RoleType, string> = {
  admin: '系统管理员',
  manager: '店长',
  finance: '财务',
  hr: '人事',
  product: '商品管理员',
  customer_mgr: '顾客管理员',
  staff: '员工',
}

export interface ProductCategory {
  categoryId: string
  categoryName: string
  productKind: string | null  // null = 一级分类（品项一级分类）
  salesCategory: SalesCategory | null
  sortOrder: number
  isValid: boolean
  /** 一级行的展示色（HEX），二级行 null 时由前端继承父级 */
  displayColor: string | null
  /** 二级行回填：父级一级行的展示色，二级行展示时使用 */
  parentDisplayColor?: string | null
  createdAt: string
  updatedAt: string
}

/** 商城商品（products 表，category_id → mall_categories） */
export interface Product {
  productId: string
  categoryId: string
  name: string
  coverImage: string | null
  detailImages: string[] | null
  description: string | null
  isBundle: boolean
  price: string
  specialPrice: string | null
  manageScope: string | null
  marketScope: string | null
  sortOrder: number
  isVisible: boolean
  createdAt: string
  updatedAt: string
  // joined
  categoryName?: string
  categoryGroup?: string
  skuCount?: number
}

/** SKU（独立实体，category_id → product_categories） */
export interface ProductSku {
  skuId: string
  categoryId: string
  productType: ProductType
  specName: string
  price: string
  specialPrice: string | null
  sessionCount: number | null
  sortOrder: number
  serviceFee: string
  isShengmei: boolean | null
  /**
   * 体验卡 capability 列（与 product_skus.is_experience 同名同义）。
   * 仅在 SKU 编辑/查询表单上下文需要，前端运行时按需读取。
   */
  isExperience?: boolean
  /**
   * 店长特别优惠 capability 列（与 product_skus.is_manager_special 同名同义）。
   * true 时 admin/staff 开单（销售单 + 普通商品）允许店长改应付金额。
   */
  isManagerSpecial?: boolean
  // 充值卡 capability 列已退出（2026-05-20 充值卡剥离 SKU 化，DB 列已 DROP）
  /** 项目系列 lookup id（FK → project_series_lookup.id），null=未设置 */
  projectSeriesId?: number | null
  marketScope: string | null
  isEnabled: boolean
  createdAt: string
  updatedAt: string
  // joined
  categoryName?: string
  productKind?: string
  salesCategory?: SalesCategory | null
  /** 项目系列名称（JOIN project_series_lookup.name） */
  projectSeriesName?: string | null
  bundlePrice?: string | null
  bundleGroupId?: number | null
  groupName?: string | null
}

/** 项目系列字典（lookup 表 project_series_lookup） */
export interface ProjectSeries {
  id: number
  name: string
  sortOrder: number
  isValid: boolean
}

export interface MallBundleGroup {
  id: number
  productId: string
  groupName: string
  pickCount: number | null
  sortOrder: number
  createdAt: string
}

export interface MallCategory {
  categoryId: string
  categoryName: string
  categoryGroup: string | null
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type DocumentType = '售前' | '售后'

export interface SaleOrder {
  saleOrderId: string
  status: OrderStatus
  saleOrderType: SaleOrderType
  documentType: DocumentType | null
  refSaleOrderId: string | null
  /** 历史订单来源标记：'workfine'=WorkFine 历史导入（禁止退款/回款/改实收）；null=系统原生 */
  legacySource: string | null
  marketName: string
  storeId: string
  saleOrderDatetime: string
  clientUserId: string | null
  clientPhone: string | null
  customerName: string | null
  totalAmount: string
  /** 储值卡抵扣金额（抵扣项，不计入实付）；与 received 之和等于 totalAmount */
  prepaidCardAmount: string
  /**
   * 实收金额（聚合 sale_order_payments[change_type∈(首次支付/回款/储值卡抵扣), status='已支付'] 的快照）。
   * 2026-04-26 sale-order-domain-refactor：原 paidAmount 列与 received 重复，已 DROP；统一改用 received。
   */
  received: string
  /** 已退款金额（聚合 sale_order_payments[change_type='退款',status='已支付'] 取负值；2026-04-26 新增） */
  refundedAmount: string
  paymentMethod: PaymentMethod
  openedBy: string | null
  preferredEmployeeId: string | null
  paidAt: string | null
  /** 线下确认收款时间（offline_confirmed_at；订单详情页填充，列表查询不取） */
  offlineConfirmedAt?: string | null
  allocationStatus: AllocationStatus | null
  couponId: string | null
  couponDiscount: string | null
  remark: string | null
  /** 活动单标记（纯标识，不影响金额/提成口径；admin/staff 开单勾选） */
  isActivity?: boolean
  createdAt: string
  updatedAt: string
  // joined
  storeName?: string
  openedByName?: string
  /** 指定美容师姓名（preferred_employee_id → staff_wechat_users.name） */
  preferredEmployeeName?: string
  /** 线下确认人姓名（offline_confirmed_by → staff_wechat_users.name） */
  offlineConfirmedByName?: string
  items?: SaleItem[]
  /** 是否参与营业额分配（仅销售单/转换单且非历史订单）；由 getOrderById 计算注入，控制订单详情页分配入口显隐 */
  allocatable?: boolean
}

export interface SaleItem {
  saleItemId: string
  saleOrderId: string
  itemDirection: ItemDirection
  refSaleItemId: string | null
  skuId: string | null
  sessionCount: number | null
  remainingSessions: number | null
  paidSessions: number | null
  unitPrice: string
  quantity: number
  unitRealPrice: string
  saleAmount: string
  received: string
  /** 待确认实付草稿（开单约定实付，行级；不进 received/paid_sessions，仅展示 + 确认收款入账参考） */
  pendingReceived: string
  expireDate: string | null
  /** 已提货数量（家居产品；picked_up_quantity；订单详情页填充，其它查询不取） */
  pickedUpQuantity?: number | null
  remark: string | null
  salesCategory: SalesCategory | null
  createdAt: string
  updatedAt: string
  // joined
  skuName?: string
  productName?: string
}

export interface SaleAllocation {
  id: number
  saleItemId: string
  employeeId: string
  allocationRatio: string
  roleType?: string
  totalAmount: string
  commissionRate?: string
  commissionAmount?: string
  isVoid: boolean
  createdAt: string
  updatedAt: string
  // joined
  employeeName?: string
  departmentName?: string
  saleItemName?: string
}

export interface ServiceOrder {
  serviceOrderId: string
  status: ServiceOrderStatus
  serviceOrderType: ServiceOrderType
  marketName: string
  storeId: string
  serviceDate: string
  assignedEmployeeId: string
  remark: string | null
  appointmentId: string | null
  clientUserId: string | null
  commissionStatus?: AllocationStatus | null
  createdAt: string
  updatedAt: string
  // joined
  storeName?: string
  employeeName?: string
  customerName?: string
  /** 跨门店只读访问（顾客档案场景）：门店不在当前账号 scope 内 → 仅可查看不可操作 */
  readOnly?: boolean
}

export interface ServiceCommission {
  id: number
  serviceItemId: string
  employeeId: string
  roleType?: string
  allocationRatio?: string
  commissionRate: string
  commissionAmount: string
  isVoid: boolean
  createdAt: string
  updatedAt: string
  // joined
  employeeName?: string
  departmentName?: string
}

export interface Appointment {
  appointmentId: string
  status: AppointmentStatus
  storeId: string
  clientUserId: string
  clientName: string
  employeeId: string | null
  employeeName: string | null
  saleItemId: string | null
  appointmentTime: string
  checkinAt: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
  // joined
  storeName?: string
}

export interface PermissionRole {
  id: number
  employeeId: string
  role: RoleType
  scopeId: string
  createdBy: string | null
  createdAt: string
  updatedAt: string
  // joined
  employeeName?: string
  scopeName?: string
}

export interface CommissionRate {
  id: number
  orgId: string
  orderType: string
  roleType: string
  salesCategory: string
  amountTierMin: string
  amountTierMax: string | null
  commissionRate: string
  createdAt: string
  updatedAt: string
  // joined
  orgName?: string
}

export interface CouponTemplate {
  templateId: string
  name: string
  couponType: CouponType
  discountValue: string
  minSpend: string | null
  maxDiscount: string | null
  totalCount: number | null
  issuedCount: number
  applicableProductIds: string[] | null
  applicableCategoryIds: string[] | null
  applicableStoreIds: string[] | null
  applicableMarketIds: string[] | null
  validityMode: string | null
  validFrom: string | null
  validTo: string | null
  validDays: number | null
  description: string | null
  isActive: boolean | null
  createdAt: string
  updatedAt: string
}

/** 开单时可选用的顾客优惠券（已按订单金额过滤） */
export interface AvailableCoupon {
  couponId: string
  templateId: string
  name: string
  couponType: CouponType
  discountValue: string
  minSpend: string | null
  maxDiscount: string | null
  applicableProductIds: string[] | null
  applicableCategoryIds: string[] | null
  expireAt: string
  /** 针对当前订单金额计算出的实际优惠金额 */
  discountAmount: string
}

/** 批量发券时的顾客选择项 */
export interface BatchCouponCustomer {
  userId: string
  name: string | null
  phone: string | null
  storeName: string | null
  memberLevel: string | null
}

/** 批量发送消息时的顾客选择项 */
export interface BatchMessageCustomer {
  userId: string
  name: string | null
  phone: string | null
  storeName: string | null
  memberLevel: string | null
}

/** 已发放优惠券记录（详情页展示用） */
export interface IssuedCoupon {
  couponId: string
  customerName: string
  phone: string
  status: CouponStatus
  issuedAt: string
  usedAt: string | null
}

export interface OperationLog {
  id: number
  operatorEmployeeId: string | null
  operatorName: string | null
  operatorRole: string | null
  orgNodeId: string | null
  orgNodeName: string | null
  action: string
  targetType: string
  targetId: string
  detail: Record<string, unknown> | null
  source: string | null
  createdAt: string
}

export interface AuthSession {
  employeeId: string
  name: string
  phone: string
  roles: Array<{
    role: RoleType
    scopeId: string
    scopeType: '总部' | '市场' | '门店'
  }>
  permissions: {
    actions: string[]
    scopeStoreIds: string[]
  }
}

// Dashboard
/**
 * 业务角色看板统计（manager/finance）。
 *
 * 2026-04-26 sale-order-domain-refactor 重写 SQL 口径：
 *   - todayVisitors / yesterdayVisitors  ← service_orders[status='已完成'] DISTINCT client_user_id（与 metrics §"客流"对齐）
 *   - todayRevenue / yesterdayRevenue    ← SUM(received - refunded_amount)，已天然冲销退款
 *   - todayPaidAmount / yesterdayPaidAmount ← SUM(received) 毛实收（不扣退款）
 *   - todayRefundedAmount                ← SUM(refunded_amount)，今日已退款金额
 *   - todayOpenedCustomers               ← sale_orders DISTINCT client_user_id（按 sale_order_datetime），辅助"今日开单顾客数"
 *   - 全部 SQL `WHERE sale_order_type IN ('销售单','转换单') AND status='已支付'`
 *   - 时区固定 Asia/Shanghai（与 metrics.md / mgmt-dashboard 对齐）
 */
export interface DashboardStats {
  /** 今日客流（service_orders[已完成] DISTINCT client_user_id） */
  todayVisitors: number
  /** 今日业绩 = SUM(received - refunded_amount)，已扣退款 */
  todayRevenue: number
  /** 今日毛实收 = SUM(received)，不扣退款 */
  todayPaidAmount: number
  /** 今日已退款金额 = SUM(refunded_amount) */
  todayRefundedAmount: number
  /** 今日开单顾客数（sale_orders DISTINCT client_user_id by sale_order_datetime） */
  todayOpenedCustomers: number
  pendingOrders: number
  pendingAllocations: number
  pendingAppointments: number
  activeServices: number
  yesterdayVisitors: number
  /** 昨日业绩（同 todayRevenue 公式） */
  yesterdayRevenue: number
  /** 昨日毛实收（同 todayPaidAmount 公式） */
  yesterdayPaidAmount: number
  /** 全量订单累计实付金额（SUM received，'销售单'+'转换单' + 已支付） */
  totalPaidAmount: number
  /** 角色上下文：决定前端展示哪种看板 */
  roleContext: 'business' | 'admin' | 'hr' | 'product'
  /** admin/hr 角色的系统概览指标 */
  adminStats?: {
    totalStores: number
    totalEmployees: number
    totalProducts: number
    totalCustomers: number
  }
}

// ─── 订单款项流水（sale_order_payments） ───
export type PaymentChangeType = '首次支付' | '回款' | '退款' | '储值卡抵扣'
/**
 * 款项流水状态。2026-04-26 sale-order-domain-refactor 新增 '待审批'（退款审批流）。
 */
export type PaymentFlowStatus = '待支付' | '待审批' | '已支付' | '已作废' | '已退款'
export type PaymentSourceEnd = 'client' | 'staff' | 'admin' | 'notify'

/**
 * 订单款项流水行（与 db/schema/order.ts:saleOrderPayments 对齐）
 *
 * 2026-05-03 子表回收：原 sale_order_payment_details 字段全部并入主表，本接口字段一一对应主表列。
 */
export interface SaleOrderPayment {
  id: number
  saleOrderId: string
  changeType: PaymentChangeType
  /** 金额字符串（numeric），退款为负 */
  amount: string
  /** 流水通道；储值卡抵扣对应 '储值卡' */
  paymentMethod: PaymentMethod | '储值卡'
  externalTxnId: string | null
  status: PaymentFlowStatus
  sourceEnd: PaymentSourceEnd
  operatorEmployeeId: string | null
  note: string | null
  createdAt: string
  paidAt: string | null
  // 可选 join 字段
  operatorName?: string | null
  refundReason?: string | null
  refSaleItemId?: string | null
  sessionCount?: number | null
  auditEmployeeId?: string | null
  auditAt?: string | null
  auditRemark?: string | null
}
