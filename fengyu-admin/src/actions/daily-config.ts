'use server'
import { randomUUID } from 'node:crypto'
import { db } from '@/db'
import { dailyOperatingPeriods, dailyOperatingPeriodStores, dailyOperatingPeriodTemplates, dailyOperatingPeriodOverrides, dailyOperatingTargets, dailyPkClasses, dailyPkStores, dailyReports } from '@db/daily-report'
import { stores, orgNodes } from '@db/org'
import { staffWechatUsers } from '@db/user'
import { operationLogs } from '@db/operation-log'
import { and, eq, ne, lte, gte, or, desc, sql, isNull } from 'drizzle-orm'
import { withPermission } from '@/lib/with-permission'
import { requireAdmin } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'
import { dailyPeriodInput, dailyPkInput, dailyPeriodTemplateInput, type DailyPeriodInput, type DailyPkInput, type DailyPeriodTemplateInput } from '@/lib/daily-config'
import { buildDailyPeriod, defaultDailyCyclePattern, patternFromPeriod } from '@/lib/daily-period-template'
import { revalidatePath } from 'next/cache'

export const getDailyConfiguration = withPermission('system:config', async (session) => {
  requireAdmin(session)
  // 例外：经营月份按日期倒序，门店按名称，便于经营配置选择。
  const [periods, templates, overrides, periodStores, classes, assignments, storeRows, members, nodes, logs] = await Promise.all([
    db.select().from(dailyOperatingPeriods).orderBy(desc(dailyOperatingPeriods.startDate)),
    db.select().from(dailyOperatingPeriodTemplates).orderBy(dailyOperatingPeriodTemplates.regionId),
    db.select().from(dailyOperatingPeriodOverrides),
    db.select().from(dailyOperatingPeriodStores),
    db.select().from(dailyPkClasses), db.select().from(dailyPkStores),
    db.select({ id: stores.storeId, name: stores.storeName, orgNodeId: stores.orgNodeId }).from(stores).orderBy(stores.storeName),
    db.select({ id: staffWechatUsers.employeeId, name: staffWechatUsers.name, storeId: staffWechatUsers.storeId, position: staffWechatUsers.positionName }).from(staffWechatUsers).where(eq(staffWechatUsers.isResigned, false)).orderBy(staffWechatUsers.name),
    db.select({ id: orgNodes.id, name: orgNodes.name, type: orgNodes.type, parentId: orgNodes.parentId }).from(orgNodes),
    db.select({ id: operationLogs.id, action: operationLogs.action, targetId: operationLogs.targetId, operator: operationLogs.operatorName, at: operationLogs.createdAt, detail: operationLogs.detail }).from(operationLogs)
      .where(or(eq(operationLogs.action, 'daily.period.save'), eq(operationLogs.action, 'daily.pk.save'), eq(operationLogs.action, 'daily.period_template.save'), eq(operationLogs.action, 'daily.period_override.save'), eq(operationLogs.action, 'daily.period.generate'))).orderBy(desc(operationLogs.createdAt)).limit(30),
  ])
  const area = (orgNodeId: string | null) => {
    const visited = new Set<string>()
    let id = orgNodeId
    while (id && !visited.has(id)) {
      visited.add(id); const node = nodes.find((n) => n.id === id)
      if (!node) break
      if (node.type === '市场') return node.name
      id = node.parentId
    }
    return ''
  }
  const regions = nodes.filter((n) => n.type === '市场').map((n) => ({ id: n.id, name: n.name })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  return { members, logs: logs.map((log) => ({ ...log, at: log.at.toISOString() })), regions,
    templates: templates.map((t) => ({ id: t.id, regionId: t.regionId, name: t.name, pattern: t.pattern, version: t.version })),
    overrides: overrides.map((o) => ({ id: o.id, templateId: o.templateId, regionId: o.regionId, monthKey: o.monthKey, pattern: o.pattern })),
    periodStores: periodStores.map((s) => ({ periodId: s.periodId, storeId: s.storeId })),
    periods: periods.map((p) => ({ id: p.id, name: p.name, start: p.startDate, end: p.endDate, regionId: p.regionId, monthKey: p.monthKey, templateId: p.templateId, templateSource: p.templateSource,
    version: p.version, weeks: p.weeks as DailyPeriodInput['weeks'] })),
    classes: classes.map((c) => ({ id: c.id, name: c.name, periodId: c.periodId })),
    assignments: assignments.map((s) => ({ periodId: s.periodId, storeId: s.storeId, classId: s.classId,
      legion: s.legion, groupName: s.groupName, mentorName: s.mentorName })), stores: storeRows.map((s) => ({ ...s, area: area(s.orgNodeId) })) }
})

export const saveDailyPeriodTemplate = withPermission('system:config', async (session, input: DailyPeriodTemplateInput) => {
  requireAdmin(session)
  const parsed = dailyPeriodTemplateInput.safeParse(input)
  if (!parsed.success) throw Error('INVALID_PARAMS: ' + parsed.error.issues[0].message)
  const template = parsed.data
  const checkMonth = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7)
  buildDailyPeriod(checkMonth, template.pattern, 'template-preview')
  if (template.regionId) {
    const [region] = await db.select({ id: orgNodes.id }).from(orgNodes).where(and(eq(orgNodes.id, template.regionId), eq(orgNodes.type, '市场')))
    if (!region) throw Error('INVALID_PARAMS: 区域不存在或不是市场节点')
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('daily-period-template',0))`)
    const [old] = await tx.select().from(dailyOperatingPeriodTemplates).where(eq(dailyOperatingPeriodTemplates.id, template.id)).for('update')
    if ((old?.version ?? 0) !== template.version) throw Error('CONFLICT: 周期模板已变更，请刷新')
    if (old && old.regionId !== template.regionId) throw Error('INVALID_PARAMS: 周期模板所属区域不可变更')
    if (!template.regionId && !old) {
      const [globalTemplate] = await tx.select({ id: dailyOperatingPeriodTemplates.id }).from(dailyOperatingPeriodTemplates).where(isNull(dailyOperatingPeriodTemplates.regionId)).limit(1)
      if (globalTemplate) throw Error('CONFLICT: 全局默认模板已存在，请选择全局模板进行修改')
    }
    const values = { regionId: template.regionId, name: template.name, pattern: template.pattern, updatedAt: new Date() }
    if (old) await tx.update(dailyOperatingPeriodTemplates).set({ ...values, version: old.version + 1 }).where(eq(dailyOperatingPeriodTemplates.id, template.id))
    else await tx.insert(dailyOperatingPeriodTemplates).values({ id: template.id, ...values })
    await logOperation(session, 'daily.period_template.save', 'daily_operating_period_templates', template.id,
      { before: old || null, after: template }, tx)
  })
  revalidatePath('/settings/daily')
  return { success: true }
})

export const createDailyPeriodsForMonth = withPermission('system:config', async (session, monthKey: string) => {
  requireAdmin(session)
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) throw Error('INVALID_PARAMS: 请选择有效归属月')
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('daily-period-config',0))`)
    const [global] = await tx.select().from(dailyOperatingPeriodTemplates).where(sql`${dailyOperatingPeriodTemplates.regionId} IS NULL`).limit(1)
    const markets = await tx.select({ id: orgNodes.id, name: orgNodes.name }).from(orgNodes).where(eq(orgNodes.type, '市场'))
    if (!global && markets.length === 0) throw Error('INVALID_STATE: 请先保存全局经营周期模板')
    const regionList = markets.length ? markets : [{ id: null as unknown as string, name: '' }]
    const result = []
    for (const region of regionList) {
      const existing = await tx.select({ id: dailyOperatingPeriods.id }).from(dailyOperatingPeriods).where(and(eq(dailyOperatingPeriods.monthKey, monthKey), region.id ? eq(dailyOperatingPeriods.regionId, region.id) : sql`${dailyOperatingPeriods.regionId} IS NULL`))
      if (existing.length) { result.push(...existing.map((r) => r.id)); continue }
      const [specific] = region.id ? await tx.select().from(dailyOperatingPeriodTemplates).where(eq(dailyOperatingPeriodTemplates.regionId, region.id)) : []
      const template = specific || global
      if (!template) throw Error(`INVALID_STATE: ${region.name || '全局'}未配置可用周期模板`)
      const [override] = await tx.select().from(dailyOperatingPeriodOverrides).where(and(eq(dailyOperatingPeriodOverrides.templateId, template.id), eq(dailyOperatingPeriodOverrides.monthKey, monthKey), region.id ? eq(dailyOperatingPeriodOverrides.regionId, region.id) : isNull(dailyOperatingPeriodOverrides.regionId))).limit(1)
      const [globalOverride] = !override && region.id ? await tx.select().from(dailyOperatingPeriodOverrides).where(and(eq(dailyOperatingPeriodOverrides.templateId, template.id), eq(dailyOperatingPeriodOverrides.monthKey, monthKey), isNull(dailyOperatingPeriodOverrides.regionId))).limit(1) : []
      const monthOverride = override || globalOverride
      const pattern = (monthOverride?.pattern || template.pattern || defaultDailyCyclePattern) as any
      const id = `dp-${monthKey}-${region.id || 'global'}-${randomUUID().slice(0, 8)}`
      const period = buildDailyPeriod(monthKey, pattern, id)
      await tx.insert(dailyOperatingPeriods).values({ id, name: period.name, startDate: period.start, endDate: period.end, weeks: period.weeks,
        regionId: region.id, monthKey, templateId: template.id, templateSource: monthOverride ? 'month-override' : specific ? 'region-template' : 'global-template' })
      if (region.id) {
        const result = await tx.execute(sql`WITH RECURSIVE descendants AS (
          SELECT id FROM org_nodes WHERE id=${region.id}
          UNION ALL SELECT n.id FROM org_nodes n JOIN descendants d ON n.parent_id=d.id
        ) SELECT s.store_id AS "storeId" FROM stores s WHERE s.org_node_id IN (SELECT id FROM descendants)`)
        const assignedStores = ((result as { rows?: { storeId: string }[] }).rows || [])
        if (assignedStores.length) await tx.insert(dailyOperatingPeriodStores).values(assignedStores.map((s) => ({ periodId: id, storeId: s.storeId })))
      }
      await logOperation(session, 'daily.period.generate', 'daily_operating_periods', id,
        { monthKey, regionId: region.id, templateId: template.id, templateSource: monthOverride ? 'month-override' : specific ? 'region-template' : 'global-template', after: period }, tx)
      result.push(id)
    }
    return { ids: result }
  })
})

