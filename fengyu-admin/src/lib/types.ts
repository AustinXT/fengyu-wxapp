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
  birthday: string | null
  skills: string[] | null
  isResigned: boolean
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
  boundStoreId: string | null
  boundEmployeeId: string | null
  memberLevel: string | null
  customerSource: string | null
  category: string | null
  birthday: string | null
  occupation: string | null
  isMarried: boolean | null
  wechatName: string | null
  skinType: string | null
  improvementFocus: string | null
  skinIssue: string | null
  wellnessPreference: string | null
  createdAt: string
  updatedAt: string
  // joined
  storeName?: string
  employeeName?: string
}

export type PositionScope = '总部' | '市场' | '门店'

export interface Position {
  id: string
  name: string
  scope: PositionScope
  sortOrder: number
  isValid: boolean
  createdAt: string
  updatedAt: string
}

export interface SkillTag {
  id: string
  name: string
  sortOrder: number
  isValid: boolean
  createdAt: string
  updatedAt: string
}

export type ProductKind = string
export type ProductType = '疗程卡' | '单品' | '院装产品'
export type OrderStatus = '待支付' | '待确认收款' | '已支付' | '已完成' | '支付失败' | '已关闭' | '待审批'
export type SaleOrderType = '普通' | '体验' | '内部' | '福利活动' | '回款' | '转换' | '退款'
export type PaymentMethod = '微信' | '支付宝' | '线下'
export type OrderSource = 'client' | 'staff' | 'admin'
export type ServiceOrderStatus = '待服务' | '服务中' | '已完成' | '已取消'
export type ServiceOrderType = '售前' | '售后'
export type AppointmentStatus = '待确认' | '已确认' | '已完成' | '已取消' | '已关闭'
export type SalesCategory = '自采自销' | '他销自耗' | '他销他耗' | '生态合作'
export type AllocationStatus = '待分配' | '已分配'
export type ItemDirection = '购买' | '转出' | '转入' | '退出'
export type CouponType = '现金券' | '项目券' | '折扣券'
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
  productKind: string | null  // null = 一级分类（品项类型）
  salesCategory: SalesCategory | null
  sortOrder: number
  isValid: boolean
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
  isEnabled: boolean
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
  marketScope: string | null
  isEnabled: boolean
  createdAt: string
  updatedAt: string
  // joined
  categoryName?: string
  productKind?: ProductKind
  salesCategory?: SalesCategory | null
  bundlePrice?: string | null
  bundleGroupId?: number | null
  groupName?: string | null
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
  marketName: string
  storeId: string
  saleOrderDatetime: string
  clientUserId: string | null
  clientPhone: string | null
  customerName: string | null
  totalAmount: string
  paymentMethod: PaymentMethod
  saleOrderSource: OrderSource
  openedBy: string | null
  preferredEmployeeId: string | null
  paidAt: string | null
  allocationStatus: AllocationStatus | null
  couponId: string | null
  couponDiscount: string | null
  remark: string | null
  createdAt: string
  updatedAt: string
  // joined
  storeName?: string
  openedByName?: string
  items?: SaleItem[]
}

export interface SaleItem {
  saleItemId: string
  saleOrderId: string
  itemDirection: ItemDirection
  refSaleItemId: string | null
  skuId: string | null
  sessionCount: number | null
  remainingSessions: number | null
  unitPrice: string
  quantity: number
  unitRealPrice: string
  saleAmount: string
  received: string
  expireDate: string | null
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
  isVoid: boolean
  createdAt: string
  updatedAt: string
  // joined
  employeeName?: string
  departmentName?: string
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
  employeeId: string
  employeeName: string
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
  operatorEmployeeId: string
  operatorName: string
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
export interface DashboardStats {
  todayVisitors: number
  todayRevenue: number
  pendingOrders: number
  pendingAllocations: number
  pendingAppointments: number
  activeServices: number
  yesterdayVisitors: number
  yesterdayRevenue: number
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
