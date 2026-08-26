/**
 * 异步导出任务的公共契约。
 *
 * 这里不依赖数据库、Node API 或 Server Action，允许客户端仅以类型形式引用。
 */

export const EXPORT_JOB_TYPES = [
  'orders',
  'refunds',
  'allocation-sales',
  'allocation-services',
  'services',
  'customers',
  'employees',
  'points',
  'cards',
  'inventory-stocks',
  'products',
  'mall-products',
  'coupons',
  'data-center',
] as const

export type ExportJobType = (typeof EXPORT_JOB_TYPES)[number]

/** 自定义 window 事件名：export-button 创建新任务时触发，export-tasks-menu 监听刷新。 */
export const EXPORT_JOB_CREATED_EVENT = 'export-job-created' as const

export const EXPORT_JOB_STATUSES = [
  'queued',
  'running',
  'ready',
  'empty',
  'failed',
  'expired',
] as const

export type ExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number]

export const DATA_CENTER_EXPORT_VIEWS = [
  'sales-market',
  'sales-store',
  'customer-market-reg',
  'customer-market-ops',
  'customer-store-reg',
  'customer-store-ops',
  'product-market',
  'product-store',
  'efficiency-market',
  'efficiency-staff',
  'efficiency-store-ranking',
  'efficiency-staff-ranking',
] as const

export type DataCenterExportView = (typeof DATA_CENTER_EXPORT_VIEWS)[number]

export type ExportQueryPayload = Record<string, string>

export interface DataCenterExportPayload {
  view: DataCenterExportView
  params: ExportQueryPayload
  /** 排名榜导出时指定一个指标；普通明细不传。 */
  metric?: string
}

export type ExportJobPayload = ExportQueryPayload | DataCenterExportPayload

export type CreateExportJobInput =
  | {
      exportType: Exclude<ExportJobType, 'data-center'>
      payload: ExportQueryPayload
    }
  | {
      exportType: 'data-center'
      payload: DataCenterExportPayload
    }

export interface ExportJobListItem {
  id: number
  exportType: ExportJobType
  label: string
  status: ExportJobStatus
  rowCount: number | null
  sheetCount: number | null
  fileName: string | null
  errorMessage: string | null
  createdAt: string
  completedAt: string | null
  expiresAt: string | null
}

export const EXPORT_PERMISSION_BY_TYPE: Record<ExportJobType, string> = {
  orders: 'sale_order:list',
  refunds: 'sale_order:refund_create',
  'allocation-sales': 'sale_order:list',
  'allocation-services': 'service:list',
  services: 'service:list',
  customers: 'customer:list',
  employees: 'employee:list',
  points: 'point_transaction:list',
  cards: 'sale_item:list',
  'inventory-stocks': 'inventory:export',
  products: 'product:list',
  'mall-products': 'product:list',
  coupons: 'coupon:list',
  'data-center': 'data_center:dashboard',
}

export const EXPORT_PERMISSION_ACTIONS = Array.from(
  new Set(Object.values(EXPORT_PERMISSION_BY_TYPE)),
)

export const EXPORT_LABEL_BY_TYPE: Record<ExportJobType, string> = {
  orders: '订单明细',
  refunds: '退款明细',
  'allocation-sales': '营业额分配-销售提成',
  'allocation-services': '营业额分配-服务提成',
  services: '服务单明细',
  customers: '顾客列表',
  employees: '员工列表',
  points: '积分流水',
  cards: '疗程卡列表',
  'inventory-stocks': '库存明细',
  products: '商品管理',
  'mall-products': '商城商品',
  coupons: '优惠券模板',
  'data-center': '数据中心',
}

export function exportJobLabel(
  exportType: ExportJobType,
  payload?: ExportJobPayload,
): string {
  if (exportType !== 'data-center' || !payload || !('view' in payload)) {
    return EXPORT_LABEL_BY_TYPE[exportType]
  }

  const viewLabels: Record<DataCenterExportView, string> = {
    'sales-market': '销售明细-按市场',
    'sales-store': '销售明细-按门店',
    'customer-market-reg': '客量明细-市场注册客活',
    'customer-market-ops': '客量明细-市场消费经营',
    'customer-store-reg': '客量明细-门店注册客活',
    'customer-store-ops': '客量明细-门店消费经营',
    'product-market': '品项明细-按市场',
    'product-store': '品项明细-按门店',
    'efficiency-market': '人效明细-按市场',
    'efficiency-staff': '人效明细-按技师',
    'efficiency-store-ranking': '人效-门店排名榜',
    'efficiency-staff-ranking': '人效-员工排名榜',
  }
  return viewLabels[payload.view as DataCenterExportView]
}