export const previewDailyPeriod = withPermission('system:config', async (session, input: DailyPeriodInput) => {
  requireAdmin(session)
  const parsed = dailyPeriodInput.safeParse(input)
  if (!parsed.success) throw Error('INVALID_PARAMS: ' + parsed.error.issues[0].message)
  const p = parsed.data
  const [old] = await db.select().from(dailyOperatingPeriods).where(eq(dailyOperatingPeriods.id, p.id))
  if ((old?.version ?? 0) !== p.version) throw Error('CONFLICT: 经营周期已变更，请刷新')
  const periodStores = old?.regionId ? await db.select({ storeId: dailyOperatingPeriodStores.storeId }).from(dailyOperatingPeriodStores).where(eq(dailyOperatingPeriodStores.periodId, old.id)) : []
  const storeIds = periodStores.map((s) => s.storeId)
  const [reports, targets, classes] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(dailyReports).where(and(
      old?.regionId ? sql`${dailyReports.storeId}=ANY(${storeIds}::text[])` : undefined,
      or(and(gte(dailyReports.reportDate, p.start), lte(dailyReports.reportDate, p.end)),
        old ? and(gte(dailyReports.reportDate, old.startDate), lte(dailyReports.reportDate, old.endDate)) : undefined))),
    db.select({ count: sql<number>`count(*)::int` }).from(dailyOperatingTargets).where(eq(dailyOperatingTargets.periodId, p.id)),
    db.select({ count: sql<number>`count(*)::int` }).from(dailyPkClasses).where(eq(dailyPkClasses.periodId, p.id)),
  ])
  const previous = old?.weeks as DailyPeriodInput['weeks'] | undefined
  return { reports: reports[0].count, targets: targets[0].count, classes: classes[0].count,
    changes: p.weeks.map((week, index) => ({ name: week.name,
      before: previous?.[index] ? `${previous[index].start} 至 ${previous[index].end}` : '尚未配置',
      after: `${week.start} 至 ${week.end}` })).filter((change) => change.before !== change.after) }
})

