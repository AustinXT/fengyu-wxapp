// Organization
export interface OrgNode {
  id: string
  name: string
  type: 'headquarters' | 'market' | 'store' | 'department'
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

export type PositionScope = 'headquarters' | 'market' | 'store'

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

export type ProductKind = '福利活动' | '护理项目' | '家居产品' | '充值卡'
export type ProductType = '疗程卡' | '单品' | '院装产品'
export type OrderStatus = '待支付' | '待确认收款' | '已支付' | '已完成' | '支付失败' | '已关闭' | '待审批'
export type SaleOrderType = '普通' | '体验' | '内部' | '福利活动' | '回款' | '转换' | '退款'
export type PaymentMethod = 'wechat' | 'alipay' | 'offline'
export type OrderSource = 'client' | 'staff' | 'admin'
export type ServiceOrderStatus = '待服务' | '服务中' | '已完成' | '已取消'
export type ServiceOrderType = '普通' | '体验'
export type AppointmentStatus = '待确认' | '已确认' | '已完成' | '已取消' | '已关闭'
export type SalesCategory = '自采自销' | '他销自耗' | '他销他耗' | '生态合作'
export type AllocationStatus = 'pending' | 'allocated'
export type ItemDirection = 'purchase' | 'convert_out' | 'convert_in' | 'refund_out'
export type CouponType = '现金券' | '项目券' | '折扣券'
export type CouponStatus = '未使用' | '已使用' | '已过期'
export type RoleType = 'admin' | 'manager' | 'finance' | 'hr' | 'product' | 'customer_mgr' | 'staff'

export interface ProductCategory {
  categoryId: string
  categoryName: string
  productKind: ProductKind
  sortOrder: number
  isValid: boolean
  createdAt: string
  updatedAt: string
}

export interface Product {
  productId: string
  categoryId: string
  name: string
  coverImage: string | null
  detailImages: string[] | null
  description: string | null
  isShengmei: boolean | null
  isBundle: boolean
  price: string
  specialPrice: string | null
  salesCategory: SalesCategory | null
  manageScope: string | null
  marketScope: string | null
  sortOrder: number
  validStart: string | null
  validEnd: string | null
  createdAt: string
  updatedAt: string
  // joined
  categoryName?: string
  productKind?: ProductKind
  skuCount?: number
}

export interface ProductSku {
  skuId: string
  productId: string
  productType: ProductType
  specName: string
  price: string
  specialPrice: string | null
  sessionCount: number | null
  isBundleSku: boolean
  sortOrder: number
  serviceFee: string
  validStart: string | null
  validEnd: string | null
  createdAt: string
  updatedAt: string
}

export interface SaleOrder {
  saleOrderId: string
  status: OrderStatus
  saleOrderType: SaleOrderType
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
  isVoid: boolean
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
    scopeType: 'headquarters' | 'market' | 'store'
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
