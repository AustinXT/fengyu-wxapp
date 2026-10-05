import { describe, it, expect, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { createRequire } from 'node:module'
import { assertMembershipBinding } from './membership-binding'
import { ApiError } from './api-error'
import { businessErrorMessage } from './action-error'
const require = createRequire(import.meta.url)
const siblings = [
  require('../../../fengyu-client/cloudfunctions/clientApi/utils/membership-binding'),
  require('../../../fengyu-staff/cloudfunctions/staffApi/utils/membership-binding'),
]
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
describe('首次入会人工归属三端同义', () => {
  it.each([
    { customer_type: '流量客', became_member_at: null, has_binding: true },
    { customer_type: '会员客', became_member_at: null, has_binding: false },
    { customer_type: '小美客', became_member_at: '2026-08-01', has_binding: false },
  ])('已指定/存量会员放行，查询谓词、参数与锁强度同义 %#', async (customer) => {
    const execute = vi.fn().mockResolvedValue([customer])
    await assertMembershipBinding({ execute } as never, 'customer-1')
    const sql = new PgDialect().sqlToQuery(execute.mock.calls[0][0])
    for (const sibling of siblings) {
      const query = vi.fn().mockResolvedValue({ rows: [customer] })
      await sibling.assertMembershipBinding({ query }, 'customer-1')
      expect(normalize(sql.sql)).toBe(normalize(query.mock.calls[0][0]))
      expect(sql.params).toEqual(query.mock.calls[0][1])
    }
  })
  it('未指定拒绝，机器原因在data，用户消息不包含子标签', async () => {
    const execute = vi.fn().mockResolvedValue([{ customer_type: '流量客', has_binding: false }])
    const error = await assertMembershipBinding({ execute } as never, 'customer-1').catch(e => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.prefix).toBe('INVALID_STATE')
    expect(error.data).toEqual({ reason: 'MEMBERSHIP_BINDING_REQUIRED' })
    expect(businessErrorMessage(error, "付款失败")).toBe('请先由店长分配所属员工，再完成入会付款')
  })
  it('顾客已删除拒绝', async () => {
    await expect(assertMembershipBinding({ execute: vi.fn().mockResolvedValue([]) } as never, 'missing')).rejects.toThrow('NOT_FOUND')
  })
})
