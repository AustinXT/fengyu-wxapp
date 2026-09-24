/**
 * 经营明细报表的专用权限组合（#367）。页面闸门、取数 Server Action、菜单、导出视图共用这一份。
 *
 * 顾客明细类 / 员工提成类页面要求「dashboard + 专用权限点」由同一条角色授权同时提供
 * （`withAllPermissions`）；一览表与主表沿用 `data_center:dashboard`。
 * `data_center:dashboard` 本身不改——staff 小程序和 fengyu-analyst 都依赖它。
 *
 * 不能放进 actions 文件：'use server' 模块只允许导出 async 函数。
 */
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
