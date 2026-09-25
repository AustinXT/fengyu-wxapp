/**
 * 经营明细报表登记表（#367）：路由、标题、筛选形态、权限组合的唯一来源。
 * 页面、菜单、面包屑、页面权限覆盖守护、loading.tsx 守护都从这里读，新增报表只改这一处。
 *
 * 权限：顾客明细类 / 员工提成类页面要求「dashboard + 专用权限点」由同一条角色授权同时提供
 * （`withAllPermissions`）；一览表与主表沿用 `data_center:dashboard`。
 * `data_center:dashboard` 本身不改——staff 小程序和 fengyu-analyst 都依赖它。
 *
 * 纯常量模块（菜单等 client 代码也会引用），不得 import 任何带 DB / server 依赖的模块。
 */
import type { ReportPeriodKind } from './report-page'

export const DATA_CENTER_DASHBOARD_ACTION = 'data_center:dashboard'
export const DATA_CENTER_CUSTOMER_DETAIL_ACTION = 'data_center:customer_detail'
export const DATA_CENTER_STAFF_COMMISSION_ACTION = 'data_center:staff_commission'

export const DATA_CENTER_CUSTOMER_DETAIL_ACTIONS = [
  DATA_CENTER_DASHBOARD_ACTION,
  DATA_CENTER_CUSTOMER_DETAIL_ACTION,
] as const

export const DATA_CENTER_STAFF_COMMISSION_ACTIONS = [
  DATA_CENTER_DASHBOARD_ACTION,
  DATA_CENTER_STAFF_COMMISSION_ACTION,
] as const

export interface DataCenterReport {
  path: string
  title: string
  periodKind: ReportPeriodKind
  /** 全部满足（AND）。页面 SSR 闸门、菜单 requiredAllActions 与此一致。 */
  requiredActions: readonly string[]
  /**
   * 侧边栏入口（挂在「数据中心」下，按 section 分段）。下钻子页没有此项。
   * `enabled: false` = 骨架已就绪、页面内容未交付：路由可访问、菜单不显示；页面单合入时改为 true。
   */
  menu?: { section: DataCenterMenuSection; enabled: boolean }
  /** 下钻子页：不进菜单，面包屑挂在父页之下（值为父页在 DATA_CENTER_REPORTS 里的 key，reports.test 校验存在）。 */
  parent?: string
}

/** 「数据中心」菜单分段：原 4 板块归「看板」；原型的「经营数据」「员工收入」一级菜单改为分段小标题。 */
export const DATA_CENTER_MENU_SECTIONS = ['看板', '经营明细', '员工收入'] as const
export type DataCenterMenuSection = (typeof DATA_CENTER_MENU_SECTIONS)[number]

export const DATA_CENTER_REPORTS = {
  dailyOverview: {
    path: '/data-center/daily-overview',
    title: '日常数据一览表',
    periodKind: 'range',
    requiredActions: [DATA_CENTER_DASHBOARD_ACTION],
    menu: { section: '经营明细', enabled: false },
  },
  customerFrequency: {
    path: '/data-center/customer-frequency',
    title: '顾客频率表',
    periodKind: 'month',
    requiredActions: DATA_CENTER_CUSTOMER_DETAIL_ACTIONS,
    menu: { section: '经营明细', enabled: false },
  },
  remainingCards: {
    path: '/data-center/remaining-cards',
    title: '顾客剩余卡项清单',
    periodKind: 'none',
    requiredActions: DATA_CENTER_CUSTOMER_DETAIL_ACTIONS,
    menu: { section: '经营明细', enabled: false },
  },
  operatingMaster: {
    path: '/data-center/operating-master',
    title: '经营数据主表',
    periodKind: 'month',
    requiredActions: [DATA_CENTER_DASHBOARD_ACTION],
    menu: { section: '经营明细', enabled: true },
  },
  commissionDaily: {
    path: '/data-center/commission-daily',
    title: '员工提成日报',
    periodKind: 'month',
    requiredActions: DATA_CENTER_STAFF_COMMISSION_ACTIONS,
    menu: { section: '员工收入', enabled: false },
  },
  commissionDetail: {
    path: '/data-center/commission-daily/detail',
    title: '提成明细',
    periodKind: 'month',
    requiredActions: DATA_CENTER_STAFF_COMMISSION_ACTIONS,
    parent: 'commissionDaily',
  },
} as const satisfies Record<string, DataCenterReport>

export type DataCenterReportKey = keyof typeof DATA_CENTER_REPORTS

export const DATA_CENTER_REPORT_LIST: ReadonlyArray<DataCenterReport & { key: DataCenterReportKey }> =
  (Object.keys(DATA_CENTER_REPORTS) as DataCenterReportKey[]).map((key) => ({ key, ...DATA_CENTER_REPORTS[key] }))
