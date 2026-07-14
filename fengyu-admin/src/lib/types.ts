
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
  
  lakalaMerchantId: string | null
  createdAt: string
  updatedAt: string
  
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
  
  avatarUrl: string | null
  birthday: string | null
  skills: string[] | null
  
  socialInsurance: boolean
  isResigned: boolean
  
  hiredAt: string | null
  
  leaveStart: string | null
  
  leaveEnd: string | null
  
  isOnBusinessTrip: boolean
  
  resignedAt: string | null
  
  resignationReason: string | null
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
  
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
  
  isCrossStoreTemp: boolean
  memberLevel: string | null
  
  memberLevelUpgradedAt: string | null
  
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
  
  storeName?: string
  employeeName?: string
  promoterName?: string
  marketName?: string
}


export interface PointTransaction {
  id: number
  userId: string
  type: string
  amount: number
  refOrderId: string | null
  createdAt: string
  
  customerName: string | null
  customerPhone: string | null
  memberLevel: string | null
  storeId: string | null
  storeName: string | null
  marketName: string | null
}


export interface PointTransactionSummary {
  totalEarn: number
  totalSpend: number
  netChange: number
  txnCount: number
  userCount: number
}


export interface AdminCardTransaction {
  id: number
  cardId: string
  userId: string
  type: '充值' | '扣款'
  amount: number
  balance: number
  refOrderId: string | null
  createdAt: string
  
  customerName: string | null
  customerPhone: string | null
  memberLevel: string | null
  
  storeId: string | null
  storeName: string | null
  marketName: string | null
}


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


export type ProductKind = string
export type ProductType = '疗程卡' | '家居产品'

export type OrderStatus = '待支付' | '已支付' | '已完成' | '支付失败' | '已关闭' | '待审批' | '部分支付' | '未审核' | '已作废'

export type SaleOrderType = '销售单' | '内部单' | '转换单' | '寄存单' | '充值单'
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
  productKind: string | null  
  salesCategory: SalesCategory | null
  sortOrder: number
  isValid: boolean
  
  displayColor: string | null
  
  parentDisplayColor?: string | null
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
  isBundle: boolean
  price: string
  specialPrice: string | null
  manageScope: string | null
  marketScope: string | null
  sortOrder: number
  isVisible: boolean
  createdAt: string
  updatedAt: string
  
  categoryName?: string
  categoryGroup?: string
  skuCount?: number
}


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
  
  isExperience?: boolean
  
  isManagerSpecial?: boolean
  
  
  projectSeriesId?: number | null
  marketScope: string | null
  isEnabled: boolean
  createdAt: string
  updatedAt: string
  
  categoryName?: string
  productKind?: string
  salesCategory?: SalesCategory | null
  
  projectSeriesName?: string | null
  
  bundlePrice?: string | null
  
  bundleListPrice?: string | null
  bundleGroupId?: number | null
  groupName?: string | null
}


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
  
  unitListPrice: string | null
  
  unitMemberPrice: string | null
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
  
  legacySource: string | null
  marketName: string
  storeId: string
  saleOrderDatetime: string
  clientUserId: string | null
  clientPhone: string | null
  customerName: string | null
  totalAmount: string
  
  prepaidCardAmount: string
  
  received: string
  
  refundedAmount: string
  paymentMethod: PaymentMethod
  openedBy: string | null
  preferredEmployeeId: string | null
  paidAt: string | null
  
  offlineConfirmedAt?: string | null
  allocationStatus: AllocationStatus | null
  couponId: string | null
  couponDiscount: string | null
  remark: string | null
  
  isActivity?: boolean
  
  isMembershipUpgrade?: boolean
  createdAt: string
  updatedAt: string
  
  storeName?: string
  openedByName?: string
  
  preferredEmployeeName?: string
  
  offlineConfirmedByName?: string
  items?: SaleItem[]
  
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
  
  pendingReceived: string
  expireDate: string | null
  
  pickedUpQuantity?: number | null
  remark: string | null
  salesCategory: SalesCategory | null
  createdAt: string
  updatedAt: string
  
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
  
  storeName?: string
  employeeName?: string
  customerName?: string
  
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
  
  discountAmount: string
}


export interface BatchCouponCustomer {
  userId: string
  name: string | null
  phone: string | null
  storeName: string | null
  memberLevel: string | null
}


export interface BatchMessageCustomer {
  userId: string
  name: string | null
  phone: string | null
  storeName: string | null
  memberLevel: string | null
}


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



export interface DashboardStats {
  
  todayVisitors: number
  
  todayRevenue: number
  
  todayPaidAmount: number
  
  todayRefundedAmount: number
  
  todayOpenedCustomers: number
  pendingOrders: number
  pendingAllocations: number
  pendingAppointments: number
  activeServices: number
  yesterdayVisitors: number
  
  yesterdayRevenue: number
  
  yesterdayPaidAmount: number
  
  totalPaidAmount: number
  
  roleContext: 'business' | 'admin' | 'hr' | 'product'
  
  adminStats?: {
    totalStores: number
    totalEmployees: number
    totalProducts: number
    totalCustomers: number
  }
}


export type PaymentChangeType = '首次支付' | '回款' | '退款' | '储值卡抵扣'

export type PaymentFlowStatus = '待支付' | '待审批' | '已支付' | '已作废' | '已退款'
export type PaymentSourceEnd = 'client' | 'staff' | 'admin' | 'notify'


export interface SaleOrderPayment {
  id: number
  saleOrderId: string
  changeType: PaymentChangeType
  
  amount: string
  
  paymentMethod: PaymentMethod | '储值卡'
  externalTxnId: string | null
  status: PaymentFlowStatus
  sourceEnd: PaymentSourceEnd
  operatorEmployeeId: string | null
  note: string | null
  createdAt: string
  paidAt: string | null
  
  operatorName?: string | null
  refundReason?: string | null
  refSaleItemId?: string | null
  sessionCount?: number | null
  auditEmployeeId?: string | null
  auditAt?: string | null
  auditRemark?: string | null
}
