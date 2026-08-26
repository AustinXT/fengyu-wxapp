import { describe, expect, it } from 'vitest'
import {
  EXPORT_PERMISSION_ACTIONS,
  EXPORT_PERMISSIONS_BY_TYPE,
  findExportPermissionAction,
} from './export-job-types'

describe('退款导出权限', () => {
  it('提单权限和审批权限均可授权退款导出', () => {
    expect(EXPORT_PERMISSIONS_BY_TYPE.refunds).toEqual([
      'sale_order:refund_create',
      'sale_order:refund_approve',
    ])
    expect(findExportPermissionAction('refunds', ['sale_order:refund_create']))
      .toBe('sale_order:refund_create')
    expect(findExportPermissionAction('refunds', ['sale_order:refund_approve']))
      .toBe('sale_order:refund_approve')
    expect(findExportPermissionAction('refunds', ['sale_order:list'])).toBeNull()
  })

  it('任务入口权限集合包含退款审批权限', () => {
    expect(EXPORT_PERMISSION_ACTIONS).toContain('sale_order:refund_approve')
  })
})
