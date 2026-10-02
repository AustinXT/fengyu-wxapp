import { describe, it, expect, vi, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AuthSession } from '@/lib/types'
const state = vi.hoisted(() => {
  const url = process.env.DAILY_TEST_DATABASE_URL
  if (url) {
    const parsed = new URL(url)
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== '/test') throw Error('Only localhost/test is allowed')
    process.env.E2E_DATABASE_URL = url
  }
  return { url, session: null as AuthSession | null }
})
vi.mock('@/lib/auth', () => ({ getSession: async () => state.session }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { getDailyConfiguration, previewDailyPeriod, saveDailyPeriod, saveDailyPk } from './daily-config'
import type { DailyPeriodInput } from '@/lib/daily-config'

describe.skipIf(!state.url)('日报配置真实PG，权限、版本、周期和审计事务', () => {
  const id = 'dc' + randomUUID().slice(0, 8), employeeId = id + 'employee', storeId = id + 'store'
  let p: DailyPeriodInput
  it('只有具备配置动作的超管能读写', async () => {
    state.session = { employeeId, name: '日报配置测试', phone: '', roles: [{ role: 'manager', scopeId: id, scopeType: '总部', isSuperAdmin: false }], permissions: { actions: ['system:config'], scopeStoreIds: [] } }
    await expect(getDailyConfiguration()).rejects.toThrow('仅系统管理员')
    state.session.permissions.actions = []
    await expect(getDailyConfiguration()).rejects.toThrow('无权执行')
    state.session.roles = [{ role: 'admin', scopeId: id, scopeType: '总部', isSuperAdmin: true }]
    state.session.permissions.actions = ['system:config']
    await db.execute(sql`INSERT INTO org_nodes(id,name,type) VALUES(${id},'日报配置测试','总部')`)
    await db.execute(sql`INSERT INTO org_nodes(id,name,type,parent_id) VALUES(${id + 'market'},'日报配置测试市场','市场',${id})`)
    await db.execute(sql`INSERT INTO org_nodes(id,name,type,parent_id) VALUES(${id + 'node'},'日报配置测试店','门店',${id + 'market'})`)
    await db.execute(sql`INSERT INTO stores(store_id,store_name,org_node_id) VALUES(${storeId},${'日报配置测试店-' + id},${id + 'node'})`)
    await db.execute(sql`INSERT INTO staff_wechat_users(employee_id,name,store_id) VALUES(${employeeId},'日报配置测试',${storeId})`)
    p = { id, name: id, start: '2001-03-01', end: '2001-03-28', version: 0,
      weeks: [0, 1, 2, 3].map((n) => ({ id: 'w' + (n + 1), name: '周' + (n + 1), start: '2001-03-' + String(n * 7 + 1).padStart(2, '0'), end: '2001-03-' + String(n * 7 + 7).padStart(2, '0') })) }
  })
  it('非法边界拒绝；创建预览与写入、审计一致', async () => {
    await expect(saveDailyPeriod({ ...p, weeks: p.weeks.map((w, i) => i === 1 ? { ...w, start: '2001-03-09' } : w) })).rejects.toThrow('连续')
    expect(await previewDailyPeriod(p)).toEqual({ reports: 0, targets: 0, classes: 0 })
    await saveDailyPeriod(p)
    const rows = await db.execute(sql`SELECT * FROM operation_logs WHERE target_id=${id} AND action='daily.period.save'`)
    expect(rows.length).toBe(1)
    p.version = 1
    await expect(saveDailyPeriod({ ...p, id: id + 'overlap', version: 0 })).rejects.toThrow('不可重叠')
  })
  it('两个周期编辑只允许一个成功，不能改已有周编号', async () => {
    await expect(saveDailyPeriod({ ...p, weeks: p.weeks.map((w, i) => i === 0 ? { ...w, id: 'changed' } : w) })).rejects.toThrow('不能更换周编号')
    const results = await Promise.allSettled([saveDailyPeriod({ ...p, name: '版本A' }), saveDailyPeriod({ ...p, name: '版本B' })])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    p.version = 2
  })
  it('每店只进一班；无效门店回滚；PK并发不能互相覆盖', async () => {
    const input = { periodId: id, expectedVersion: 2, classes: [{ id: id + 'class', name: '一班' }],
      stores: [{ storeId, classId: id + 'class', legion: '', groupName: '', mentorName: '' }] }
    await expect(saveDailyPk({ ...input, stores: [...input.stores, ...input.stores] })).rejects.toThrow('每店同月')
    await expect(saveDailyPk({ ...input, stores: [{ ...input.stores[0], storeId: 'nonexistent-' + id }] })).rejects.toThrow('门店不存在')
    const result = await Promise.allSettled([saveDailyPk(input), saveDailyPk(input)])
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const config = await getDailyConfiguration()
    expect(config.assignments.filter((s) => s.periodId === id)).toHaveLength(1)
    expect(config.periods.find((period) => period.id === id)?.version).toBe(3)
    const logs = await db.execute(sql`SELECT * FROM operation_logs WHERE target_id=${id} AND action='daily.pk.save'`)
    expect(logs).toHaveLength(1)
  })
  afterAll(async () => {
    await db.execute(sql`DELETE FROM daily_pk_stores WHERE period_id=${id}`)
    await db.execute(sql`DELETE FROM daily_pk_classes WHERE period_id=${id}`)
    await db.execute(sql`DELETE FROM daily_operating_periods WHERE id=${id}`)
    await db.execute(sql`DELETE FROM operation_logs WHERE target_id=${id}`)
    // 独立临时库统一销毁；保留组织/门店触发器生成的库存主体。
    const globalDb = globalThis as unknown as { pgClient?: { end: () => Promise<void> } }
    await globalDb.pgClient?.end()
  })
})
