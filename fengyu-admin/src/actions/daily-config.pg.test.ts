import { describe, it, expect, vi, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AuthSession } from '@/lib/types'
const state = vi.hoisted(() => {
  const url = process.env.DAILY_TEST_DATABASE_URL
  if (url) {
    const parsed = new URL(url)
    const local = ['localhost', '127.0.0.1'].includes(parsed.hostname) && parsed.pathname === '/test'
    const temporary = parsed.hostname === '101.34.242.103' && parsed.port === '8151' && /^daily_regression_[a-f0-9]{24}$/.test(parsed.pathname.slice(1)) && process.env.DAILY_TEST_TEMP_DB === parsed.pathname.slice(1)
    if (!local && !temporary) throw Error('Only an isolated test database is allowed')
    process.env.E2E_DATABASE_URL = url
  }
  return { url, session: null as AuthSession | null }
})
vi.mock('@/lib/auth', () => ({ getSession: async () => state.session }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { getDailyConfiguration, previewDailyPeriod, saveDailyPeriod, saveDailyPk, saveDailyPeriodTemplate, previewDailyMonths, prepareDailyMonths, restoreDailyGlobalRule, saveDailyCycleModes } from './daily-config'
import { defaultDailyCyclePattern } from '@/lib/daily-period-template'
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
    p = { id, name: id, start: '2040-03-01', end: '2040-03-28', version: 0,
      weeks: [0, 1, 2, 3].map((n) => ({ id: 'w' + (n + 1), name: '周' + (n + 1), start: '2040-03-' + String(n * 7 + 1).padStart(2, '0'), end: '2040-03-' + String(n * 7 + 7).padStart(2, '0') })) }
  })
  it('非法边界拒绝；创建预览与写入、审计一致', async () => {
    await expect(saveDailyPeriod({ ...p, weeks: p.weeks.map((w, i) => i === 1 ? { ...w, start: '2040-03-09' } : w) })).rejects.toThrow('连续')
    const preview = await previewDailyPeriod(p)
    expect(preview).toMatchObject({ reports: 0, targets: 0, classes: 0 })
    expect(preview.changes).toHaveLength(5)
    expect(preview.changes[1]).toEqual({ name: '周1', before: '尚未配置', after: '2040-03-01 至 2040-03-07' })
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
    expect(config.members.find((member) => member.id === employeeId)?.storeId).toBe(storeId)
    expect(config.stores.find((store) => store.id === storeId)?.area).toBe('日报配置测试市场')
    expect(config.logs.some((log) => log.targetId === '2040-03' && log.action === 'daily.pk.save')).toBe(true)
    const logs = await db.execute(sql`SELECT * FROM operation_logs WHERE target_id=${'2040-03'} AND action='daily.pk.save'`)
    expect(logs).toHaveLength(1)
  })
  it('准备三个月、幂等、预览版本冲突及恢复总部规则保留旧月份', async () => {
    const globalId = id + 'global', marketId = id + 'special'
    const template = { id: globalId, regionId: null, name: '总部规则', pattern: defaultDailyCyclePattern, version: 0 }
    await saveDailyPeriodTemplate(template)
    await saveDailyPeriodTemplate({ ...template, id: marketId, regionId: id + 'market', name: '市场规则' })
    const first = await previewDailyMonths('2041-01', 3)
    expect(first.rows).toHaveLength(3)
    expect(first.rows.every(r => r.action === 'create')).toBe(true)
    const made = await prepareDailyMonths('2041-01', 3, first.revision)
    expect(made.created).toBe(3)
    expect(made.ids.every(value => value.length <= 30)).toBe(true)
    await expect(prepareDailyMonths('2041-01', 3, first.revision)).rejects.toThrow('重新预览')
    const again = await previewDailyMonths('2041-01', 3)
    expect(await prepareDailyMonths('2041-01', 3, again.revision)).toMatchObject({ created: 0, kept: 3 })
    const beforeRestore = await getDailyConfiguration()
    const firstMonth = beforeRestore.periods.find(period => period.id === made.ids[0])!
    await saveDailyPeriod({ ...firstMonth, weeks: firstMonth.weeks.map((week, index) => index === 0 ? { ...week, name: '特殊周名' } : week) }, true, true)
    const stale = await previewDailyMonths('2041-04', 1)
    await restoreDailyGlobalRule(marketId, 1)
    await expect(prepareDailyMonths('2041-04', 1, stale.revision)).rejects.toThrow('重新预览')
    const next = await previewDailyMonths('2041-04', 1)
    expect(next.rows[0]).toMatchObject({ templateId: globalId, source: 'global-template' })
    const config = await getDailyConfiguration()
    expect(config.templates.some(t => t.id === marketId)).toBe(true)
    expect(config.disabledTemplateIds).toContain(marketId)
    expect(config.overrides.some(o => o.templateId === marketId)).toBe(true)
    expect(config.periods.find(period => period.id === firstMonth.id)?.weeks[0].name).toBe('特殊周名')
    const legacy = await previewDailyMonths('2040-03', 1)
    expect(legacy.rows[0]).toMatchObject({ action: 'keep', period: { id } })
    expect(await prepareDailyMonths('2040-03', 1, legacy.revision)).toMatchObject({ created: 0, kept: 1 })
    await expect(saveDailyPeriod({ ...p, version: 3 }, false, true, true)).rejects.toThrow('业务关联')
    expect(config.periods.filter(period => made.ids.includes(period.id))).toHaveLength(3)
    expect(config.periods.find(period => period.id === id)?.version).toBe(3)
    const blocked = await previewDailyMonths('2000-01', 3)
    await expect(prepareDailyMonths('2000-01', 3, blocked.revision)).rejects.toThrow('INVALID_STATE')
    expect((await getDailyConfiguration()).periods).toHaveLength(config.periods.length)
  })
  it('共享模式批量分配、改用总部及并发版本保护，旧日期与月份例外不改写', async () => {
    const second = id + 'market2'
    await db.execute(sql`INSERT INTO org_nodes(id,name,type,parent_id) VALUES(${second},'第二测试市场','市场',${id})`)
    const before = await getDailyConfiguration()
    const pattern = structuredClone(defaultDailyCyclePattern)
    pattern.weeks[0].end.day = 5; pattern.weeks[1].start.day = 6
    const shared = { id: 'shared', name: '两市场共用', isDefault: false, regionIds: [id + 'market', second], pattern }
    const modes = [...before.cycleModes.filter(m => m.isDefault), shared]
    await saveDailyCycleModes(modes, before.modesRevision)
    await expect(saveDailyCycleModes(modes, before.modesRevision)).rejects.toThrow('CONFLICT')
    const saved = await getDailyConfiguration()
    expect(saved.cycleModes.find(m => m.id === 'shared')?.regionIds.sort()).toEqual([id + 'market', second].sort())
    for (const regionId of shared.regionIds) expect(saved.templates.find(t => t.regionId === regionId)?.pattern).toEqual(pattern)
    expect(saved.periods).toEqual(before.periods)
    expect(saved.overrides).toEqual(before.overrides)
    expect(saved.assignments).toEqual(before.assignments)
    await expect(saveDailyCycleModes([...modes, { ...shared, id: 'duplicate', name: '重复分配' }], saved.modesRevision)).rejects.toThrow('同一市场')
    await saveDailyCycleModes(saved.cycleModes.filter(m => m.isDefault), saved.modesRevision)
    const restored = await getDailyConfiguration()
    expect(restored.templates).toHaveLength(saved.templates.length)
    expect(restored.overrides).toEqual(before.overrides)
    expect(restored.periods).toEqual(before.periods)
    const future = await previewDailyMonths('2042-01', 1)
    expect(future.rows.every(row => row.source === 'global-template')).toBe(true)
    await expect(saveDailyPeriodTemplate({ ...restored.templates[0], pattern: defaultDailyCyclePattern })).rejects.toThrow('周期模式')
    const legacyTemplate = restored.templates.find(t => t.regionId === id + 'market')!
    await expect(restoreDailyGlobalRule(legacyTemplate.id, legacyTemplate.version)).rejects.toThrow('周期模式')
  })
  it.skipIf(process.env.DAILY_CYCLE_FULL !== '1')('完整周期：可变周约束、生效规则、按月例外、批量生成及安全更新', async () => {
    const before = await getDailyConfiguration()
    const base = before.cycleModes.find(m => m.isDefault)!
    const point = (day: number) => ({ monthOffset: 0 as const, day })
    const five = { start: point(1), end: point(31), weeks: [[1,6],[7,12],[13,18],[19,24],[25,31]].map(([a,b], i) => ({ id: 'w' + i, name: '第' + (i+1) + '周', start: point(a), end: point(b) })) }
    const one = { ...five, weeks: [{ id: 'whole', name: '整月', start: point(1), end: point(31) }] }
    await saveDailyCycleModes([{ ...base, pattern: five, monthly: { '2042-01': one }, effectiveFrom: '2042-01-01' }], before.modesRevision)
    const config = await getDailyConfiguration()
    const older = await previewDailyMonths('2041-12', 1, base.id)
    expect(older.rows.every(r => r.period?.start.endsWith('-26'))).toBe(true)
    const plan = await previewDailyMonths('2042-01', 2, base.id)
    expect(plan.rows.every(r => r.action === 'create')).toBe(true)
    expect(plan.rows.filter(r => r.monthKey === '2042-01').every(r => r.period?.weeks.length === 1)).toBe(true)
    expect(plan.rows.filter(r => r.monthKey === '2042-02').every(r => r.period?.weeks.length === 5 && r.period.end === '2042-02-28')).toBe(true)
    const made = await prepareDailyMonths('2042-01', 2, plan.revision, base.id)
    expect(made.created).toBe(4)
    const repeated = await previewDailyMonths('2042-01', 2, base.id)
    expect(repeated.rows.every(r => r.action === 'keep')).toBe(true)
    const changed = [{ ...config.cycleModes[0], monthly: { ...config.cycleModes[0].monthly, '2042-01': five }, effectiveFrom: '2042-01-01' }]
    const impact = await saveDailyCycleModes(changed, config.modesRevision, '', true)
    await saveDailyCycleModes(changed, config.modesRevision, impact.automatic.token)
    const first = repeated.rows[0].period!
    expect((await getDailyConfiguration()).periods.find(p => p.id === first.id)?.weeks).toHaveLength(5)
    await expect(db.execute(sql`INSERT INTO daily_operating_periods(id,name,start_date,end_date,weeks) VALUES('bad-empty','bad','2050-01-01','2050-01-31','[]'::jsonb)`)).rejects.toThrow()
    await db.execute(sql`INSERT INTO daily_operating_periods(id,name,start_date,end_date,weeks) VALUES('max-weeks','max','2050-01-01','2050-01-31',${JSON.stringify(Array.from({length:31}, () => ({})))}::jsonb)` )
    await expect(db.execute(sql`INSERT INTO daily_operating_periods(id,name,start_date,end_date,weeks) VALUES('too-many','bad','2051-01-01','2051-01-31',${JSON.stringify(Array.from({length:32}, () => ({})))}::jsonb)`)).rejects.toThrow()
  }, 30000)
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
