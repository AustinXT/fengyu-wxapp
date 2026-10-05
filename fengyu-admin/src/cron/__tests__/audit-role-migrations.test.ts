import { vi, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
vi.mock('../lib/notify', () => ({ notifyOps: vi.fn() }))
import { notifyOps } from '../lib/notify'
import { auditRoleMigrations } from '../steps/audit-role-migrations'
it('仅明确调店未闭环且超3天告警，不修改角色或员工', async () => {
  const db = { execute: vi.fn().mockResolvedValueOnce([{ employee_id: 'E', event_id: '1', binding_id: 5 }]).mockResolvedValue([]) }
  await expect(auditRoleMigrations(db as any)).resolves.toEqual({ overdueBindings: 1 })
  const dialect = new PgDialect()
  const queries = db.execute.mock.calls.map(([q]) => dialect.sqlToQuery(q).sql)
  expect(queries[0]).toContain("manual_review_required")
  expect(queries[0]).toContain("interval '3 days'")
  expect(queries[0]).toContain('permission.scopeReview.completed')
  expect(queries.join()).not.toMatch(/UPDATE|DELETE/)
  expect(notifyOps).toHaveBeenCalled()
})
it('无逾期待办时零日志/通知', async () => {
  vi.mocked(notifyOps).mockClear()
  const db = { execute: vi.fn().mockResolvedValue([]) }
  await expect(auditRoleMigrations(db as any)).resolves.toEqual({ overdueBindings: 0 })
  expect(db.execute).toHaveBeenCalledTimes(1)
  expect(notifyOps).not.toHaveBeenCalled()
})