export const saveDailyPeriod = withPermission('system:config', async (session, input: DailyPeriodInput, saveAsOverride = false) => {
  requireAdmin(session)
  const parsed = dailyPeriodInput.safeParse(input)
  if (!parsed.success) throw Error('INVALID_PARAMS: ' + parsed.error.issues[0].message)
  const p = parsed.data
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('daily-period-config',0))`)
    const [old] = await tx.select().from(dailyOperatingPeriods).where(eq(dailyOperatingPeriods.id, p.id)).for('update')
    if ((old?.version ?? 0) !== p.version) throw Error('CONFLICT: 经营周期已变更，请刷新')
    if (saveAsOverride && (!old?.templateId || !old.monthKey)) throw Error('INVALID_STATE: 该经营月尚无模板来源，请先生成模板经营月')
    const sameRegion = old?.regionId ? eq(dailyOperatingPeriods.regionId, old.regionId) : isNull(dailyOperatingPeriods.regionId)
    const [overlap] = await tx.select({ id: dailyOperatingPeriods.id }).from(dailyOperatingPeriods).where(and(
      ne(dailyOperatingPeriods.id, p.id), sameRegion, lte(dailyOperatingPeriods.startDate, p.end), gte(dailyOperatingPeriods.endDate, p.start)))
    if (overlap) throw Error('INVALID_PARAMS: 经营月份不可重叠')
    if (old && JSON.stringify((old.weeks as DailyPeriodInput['weeks']).map((w) => w.id)) !== JSON.stringify(p.weeks.map((w) => w.id)))
      throw Error('INVALID_PARAMS: 已建周期只能调整周名称与日期，不能更换周编号')
    const values = { name: p.name, startDate: p.start, endDate: p.end, weeks: p.weeks, templateSource: saveAsOverride ? 'month-override' : 'manual', updatedAt: new Date() }
    if (old) await tx.update(dailyOperatingPeriods).set({ ...values, version: old.version + 1 }).where(eq(dailyOperatingPeriods.id, p.id))
    else await tx.insert(dailyOperatingPeriods).values({ id: p.id, ...values })
    if (saveAsOverride && old?.templateId && old.monthKey) {
      const pattern = patternFromPeriod(p, old.monthKey)
      const regionCondition = old.regionId ? eq(dailyOperatingPeriodOverrides.regionId, old.regionId) : isNull(dailyOperatingPeriodOverrides.regionId)
      const key = and(eq(dailyOperatingPeriodOverrides.templateId, old.templateId), eq(dailyOperatingPeriodOverrides.monthKey, old.monthKey), regionCondition)
      const [override] = await tx.select().from(dailyOperatingPeriodOverrides).where(key).for('update')
      const id = override?.id || `dpo-${randomUUID()}`
      if (override) await tx.update(dailyOperatingPeriodOverrides).set({ pattern, createdBy: session.employeeId, updatedAt: new Date() }).where(eq(dailyOperatingPeriodOverrides.id, id))
      else await tx.insert(dailyOperatingPeriodOverrides).values({ id, templateId: old.templateId, regionId: old.regionId, monthKey: old.monthKey, pattern, createdBy: session.employeeId })
      await logOperation(session, 'daily.period_override.save', 'daily_operating_period_overrides', `${old.templateId}:${old.regionId || 'global'}:${old.monthKey}`, { before: override || null, after: pattern }, tx)
    }
    await logOperation(session, 'daily.period.save', 'daily_operating_periods', p.id,
      { before: old ? { name: old.name, start: old.startDate, end: old.endDate, weeks: old.weeks } : null, after: p }, tx)
  })
  revalidatePath('/settings/daily'); return { success: true }
})

export const saveDailyPk = withPermission('system:config', async (session, input: DailyPkInput) => {
  requireAdmin(session)
  const parsed = dailyPkInput.safeParse(input)
  if (!parsed.success) throw Error('INVALID_PARAMS: ' + parsed.error.issues[0].message)
  const p = parsed.data
  await db.transaction(async (tx) => {
    const [period] = await tx.select().from(dailyOperatingPeriods).where(eq(dailyOperatingPeriods.id, p.periodId)).for('update')
    if (!period || period.version !== p.expectedVersion) throw Error('CONFLICT: 经营周期已变更，请刷新')
    // 行锁与目标保存共享周期版本；PK修改也递增，阻止两个配置界面互相覆盖。
    const validStores = await tx.select({ id: stores.storeId }).from(stores)
    if (p.stores.some((s) => !validStores.some((v) => v.id === s.storeId))) throw Error('INVALID_PARAMS: 门店不存在')
    if (period.regionId) {
      const allowed = await tx.select({ storeId: dailyOperatingPeriodStores.storeId }).from(dailyOperatingPeriodStores).where(eq(dailyOperatingPeriodStores.periodId, p.periodId))
      if (p.stores.some((s) => !allowed.some((v) => v.storeId === s.storeId))) throw Error('PERMISSION_DENIED: 该门店不属于本经营月区域快照')
    }
    const before = { stores: await tx.select().from(dailyPkStores).where(eq(dailyPkStores.periodId, p.periodId)),
      classes: await tx.select().from(dailyPkClasses).where(eq(dailyPkClasses.periodId, p.periodId)) }
    await tx.delete(dailyPkStores).where(eq(dailyPkStores.periodId, p.periodId))
    await tx.delete(dailyPkClasses).where(eq(dailyPkClasses.periodId, p.periodId))
    if (p.classes.length) await tx.insert(dailyPkClasses).values(p.classes.map((c) => ({ ...c, periodId: p.periodId })))
    if (p.stores.length) await tx.insert(dailyPkStores).values(p.stores.map((s) => ({ ...s, periodId: p.periodId })))
    await tx.update(dailyOperatingPeriods).set({ version: period.version + 1, updatedAt: new Date() }).where(eq(dailyOperatingPeriods.id, p.periodId))
    await logOperation(session, 'daily.pk.save', 'daily_pk_classes', p.periodId, { before, after: p }, tx)
  })
  revalidatePath('/settings/daily'); return { success: true }
})
