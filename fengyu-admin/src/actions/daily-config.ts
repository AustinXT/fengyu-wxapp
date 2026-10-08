'use server'
import { createHash, randomUUID } from 'node:crypto'
import { db } from '@/db'
import { dailyOperatingPeriods, dailyOperatingPeriodStores, dailyOperatingPeriodTemplates, dailyOperatingPeriodOverrides, dailyOperatingTargets, dailyPkClasses, dailyPkStores, dailyReports } from '@db/daily-report'
import { systemConfigs } from '@db/system-config'
import { stores, orgNodes } from '@db/org'
import { staffWechatUsers } from '@db/user'
import { operationLogs } from '@db/operation-log'
import { and, eq, ne, lte, gte, or, desc, sql, isNull, inArray } from 'drizzle-orm'
import { withPermission } from '@/lib/with-permission'
import { requireAdmin } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'
import { dailyPeriodInput, dailyPkInput, dailyPeriodTemplateInput, type DailyPeriodInput, type DailyPkInput, type DailyPeriodTemplateInput } from '@/lib/daily-config'
import { validateDailyCyclePattern, patternFromPeriod, buildDailyPeriod } from '@/lib/daily-period-template'
import { inheritedTemplatesKey, inheritedTemplateIds, planDailyMonths, monthRange, periodMonth } from '@/lib/daily-cycle-planner'
import { cycleModesKey, cycleHistoryKey, cycleModesInput, readCycleModes, upgradeCycleModes, readCycleHistory, type CycleMode } from '@/lib/daily-cycle-modes'
import { automaticCalendar, calendarQuery } from '@/lib/daily-calendar-service'
import { calendarData, calendarPlan, calendarMonth, calendarToday, calendarRule, calendarPeriod, ensureCalendar } from '@/lib/daily-calendar-auto'
import { revalidatePath } from 'next/cache'
import { effectivePeriod } from '@/lib/daily-effective-period'

export const getDailyConfiguration = withPermission('system:config', async (session) => {
  requireAdmin(session)
  // 配置查看只读，月份安排在预览确认后应用。
  // 例外：经营月份按日期倒序，门店按名称，便于经营配置选择。
  const [periods, templates, overrides, periodStores, classes, assignments, storeRows, members, nodes, logs, inheritance] = await Promise.all([
    db.select().from(dailyOperatingPeriods).orderBy(desc(dailyOperatingPeriods.startDate)),
    db.select().from(dailyOperatingPeriodTemplates).orderBy(dailyOperatingPeriodTemplates.regionId),
    db.select().from(dailyOperatingPeriodOverrides),
    db.select().from(dailyOperatingPeriodStores),
    db.select().from(dailyPkClasses), db.select().from(dailyPkStores),
    db.select({ id: stores.storeId, name: stores.storeName, orgNodeId: stores.orgNodeId }).from(stores).orderBy(stores.storeName),
    db.select({ id: staffWechatUsers.employeeId, name: staffWechatUsers.name, storeId: staffWechatUsers.storeId, position: staffWechatUsers.positionName }).from(staffWechatUsers).where(eq(staffWechatUsers.isResigned, false)).orderBy(staffWechatUsers.name),
    db.select({ id: orgNodes.id, name: orgNodes.name, type: orgNodes.type, parentId: orgNodes.parentId }).from(orgNodes),
    db.select({ id: operationLogs.id, action: operationLogs.action, targetId: operationLogs.targetId, operator: operationLogs.operatorName, at: operationLogs.createdAt, detail: operationLogs.detail }).from(operationLogs)
      .where(or(eq(operationLogs.action, 'daily.period.save'), eq(operationLogs.action, 'daily.pk.save'), eq(operationLogs.action, 'daily.period_template.save'), eq(operationLogs.action, 'daily.period_override.save'), eq(operationLogs.action, 'daily.period.generate'), eq(operationLogs.action, 'daily.period_template.inherit'), eq(operationLogs.action, 'daily.cycle_modes.save'))).orderBy(desc(operationLogs.createdAt)).limit(30),
    db.select().from(systemConfigs).where(or(eq(systemConfigs.key, inheritedTemplatesKey), eq(systemConfigs.key, cycleModesKey), eq(systemConfigs.key, cycleHistoryKey))),
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
  const disabledTemplateIds = inheritedTemplateIds(inheritance.find(c => c.key === inheritedTemplatesKey)?.value)
  const modeValue = inheritance.find(c => c.key === cycleModesKey)?.value
  const historyValue = inheritance.find(c => c.key === cycleHistoryKey)?.value
  return { cycleModes: upgradeCycleModes(templates, disabledTemplateIds, regions.map(r => r.id), overrides, modeValue), modesRevision: cycleRevision(templates, disabledTemplateIds, modeValue, historyValue), disabledTemplateIds, members, logs: logs.map((log) => ({ ...log, at: log.at.toISOString() })), regions,
    templates: templates.map((t) => ({ id: t.id, regionId: t.regionId, name: t.name, pattern: t.pattern, version: t.version })),
    overrides: overrides.map((o) => ({ id: o.id, templateId: o.templateId, regionId: o.regionId, monthKey: o.monthKey, pattern: o.pattern })),
    periodStores: periodStores.map((s) => ({ periodId: s.periodId, storeId: s.storeId })),
    periods: periods.map((p) => ({ id: p.id, name: p.name, start: p.startDate, end: p.endDate, regionId: p.regionId, monthKey: p.monthKey, templateId: p.templateId, templateSource: p.templateSource,
    version: p.version, weeks: p.weeks as DailyPeriodInput['weeks'] })),
    classes: classes.map((c) => ({ id: c.id, name: c.name, periodId: c.periodId })),
    assignments: assignments.map((s) => ({ periodId: s.periodId, storeId: s.storeId, classId: s.classId,
      legion: s.legion, groupName: s.groupName, mentorName: s.mentorName })), stores: storeRows.map((s) => ({ ...s, area: area(s.orgNodeId) })) }
})

function cycleRevision(templates: { id: string; version: number; pattern: unknown; regionId: string | null; name: string }[], disabled: string[], raw?: string | null, history?: string | null) {
  return createHash('sha256').update(JSON.stringify({ templates: templates.slice().sort((a, b) => a.id.localeCompare(b.id)), disabled: disabled.slice().sort(), raw: raw || null, history: history || null })).digest('hex')
}

export const saveDailyCycleModes = withPermission('system:config', async (session, input: CycleMode[], expectedRevision: string, confirmation: string = '', previewOnly: boolean = false, range?: { from: string; to: string; modeId: string }) => {
  requireAdmin(session)
  const parsed = cycleModesInput.safeParse(input)
  if (!parsed.success) throw Error('INVALID_PARAMS: ' + parsed.error.issues[0].message)
  const modes = parsed.data
  for (const mode of modes) {
    try { validateDailyCyclePattern(mode.pattern) }
    catch { throw Error(`INVALID_PARAMS: ${mode.name}：经营周须连续覆盖经营月，相邻月份须连续，请检查日期`) }
  }
  for (const mode of modes) for (const [month, pattern] of Object.entries(mode.monthly || {})) {
    try { buildDailyPeriod(month, pattern, 'preview') }
    catch { throw Error(`INVALID_PARAMS: ${mode.name} ${month}：经营周须连续覆盖该月`) }
  }
  const automatic = await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('daily-period-config',0))`)
    const templates = await tx.select().from(dailyOperatingPeriodTemplates)
    const configs = await tx.select().from(systemConfigs).where(or(eq(systemConfigs.key, cycleModesKey), eq(systemConfigs.key, inheritedTemplatesKey), eq(systemConfigs.key, cycleHistoryKey)))
    const disabled = inheritedTemplateIds(configs.find(c => c.key === inheritedTemplatesKey)?.value)
    const raw = configs.find(c => c.key === cycleModesKey)?.value
    const historyRaw = configs.find(c => c.key === cycleHistoryKey)?.value
    if (typeof expectedRevision !== 'string' || expectedRevision !== cycleRevision(templates, disabled, raw, historyRaw))
      throw Error('CONFLICT: 周期模式已变更，请刷新后重新编辑')
    const regions = await tx.select({ id: orgNodes.id }).from(orgNodes).where(eq(orgNodes.type, '市场'))
    if (modes.some(m => m.regionIds.some(id => !regions.some(r => r.id === id)))) throw Error('INVALID_PARAMS: 适用市场不存在')
    const oldOverrides = await tx.select().from(dailyOperatingPeriodOverrides)
    const previousModes = upgradeCycleModes(templates, disabled, regions.map(r => r.id), oldOverrides, raw)
    const draft = range ? await previewDraftCalendar(tx, modes, previousModes, range, expectedRevision) : null
    const special = draft ? draft.changes : await planSpecialMonths(tx, modes, previousModes)
    const token = draft?.token || createHash('sha256').update(JSON.stringify({expectedRevision, modes, special})).digest('hex')
    if (previewOnly) return { calendar: draft?.calendar || null, created: 0, keptMonths: [] as string[], boundaries: [] as {market:string;month:string|null}[], impact: special.map(({before, after, market, month, reports, targets, classes, requiresConfirmation}) => ({requiresConfirmation,market, month, before: before ? {start:before.startDate,end:before.endDate,weeks:before.weeks as DailyPeriodInput['weeks']} : null, after, reports, targets, classes})), token }
    if (draft && draft.calendar.issues.length) throw Error('INVALID_PARAMS: ' + draft.calendar.issues[0].message)
    if ((draft || special.some(row => row.requiresConfirmation)) && confirmation !== token)
      throw Error(draft ? 'CONFLICT: 日期安排或业务数据已变化，请重新预览后确认应用' : 'CONFLICT: 特殊月份涉及当前经营或已有业务，请重新预览影响后确认应用')
    await applySpecialMonths(tx, special)
    const ordinaryChanged = JSON.stringify(modes.map(({monthly, ...rule}) => rule)) !== JSON.stringify(previousModes.map(({monthly, ...rule}) => rule))
    const history = readCycleHistory(historyRaw)
    if (!history.length && (raw || templates.length)) history.push({ validFrom: '0001-01-01', modes: previousModes })
    const savedModes = modes.map(mode => ({ ...mode, effectiveFrom: mode.effectiveFrom || '0001-01-01', monthly: mode.monthly || {} }))
    history.push({ validFrom: history.length ? calendarToday() : '0001-01-01', modes: savedModes })
    const defaultMode = modes.find(m => m.isDefault)!
    const assignments = modes.filter(m => !m.isDefault).flatMap(mode => mode.regionIds.map(regionId => ({ regionId, mode })))
    const desired = [{ regionId: null as string | null, mode: defaultMode }, ...assignments]
    const nextDisabled = new Set(disabled)
    for (const template of templates) if (template.regionId && !assignments.some(a => a.regionId === template.regionId)) nextDisabled.add(template.id)
    for (const { regionId, mode } of desired) {
      const old = templates.find(t => t.regionId === regionId)
      const values = { name: mode.name, pattern: mode.pattern, updatedAt: new Date() }
      if (old) {
        if (old.name !== mode.name || JSON.stringify(old.pattern) !== JSON.stringify(mode.pattern) || nextDisabled.has(old.id))
          await tx.update(dailyOperatingPeriodTemplates).set({ ...values, version: old.version + 1 }).where(eq(dailyOperatingPeriodTemplates.id, old.id))
        nextDisabled.delete(old.id)
      } else await tx.insert(dailyOperatingPeriodTemplates).values({ id: randomUUID().replaceAll('-', '').slice(0, 30), regionId, ...values })
    }
    for (const [key, value] of [[cycleModesKey, JSON.stringify(savedModes)], [cycleHistoryKey, JSON.stringify(history)], [inheritedTemplatesKey, JSON.stringify([...nextDisabled])]])
      await tx.insert(systemConfigs).values({ key, value }).onConflictDoUpdate({ target: systemConfigs.key, set: { value, updatedAt: new Date() } })
    if (draft) {
      const query = calendarQuery(tx)
      const data = await calendarData(query, null)
      for (const row of special.filter(r => !r.before)) {
        if (row.after.weeks.length !== 4) await requireVariableWeekConstraint(tx)
        const template = data.templates.find(t => t.region_id === row.regionId && !data.disabled.includes(t.id)) || data.templates.find(t => !t.region_id)
        const periodId = randomUUID().replaceAll('-', '').slice(0, 30)
        await tx.insert(dailyOperatingPeriods).values({ id: periodId, name: row.after.name, startDate: row.after.start, endDate: row.after.end, weeks: row.after.weeks, regionId: row.regionId, monthKey: row.month, templateId: template?.id, templateSource: row.source })
        if (row.storeIds.length) await tx.insert(dailyOperatingPeriodStores).values(row.storeIds.map(storeId => ({ periodId, storeId })))
        await logOperation(session, 'daily.period.generate', 'daily_operating_periods', periodId, { monthKey: row.month, regionId: row.regionId, templateSource: row.source, after: row.after }, tx)
      }
      await logOperation(session, 'daily.cycle_modes.save', 'system_configs', cycleModesKey, { before: raw ? JSON.parse(raw) : null, after: modes, range, specialMonths: special }, tx)
      return { calendar: draft.calendar, impact: special.map(({before, after, market, month, reports, targets, classes, requiresConfirmation}) => ({requiresConfirmation, market, month, before: before ? {start:before.startDate,end:before.endDate,weeks:before.weeks as DailyPeriodInput['weeks']} : null, after, reports, targets, classes})), token: '', created: special.filter(r => !r.before).length, keptMonths: draft.calendar.rows.filter(r => r.action === 'keep').map(r => r.month), boundaries: [] as {market:string;month:string|null}[] }
    }
    const query = calendarQuery(tx)
    const data = await calendarData(query, null)
    const today = calendarToday()
    const boundaries = data.regions.map(region => {
      const current = calendarPlan({...data, regions:[region]}, today)[0].monthKey
      const configured = (key:string) => data.periods.some(p => (p.region_id === region.id || !p.region_id) && (p.month_key || p.end_date.slice(0,7)) === key)
      const missing = Array.from({length:36}, (_,i) => calendarMonth(current, i)).find(key => !configured(key))
      if (missing && ordinaryChanged) calendarPlan({...data, regions:[region]}, today, missing)
      const assigned = savedModes.find(m => !m.isDefault && m.regionIds.includes(region.id)) || savedModes.find(m => m.isDefault)!
      const effective = assigned.effectiveFrom > today ? assigned.effectiveFrom : today
      const start = [current, calendarMonth(effective.slice(0,7),-1)].sort().reverse()[0]
      const key = Array.from({length:36}, (_,i) => calendarMonth(start,i)).find(key => {
        const rule = calendarRule(data,region.id,key)
        return !configured(key) && rule?.revisionIndex === data.history.length-1 && rule?.modeId === assigned.id
      })
      if (key && ordinaryChanged) calendarPlan({...data, regions:[region]}, today, key)
      return {market:region.name, month:key || null}
    })
    const result = await ensureCalendar(query, null, today)
    await logOperation(session, 'daily.cycle_modes.save', 'system_configs', cycleModesKey, { before: raw ? JSON.parse(raw) : null, after: modes, specialMonths: special, automatic: {created:result.created, kept:result.kept} }, tx)
    return {calendar: null, impact: special.map(({before, after, market, month, reports, targets, classes, requiresConfirmation}) => ({requiresConfirmation,market,month,before:before ? {start:before.startDate,end:before.endDate,weeks:before.weeks as DailyPeriodInput['weeks']}:null,after,reports,targets,classes})), token: '', created:result.created, keptMonths:[...new Set(data.periods.map(p => p.month_key || p.end_date.slice(0,7)))].sort(), boundaries}

  })
  if (!previewOnly) revalidatePath('/settings/daily')
  return { success: !previewOnly, automatic }
})

type SpecialMonth = {
  market: string; regionId: string; month: string; storeIds: string[];
  before?: typeof dailyOperatingPeriods.$inferSelect;
  after: DailyPeriodInput; reports: number; targets: number; classes: number;
  requiresConfirmation: boolean; source: string;
}

async function planSpecialMonths(tx: DailyTransaction, modes: CycleMode[], previousModes: CycleMode[]): Promise<SpecialMonth[]> {
  const data = await calendarData(calendarQuery(tx), null)
  const periods = await tx.select().from(dailyOperatingPeriods).for('update')
  const targets = await tx.select().from(dailyOperatingTargets).for('update')
  const members = await tx.select({id:staffWechatUsers.employeeId,storeId:staffWechatUsers.storeId}).from(staffWechatUsers)
  const result: SpecialMonth[] = []
  for (const mode of modes) {
    const previous = previousModes.find(m => m.id === mode.id)
    // 普通日期规则不改已保存月份；只有明确增加、修改或恢复例外才修正日期。
    const keys = new Set([...Object.keys(previous?.monthly || {}), ...Object.keys(mode.monthly || {})])
    for (const month of keys) {
      if (JSON.stringify(previous?.monthly?.[month]) === JSON.stringify(mode.monthly?.[month])) continue
      const proposed = buildDailyPeriod(month, mode.monthly?.[month] || mode.pattern, 'preview')
      if (proposed.weeks.length !== 4) await requireVariableWeekConstraint(tx)
      for (const region of data.regions.filter(r => mode.isDefault ? !modes.some(m => !m.isDefault && m.regionIds.includes(r.id)) : mode.regionIds.includes(r.id))) {
        const candidates = periods.filter(p => p.regionId === region.id || !p.regionId)
        const stored = (key:string) => candidates.find(p => p.regionId === region.id && periodMonth({...p,end:p.endDate}) === key) || candidates.find(p => !p.regionId && periodMonth({...p,end:p.endDate}) === key)
        const before = stored(month)
        if (proposed.end < calendarToday()) throw Error(`INVALID_STATE: ${region.name} ${month}已结束，本页不修正历史日期`)
        if (before && before.endDate < calendarToday()) throw Error(`INVALID_STATE: ${region.name} ${month}已结束，请通过历史修正流程处理；本页不改历史日期`)
        for (const offset of [-1,1]) {
          const key = calendarMonth(month,offset), neighbor = stored(key)
          const changed = keys.has(key) && JSON.stringify(previous?.monthly?.[key]) !== JSON.stringify(mode.monthly?.[key])
          const rule = calendarRule(data,region.id,key)
          const adjoining = changed ? buildDailyPeriod(key,mode.monthly?.[key] || mode.pattern,'preview') : neighbor ? {start:neighbor.startDate,end:neighbor.endDate} : rule ? calendarPeriod(key,rule.pattern) : null
          if (!adjoining) continue
          if ((offset < 0 ? Date.parse(proposed.start)-Date.parse(adjoining.end) : Date.parse(adjoining.start)-Date.parse(proposed.end)) !== 86400000)
            throw Error(`INVALID_PARAMS: ${region.name} ${month}：${proposed.start}至${proposed.end}与${key}的${adjoining.start}至${adjoining.end}不连续，请调整特殊月份日期；相邻月份不会自动修改`)
        }
        const storeIds = data.stores.filter(s => s.region_id === region.id).map(s => s.store_id)
        const relevantTargets = targets.filter(t => t.periodId === before?.id && (t.scope === 'market' ? t.scopeId === region.id : t.scope === 'store' ? storeIds.includes(t.scopeId) : members.some(m => m.id === t.scopeId && m.storeId && storeIds.includes(m.storeId))))
        const pkRows = await tx.execute(sql`SELECT count(DISTINCT class_id)::int AS count FROM daily_pk_stores WHERE store_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(storeIds)}::jsonb)) AND (month_key=${month} OR period_id=${before?.id || ''})`)
        const impact = {classes:Number(pkRows[0]?.count || 0)}
        const reports = await tx.select({count:sql<number>`count(*)::int`}).from(dailyReports).where(and(storeIds.length ? inArray(dailyReports.storeId,storeIds) : sql`false`,or(and(gte(dailyReports.reportDate,proposed.start),lte(dailyReports.reportDate,proposed.end)),before ? and(gte(dailyReports.reportDate,before.startDate),lte(dailyReports.reportDate,before.endDate)) : undefined)))
        let weeks = proposed.weeks
        if (before) {
          const oldWeeks = before.weeks as DailyPeriodInput['weeks']
          if (oldWeeks.length === weeks.length) weeks = weeks.map((w,i) => ({...w,id:oldWeeks[i].id}))
          else if (before.startDate <= calendarToday() || reports[0].count || relevantTargets.length || impact.classes)
            throw Error(`INVALID_STATE: ${region.name} ${month}已开始或有业务关联，可调整日期，但不能增减经营周`)
        }
        result.push({source:mode.monthly?.[month] ? 'month-override' : mode.isDefault ? 'global-template' : 'region-template',market:region.name,regionId:region.id,month,storeIds,before,after:{...proposed,weeks},reports:reports[0].count,targets:relevantTargets.length,classes:impact.classes,requiresConfirmation:!!before && (before.startDate<=calendarToday() || !!reports[0].count || !!relevantTargets.length || !!impact.classes)})
      }
    }
  }
  return result
}

async function previewDraftCalendar(tx: DailyTransaction, modes: CycleMode[], previousModes: CycleMode[], range: {from:string;to:string;modeId:string}, expectedRevision:string) {
  if (!range || typeof range.modeId !== 'string' || !modes.some(m => m.id === range.modeId)) throw Error('INVALID_PARAMS: 请选择有效周期模式')
  calendarMonth(range.from); calendarMonth(range.to)
  let months = monthRange(range.from, 36).filter(key => key <= range.to)
  if (range.to < range.from || !months.includes(range.to)) throw Error('INVALID_PARAMS: 月份范围须为1至36个月')
  const data = await calendarData(calendarQuery(tx), null)
  const periods = await tx.select().from(dailyOperatingPeriods).for('share')
  // 一次读取依赖，按市场范围判断业务，同时把依赖版本纳入确认令牌。
  const [targetRows, reportRows, classRows, pkRows, periodStoreRows, employeeRows] = await Promise.all([
    tx.select().from(dailyOperatingTargets),
    tx.select({id:dailyReports.id,storeId:dailyReports.storeId,reportDate:dailyReports.reportDate,updatedAt:dailyReports.updatedAt,status:dailyReports.status,periodSnapshot:dailyReports.periodSnapshot}).from(dailyReports),
    tx.select().from(dailyPkClasses), tx.select().from(dailyPkStores), tx.select().from(dailyOperatingPeriodStores),
    tx.select({id:staffWechatUsers.employeeId,storeId:staffWechatUsers.storeId}).from(staffWechatUsers),
  ])
  const selected = modes.find(m => m.id === range.modeId)!
  const previous = previousModes.find(m => m.id === range.modeId)
  const changes: SpecialMonth[] = []
  const issues: {month:string;message:string}[] = []
  const rows: {month:string;market:string;regionId:string;action:'keep'|'create'|'update'|'adjust'|'blocked';reason:string;source:string;before:DailyPeriodInput|null;after:DailyPeriodInput|null}[] = []
  const today = calendarToday()
  const regions = data.regions.filter(r => selected.isDefault ? !modes.some(m => !m.isDefault && m.regionIds.includes(r.id)) : selected.regionIds.includes(r.id))
  const effective = selected.effectiveFrom || '0001-01-01'
  const ruleChanged = JSON.stringify([selected.pattern, effective]) !== JSON.stringify([previous?.pattern, previous?.effectiveFrom || '0001-01-01'])
  if (ruleChanged) {
    // 修改规则时把交界月与已生成的未来安排一起预览，避免范围末端卡住。
    const affected = periods.filter(p => (!p.regionId || regions.some(r => r.id === p.regionId)) && p.endDate >= effective && p.endDate >= today)
      .map(p => periodMonth({...p,end:p.endDate}))
    const boundary = periods.filter(p => (!p.regionId || regions.some(r => r.id === p.regionId)) && p.startDate < effective && p.endDate >= effective && p.endDate >= today)
      .map(p => periodMonth({...p,end:p.endDate}))
    const first = [range.from,...boundary].sort()[0]
    const last = [range.to,...affected].sort().at(-1)!
    months = monthRange(first,36).filter(key => key <= last)
    if (!months.includes(last)) throw Error('INVALID_PARAMS: 受影响月份超过36个月，请分段调整日期')
  }
  // 不允许确认一个范围却暗中修改另一个月份或模式的例外。
  for (const mode of modes) {
    const old = previousModes.find(m => m.id === mode.id)
    for (const key of new Set([...Object.keys(old?.monthly || {}), ...Object.keys(mode.monthly || {})])) {
      if (JSON.stringify(old?.monthly?.[key]) !== JSON.stringify(mode.monthly?.[key]) && (mode.id !== selected.id || !months.includes(key)))
        throw Error(`INVALID_PARAMS: ${mode.name} ${key}有未保存的按月修改，请切换该模式并将它包含在预览范围内`)
    }
  }
  for (const region of regions) {
    const stored = (key:string) => periods.find(p => p.regionId === region.id && periodMonth({...p,end:p.endDate}) === key) || periods.find(p => !p.regionId && periodMonth({...p,end:p.endDate}) === key)
    const storeIds = data.stores.filter(s => s.region_id === region.id).map(s => s.store_id)
    for (const month of months) {
      const old = stored(month)
      const before = old ? {id:old.id,name:old.name,start:old.startDate,end:old.endDate,weeks:old.weeks as DailyPeriodInput['weeks'],version:old.version} : null
      const explicit = JSON.stringify(previous?.monthly?.[month]) !== JSON.stringify(selected.monthly?.[month])
      let proposed: DailyPeriodInput | null = null
      let reason = '', action: typeof rows[number]['action'] = 'keep'
      let source = selected.monthly?.[month] ? 'month-override' : selected.isDefault ? 'global-template' : 'region-template'
      try {
        const draftPattern = selected.monthly?.[month] || selected.pattern
        proposed = buildDailyPeriod(month, draftPattern, 'preview')
        const transition = !!before && before.start < effective && before.end >= effective && proposed.end >= effective
        const originalProposal = proposed
        if (proposed.end >= effective) proposed = effectivePeriod(before, proposed, effective)
        if (before && before.end < effective || originalProposal.end < effective) {
          proposed = before
          reason = '生效日期之前保留原安排'
          if (explicit) { action = 'blocked'; reason = '该月在生效日期之前，不能修改原安排' }
        } else {
          const different = explicit || !before || JSON.stringify([before.start,before.end,before.weeks.map(w=>[w.name,w.start,w.end])]) !== JSON.stringify([proposed.start,proposed.end,proposed.weeks.map(w=>[w.name,w.start,w.end])])
          if (different) {
            const involvedStores = new Set([...storeIds, ...periodStoreRows.filter(s => old?.regionId && s.periodId===old.id).map(s=>s.storeId)])
            const impact = {
              reports: reportRows.filter(r => involvedStores.has(r.storeId) && ((r.reportDate>=proposed!.start && r.reportDate<=proposed!.end) || !!old && (r.reportDate>=old.startDate && r.reportDate<=old.endDate || JSON.stringify(r.periodSnapshot || {}).includes(old.id)))).length,
              targets: targetRows.filter(t => old && t.periodId===old.id && (t.scope==='market' ? t.scopeId===region.id : t.scope==='store' ? involvedStores.has(t.scopeId) : employeeRows.some(e=>e.id===t.scopeId && e.storeId && involvedStores.has(e.storeId)))).length,
              classes: classRows.filter(c => old && c.periodId===old.id || c.monthKey===month && pkRows.some(p=>p.classId===c.id && involvedStores.has(p.storeId))).length,
            }
            const used = !!(impact.reports || impact.targets || impact.classes)
            if (old && old.endDate < today || proposed.end < today) { reason = '已结束月份只读'; proposed = before; if (explicit) action = 'blocked' }
            else if (!explicit && !transition && old && (old.startDate <= today || used)) { reason = '已开始或有业务，保留原安排；需通过调整日期单月确认'; proposed = before }
            else if (!explicit && !transition && old && (!old.regionId || !['global-template','region-template'].includes(old.templateSource))) { reason = '人工、特殊或历史安排，保留原日期；需明确调整'; proposed = before }
            else if (!old && proposed.start < today) { action = 'blocked'; reason = '新增月份须尚未开始；已有当前月份可明确调整' }
            else {
              const oldWeeks = before?.weeks
              if (oldWeeks && oldWeeks.length !== proposed.weeks.length && (used || old!.startDate <= today)) throw Error('已有业务或已开始的月份不能增减经营周')
              if (oldWeeks?.length === proposed.weeks.length) proposed = {...proposed,weeks:proposed.weeks.map((w,i)=>({...w,id:oldWeeks[i].id}))}
              action = !old ? 'create' : (explicit || transition) && (used || old.startDate <= today) ? 'adjust' : 'update'
              if (transition) source = 'month-override'
              changes.push({market:region.name,regionId:region.id,month,storeIds,before:old,after:proposed,reports:impact.reports,targets:impact.targets,classes:impact.classes,requiresConfirmation:action==='adjust',source})
              reason = transition ? `过渡月份：${effective}之前保留原月、周归属，之后按新规则衔接；确认后应用` : action === 'adjust' ? '单月调整需确认统计归属影响' : action === 'create' ? '新增月份' : '将替换旧安排'
            }
          } else reason = '日期一致，保留原安排'
        }
      } catch(e) { action = 'blocked'; reason = e instanceof Error ? e.message.replace(/^[A-Z_]+: /,'') : '日期无效' }
      const row = {month,market:region.name,regionId:region.id,action,reason,source:action==='keep' && old ? old.templateSource : source,before,after:proposed}
      rows.push(row)
      if (action==='blocked') issues.push({month,message:`${region.name} ${month}：${reason}`})
    }
    // 同时检查最终应用集合与范围之外的相邻月，不用旧日期校验待更新月份。
    const checkedPairs = new Set<string>()
    for (const row of rows.filter(r=>r.regionId===region.id && r.after)) {
      const p = row.after!
      for (const offset of [-1,1]) {
        const key = calendarMonth(row.month,offset)
        const adjacent = rows.find(r=>r.regionId===region.id && r.month===key)
        const neighbor = stored(key)
        const pair = [row.month,key].sort().join(':')
        if (checkedPairs.has(pair)) continue
        checkedPairs.add(pair)
        const dates = adjacent?.after || (neighbor ? {start:neighbor.startDate,end:neighbor.endDate} : null)
        if (!dates) continue
        const end = offset < 0 ? dates.end : p.end, start = offset < 0 ? p.start : dates.start
        const delta = Date.parse(start)-Date.parse(end)
        if (delta!==86400000) {
          const gapStart = new Date(Date.parse(end)+86400000).toISOString().slice(0,10)
          const gapEnd = new Date(Date.parse(start)-86400000).toISOString().slice(0,10)
          const message = delta>86400000 ? `${region.name} ${row.month}与${key}之间，${gapStart}至${gapEnd}没有归属，请调整相关月份` : `${region.name} ${row.month}（${p.start}至${p.end}）与${key}（${dates.start}至${dates.end}）日期重叠，请调整相关月份`
          if (!issues.some(i=>i.message===message)) issues.push({month:row.month,message})
        }
      }
      const overlap = periods.find(other => other.id !== row.before?.id && (other.regionId===region.id || !other.regionId && !periods.some(p=>p.regionId===region.id && periodMonth({...p,end:p.endDate})===periodMonth({...other,end:other.endDate}))) && periodMonth({...other,end:other.endDate})!==row.month && !rows.some(r=>r.regionId===region.id && r.month===periodMonth({...other,end:other.endDate})) && other.startDate<=p.end && other.endDate>=p.start)
      if (overlap && !checkedPairs.has([row.month,periodMonth({...overlap,end:overlap.endDate})].sort().join(':'))) issues.push({month:row.month,message:`${region.name} ${row.month}与已保存的${periodMonth({...overlap,end:overlap.endDate})}重叠`})
    }
  }
  if (new Set(changes.filter(c => c.requiresConfirmation).map(c => c.month)).size > 1) issues.push({month:range.from,message:'已有业务或已开始的月份请每次单独调整一个归属月'})
  if (!regions.length) issues.push({month:range.from,message:'当前模式暂无适用市场'})
  const calendar = {rows,issues}
  const dependencies = [targetRows, reportRows, classRows, pkRows, periodStoreRows, employeeRows]
  const token = createHash('sha256').update(JSON.stringify({expectedRevision,modes,range,calendar,changes,dependencies,stores:data.stores,periods:periods.map(p=>[p.id,p.version,p.startDate,p.endDate])})).digest('hex')
  return {calendar,changes,token}
}

async function applySpecialMonths(tx: DailyTransaction, rows: SpecialMonth[]) {
  for (const row of rows) {
    const {before,after} = row
    if (!before) continue
    if (after.weeks.length !== 4) await requireVariableWeekConstraint(tx)
    const id = before?.regionId ? before.id : randomUUID().replaceAll('-','').slice(0,30)
    const values = {name:after.name,startDate:after.start,endDate:after.end,weeks:after.weeks,templateSource:row.source,updatedAt:new Date()}
    if (before?.regionId) await tx.update(dailyOperatingPeriods).set({...values,version:before.version+1}).where(eq(dailyOperatingPeriods.id,id))
    else {
      // 旧全局月份保留；给所选市场建立独立安排，不改其他市场及旧日报快照。
      await tx.insert(dailyOperatingPeriods).values({id,...values,regionId:row.regionId,monthKey:row.month,templateId:before?.templateId})
      if (row.storeIds.length) await tx.insert(dailyOperatingPeriodStores).values(row.storeIds.map(storeId => ({periodId:id,storeId})))
      if (before) await tx.execute(sql`UPDATE daily_operating_targets t SET period_id=${id}
        WHERE t.period_id=${before.id} AND ((t.scope='market' AND t.scope_id=${row.regionId}) OR (t.scope='store' AND t.scope_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(row.storeIds)}::jsonb))) OR (t.scope='personal' AND EXISTS(SELECT 1 FROM staff_wechat_users u WHERE u.employee_id=t.scope_id AND u.store_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(row.storeIds)}::jsonb)))))`)
    }
  }
}

export const saveDailyPeriodTemplate = withPermission('system:config', async (session, input: DailyPeriodTemplateInput) => {
  requireAdmin(session)
  const parsed = dailyPeriodTemplateInput.safeParse(input)
  if (!parsed.success) throw Error('INVALID_PARAMS: ' + parsed.error.issues[0].message)
  const template = parsed.data
  try { validateDailyCyclePattern(template.pattern) }
  catch (error) { throw Error('INVALID_PARAMS: ' + (error instanceof Error ? error.message.replace(/^INVALID_PARAMS: /, '') : '日期规则无效')) }
  if (template.regionId) {
    const [region] = await db.select({ id: orgNodes.id }).from(orgNodes).where(and(eq(orgNodes.id, template.regionId), eq(orgNodes.type, '市场')))
    if (!region) throw Error('INVALID_PARAMS: 区域不存在或不是市场节点')
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('daily-period-config',0))`)
    await requireLegacyTemplateEditing(tx)
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
    const [inheritance] = await tx.select().from(systemConfigs).where(eq(systemConfigs.key, inheritedTemplatesKey))
    const disabled = inheritedTemplateIds(inheritance?.value).filter(id => id !== template.id)
    await tx.insert(systemConfigs).values({ key: inheritedTemplatesKey, value: JSON.stringify(disabled) }).onConflictDoUpdate({ target: systemConfigs.key, set: { value: JSON.stringify(disabled), updatedAt: new Date() } })
    await logOperation(session, 'daily.period_template.save', 'daily_operating_period_templates', template.id,
      { before: old || null, after: template }, tx)
  })
  revalidatePath('/settings/daily')
  return { success: true }
})

type DailyTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function monthPreparation(tx: DailyTransaction, monthKey: string, months: number, modeId?: string, updateUnused = false) {
  monthRange(monthKey, months)
  if (typeof updateUnused !== 'boolean' || (modeId !== undefined && (typeof modeId !== 'string' || !modeId || modeId.length > 50))) throw Error('INVALID_PARAMS: 无效生成选项')
  const [templates, overrides, periods, nodes, storeRows, inheritance] = await Promise.all([
    tx.select().from(dailyOperatingPeriodTemplates), tx.select().from(dailyOperatingPeriodOverrides),
    tx.select().from(dailyOperatingPeriods),
    tx.select({ id: orgNodes.id, name: orgNodes.name, type: orgNodes.type, parentId: orgNodes.parentId }).from(orgNodes),
    tx.select({ id: stores.storeId, orgNodeId: stores.orgNodeId }).from(stores),
    tx.select().from(systemConfigs).where(or(eq(systemConfigs.key, inheritedTemplatesKey), eq(systemConfigs.key, cycleHistoryKey), eq(systemConfigs.key, cycleModesKey))),
  ])
  const data = {
    regions: nodes.filter(n => n.type === '市场').sort((a, b) => a.id.localeCompare(b.id)), templates, overrides,
    disabledTemplateIds: inheritedTemplateIds(inheritance.find(c => c.key === inheritedTemplatesKey)?.value),
    modeHistory: readCycleHistory(inheritance.find(c => c.key === cycleHistoryKey)?.value), modeId, updateUnused,
    periods: periods.map(p => ({ ...p, start: p.startDate, end: p.endDate, weeks: p.weeks as DailyPeriodInput['weeks'] })),
  }
  if (!data.modeHistory.length && modeId) data.modeHistory = [{ validFrom: '0001-01-01', modes: upgradeCycleModes(templates, data.disabledTemplateIds, data.regions.map(r => r.id), overrides, inheritance.find(c => c.key === cycleModesKey)?.value) }]
  const planned = planDailyMonths(data, monthKey, months, new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10))
  const rows = await Promise.all(planned.map(async row => {
    if (!updateUnused || row.action !== 'keep' || !row.ruleChanged || !row.proposed || !row.period) return { ...row, action: row.action as 'keep' | 'create' | 'blocked' | 'update' }
    // 全局旧周期不能被单模式区域规则覆盖。
    const old = periods.find(p => p.id === row.period!.id)!
    if (!old.regionId) return { ...row, action: 'blocked' as const, reason: '原全局月份不能通过单模式批量改写' }
    const impact = await periodImpact(tx, old, row.proposed)
    if (old.startDate <= new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) || impact.reports || impact.targets || impact.classes)
      return { ...row, action: 'blocked' as const, reason: '月份已开始或已有日报、目标、PK关联，不能批量更新' }
    const conflict = periods.some(p => {
      if (p.id === old.id || (p.regionId !== old.regionId && p.regionId !== null)) return false
      const plannedUpdate = planned.find(r => r.period?.id === p.id && r.action === 'keep' && r.ruleChanged && r.proposed)
      const dates = plannedUpdate?.proposed || { start: p.startDate, end: p.endDate }
      return dates.start <= row.proposed!.end && dates.end >= row.proposed!.start
    })
    if (conflict) return { ...row, action: 'blocked' as const, reason: '新日期与已有经营月重叠' }
    const oldWeeks = old.weeks as DailyPeriodInput['weeks']
    const weeks = oldWeeks.length === row.proposed.weeks.length ? row.proposed.weeks.map((w, i) => ({ ...w, id: oldWeeks[i].id })) : row.proposed.weeks
    return { ...row, period: { ...row.proposed, weeks, id: old.id, version: old.version }, action: 'update' as const, reason: '将更新未开始且无业务关联的月份' }
  }))
  // 更新后的批次也需连续，避免按月例外产生空档。
  for (const row of rows.filter(r => r.action === 'update' && r.period)) {
    const previous = rows.find(r => r.regionId === row.regionId && monthRange(r.monthKey, 2)[1] === row.monthKey)?.period
      || data.periods.find(p => (p.regionId === row.regionId || !p.regionId) && monthRange(periodMonth(p), 2)[1] === row.monthKey)
    const nextKey = monthRange(row.monthKey, 2)[1]
    const next = rows.find(r => r.regionId === row.regionId && r.monthKey === nextKey)?.period
      || data.periods.find(p => (p.regionId === row.regionId || !p.regionId) && periodMonth(p) === nextKey)
    if ((previous && Date.parse(row.period!.start) - Date.parse(previous.end) !== 86400000) || (next && Date.parse(next.start) - Date.parse(row.period!.end) !== 86400000)) {
      row.action = 'blocked'; row.reason = '更新后与相邻经营月不连续'
    }
  }
  const storesByRegion = data.regions.map(region => ({ regionId: region.id, storeIds: storeRows.filter(store => {
    const visited = new Set<string>()
    let id = store.orgNodeId
    while (id && !visited.has(id)) {
      if (id === region.id) return true
      visited.add(id); id = nodes.find(n => n.id === id)?.parentId || null
    }
    return false
  }).map(s => s.id).sort() }))
  const revision = createHash('sha256').update(JSON.stringify({ rows, storesByRegion,
    history: data.modeHistory, modeId: modeId || null, updateUnused, templates: templates.map(t => [t.id, t.version]).sort(), disabled: data.disabledTemplateIds.slice().sort() })).digest('hex')
  return { rows, revision, storesByRegion }
}

export const previewDailyMonths = withPermission('system:config', async (session, monthKey: string, months: number = 1, modeId?: string, updateUnused: boolean = false) => {
  requireAdmin(session)
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('daily-period-config',0))`)
    const { rows, revision } = await monthPreparation(tx, monthKey, months, modeId, updateUnused)
    return { rows, revision }
  })
})

async function prepareMonths(tx: DailyTransaction, session: Parameters<typeof requireAdmin>[0], monthKey: string, months: number, revision?: string, modeId?: string, updateUnused: boolean = false) {
  requireAdmin(session)
  const plan = await monthPreparation(tx, monthKey, months, modeId, updateUnused)
  if (revision !== undefined && revision !== plan.revision) throw Error('CONFLICT: 日期规则或月份安排已变更，请重新预览')
  if (!plan.rows.length) throw Error('INVALID_STATE: 此模式在所选月份没有已生效的适用市场')
  const blocked = plan.rows.find(row => row.action === 'blocked')
  if (blocked) throw Error(`INVALID_STATE: ${blocked.regionName} ${blocked.monthKey}：${blocked.reason}`)
  if (plan.rows.some(r => r.action !== 'keep' && r.period?.weeks.length !== 4)) await requireVariableWeekConstraint(tx)
  const ids = new Set<string>()
  let created = 0, kept = 0, updated = 0
  for (const row of plan.rows) {
    if (!row.period) throw Error('INVALID_STATE: 缺少可用日期规则')
    if (row.action === 'keep') { ids.add(row.period.id); kept++; continue }
    if (row.action === 'update') {
      const [locked] = await tx.select().from(dailyOperatingPeriods).where(eq(dailyOperatingPeriods.id, row.period.id)).for('update')
      if (!locked || locked.version !== row.period.version) throw Error('CONFLICT: 月份已变更，请重新预览')
      const impact = await periodImpact(tx, locked, row.period)
      if (impact.reports || impact.targets || impact.classes) throw Error('CONFLICT: 月份新增了业务关联，请重新预览')
      await tx.update(dailyOperatingPeriods).set({ startDate: row.period.start, endDate: row.period.end, weeks: row.period.weeks, templateSource: row.source, version: locked.version + 1, updatedAt: new Date() }).where(eq(dailyOperatingPeriods.id, locked.id))
      await logOperation(session, 'daily.period.generate', 'daily_operating_periods', locked.id, { before: locked, after: row.period, updateUnused: true }, tx)
      ids.add(locked.id); updated++; continue
    }
    // 不把市场编号嵌进主键，满足现有30字符约束；旧编号保持不变。
    const id = randomUUID().replaceAll('-', '').slice(0, 30)
    const period = { ...row.period, id }
    await tx.insert(dailyOperatingPeriods).values({ id, name: period.name, startDate: period.start, endDate: period.end,
      weeks: period.weeks, regionId: row.regionId, monthKey: row.monthKey, templateId: row.templateId, templateSource: row.source })
    const storeIds = plan.storesByRegion.find(r => r.regionId === row.regionId)?.storeIds || []
    if (storeIds.length) await tx.insert(dailyOperatingPeriodStores).values(storeIds.map(storeId => ({ periodId: id, storeId })))
    await logOperation(session, 'daily.period.generate', 'daily_operating_periods', id,
      { monthKey: row.monthKey, regionId: row.regionId, templateId: row.templateId, templateSource: row.source, after: period }, tx)
    ids.add(id); created++
  }
  return { ids: [...ids], created, kept, updated }
}

export const prepareDailyMonths = withPermission('system:config', async (session, monthKey: string, months: number, revision: string, modeId?: string, updateUnused: boolean = false) => {
  requireAdmin(session)
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw Error('INVALID_PARAMS: 请先预览月份安排')
  const result = await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('daily-period-config',0))`)
    return prepareMonths(tx, session, monthKey, months, revision, modeId, updateUnused)
  })
  revalidatePath('/settings/daily')
  return result
})

export const createDailyPeriodsForMonth = withPermission('system:config', async (session, monthKey: string) => {
  requireAdmin(session)
  const result = await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('daily-period-config',0))`)
    return prepareMonths(tx, session, monthKey, 1)
  })
  revalidatePath('/settings/daily')
  return result
})

export const restoreDailyGlobalRule = withPermission('system:config', async (session, templateId: string, version: number) => {
  requireAdmin(session)
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('daily-period-config',0))`)
    await requireLegacyTemplateEditing(tx)
    const [template] = await tx.select().from(dailyOperatingPeriodTemplates).where(eq(dailyOperatingPeriodTemplates.id, templateId)).for('update')
    if (!template?.regionId) throw Error('INVALID_PARAMS: 请选择市场专用规则')
    if (template.version !== version) throw Error('CONFLICT: 日期规则已修改，请刷新')
    const [global] = await tx.select().from(dailyOperatingPeriodTemplates).where(isNull(dailyOperatingPeriodTemplates.regionId))
    if (!global) throw Error('INVALID_STATE: 请先保存总部默认规则')
    const [inheritance] = await tx.select().from(systemConfigs).where(eq(systemConfigs.key, inheritedTemplatesKey))
    const disabled = [...new Set([...inheritedTemplateIds(inheritance?.value), template.id])]
    await tx.insert(systemConfigs).values({ key: inheritedTemplatesKey, value: JSON.stringify(disabled) })
      .onConflictDoUpdate({ target: systemConfigs.key, set: { value: JSON.stringify(disabled), updatedAt: new Date() } })
    await tx.update(dailyOperatingPeriodTemplates).set({ version: template.version + 1, updatedAt: new Date() }).where(eq(dailyOperatingPeriodTemplates.id, template.id))
    await logOperation(session, 'daily.period_template.inherit', 'daily_operating_period_templates', template.id,
      { before: template, after: { regionId: template.regionId, name: '沿用总部规则', globalTemplateId: global.id } }, tx)
  })
  revalidatePath('/settings/daily')
  return { success: true }
})

async function requireLegacyTemplateEditing(tx: DailyTransaction) {
  const [history] = await tx.select({ value: systemConfigs.value }).from(systemConfigs).where(eq(systemConfigs.key, cycleHistoryKey))
  if (history) throw Error('INVALID_STATE: 已启用周期模式，请刷新后在周期模式中修改日期规则')
}

async function requireVariableWeekConstraint(tx: DailyTransaction) {
  const rows = await tx.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='daily_operating_periods'::regclass AND conname='chk_daily_period_weeks'`)
  if (!String(rows[0]?.definition || '').includes('<= 31')) throw Error('INVALID_STATE: 数据库仍限制四个经营周，请先完成经营周期约束迁移，再生成其他周数的月份')
}

async function periodImpact(tx: DailyTransaction | typeof db, old: typeof dailyOperatingPeriods.$inferSelect | undefined, p: DailyPeriodInput) {
  const periodStores = old?.regionId ? await tx.select({ storeId: dailyOperatingPeriodStores.storeId }).from(dailyOperatingPeriodStores).where(eq(dailyOperatingPeriodStores.periodId, old.id)) : []
  const storeIds = periodStores.map(s => s.storeId)
  const [reports, targets, classes] = await Promise.all([
    tx.select({ count: sql<number>`count(*)::int` }).from(dailyReports).where(and(
      old?.regionId ? (storeIds.length ? inArray(dailyReports.storeId, storeIds) : sql`false`) : undefined,
      or(and(gte(dailyReports.reportDate, p.start), lte(dailyReports.reportDate, p.end)),
        old ? and(gte(dailyReports.reportDate, old.startDate), lte(dailyReports.reportDate, old.endDate)) : undefined))),
    tx.select({ count: sql<number>`count(*)::int` }).from(dailyOperatingTargets).where(eq(dailyOperatingTargets.periodId, old?.id || p.id)),
    tx.select({ count: sql<number>`count(*)::int` }).from(dailyPkClasses).where(or(eq(dailyPkClasses.periodId, old?.id || p.id), old ? eq(dailyPkClasses.monthKey, periodMonth({ ...old, end: old.endDate })) : undefined)),
  ])
  return { reports: reports[0].count, targets: targets[0].count, classes: classes[0].count }
}

export const previewDailyPeriod = withPermission('system:config', async (session, input: DailyPeriodInput) => {
  requireAdmin(session)
  const parsed = dailyPeriodInput.safeParse(input)
  if (!parsed.success) throw Error('INVALID_PARAMS: ' + parsed.error.issues[0].message)
  const p = parsed.data
  const [old] = await db.select().from(dailyOperatingPeriods).where(eq(dailyOperatingPeriods.id, p.id))
  if ((old?.version ?? 0) !== p.version) throw Error('CONFLICT: 经营周期已变更，请刷新')
  const { reports, targets, classes } = await periodImpact(db, old, p)
  const previous = old?.weeks as DailyPeriodInput['weeks'] | undefined
  return { reports, targets, classes,
    changes: [{ name: '经营月', before: old ? `${old.startDate} 至 ${old.endDate}` : '尚未配置', after: `${p.start} 至 ${p.end}` }, ...p.weeks.map((week, index) => ({ name: week.name,
      before: previous?.[index] ? `${previous[index].start} 至 ${previous[index].end}` : '尚未配置',
      after: `${week.start} 至 ${week.end}` }))].filter((change) => change.before !== change.after) }
})

export const saveDailyPeriod = withPermission('system:config', async (session, input: DailyPeriodInput, saveAsOverride: boolean = false, confirmImpact: boolean = false, refreshFromRule: boolean = false) => {
  requireAdmin(session)
  const parsed = dailyPeriodInput.safeParse(input)
  if (!parsed.success) throw Error('INVALID_PARAMS: ' + parsed.error.issues[0].message)
  const p = parsed.data
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('daily-period-config',0))`)
    if (p.weeks.length !== 4) await requireVariableWeekConstraint(tx)
    const [old] = await tx.select().from(dailyOperatingPeriods).where(eq(dailyOperatingPeriods.id, p.id)).for('update')
    if ((old?.version ?? 0) !== p.version) throw Error('CONFLICT: 经营周期已变更，请刷新')
    if (old && old.endDate < new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)) throw Error('INVALID_STATE: 历史经营月保持只读')
    if (old && refreshFromRule) {
      const impact = await periodImpact(tx, old, p)
      if (old.startDate <= new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) || impact.reports || impact.targets || impact.classes)
        throw Error('CONFLICT: 该月份已开始或已有业务关联，请使用本月特殊修正流程')
    }
    if (old && !confirmImpact) {
      const impact = await periodImpact(tx, old, p)
      if (impact.reports || impact.targets || impact.classes) throw Error('CONFLICT: 该月份已有业务关联，请预览影响后确认保存')
    }
    if (saveAsOverride && (!old?.templateId || !old.monthKey)) throw Error('INVALID_STATE: 该经营月尚无模板来源，请先生成模板经营月')
    const sameRegion = old?.regionId ? or(eq(dailyOperatingPeriods.regionId, old.regionId), isNull(dailyOperatingPeriods.regionId)) : undefined
    const [overlap] = await tx.select({ id: dailyOperatingPeriods.id }).from(dailyOperatingPeriods).where(and(
      ne(dailyOperatingPeriods.id, p.id), sameRegion, lte(dailyOperatingPeriods.startDate, p.end), gte(dailyOperatingPeriods.endDate, p.start)))
    if (overlap) throw Error('INVALID_PARAMS: 经营月份不可重叠')
    if (old && JSON.stringify((old.weeks as DailyPeriodInput['weeks']).map(w => w.id)) !== JSON.stringify(p.weeks.map(w => w.id))) {
      if ((old.weeks as DailyPeriodInput['weeks']).length === p.weeks.length) throw Error('INVALID_PARAMS: 不能更换周编号，请仅增减经营周')
      const impact = await periodImpact(tx, old, p)
      if (old.startDate <= new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) || impact.reports || impact.targets || impact.classes)
        throw Error('INVALID_STATE: 已开始或已有业务关联的月份不能增减经营周或更换周编号')
    }
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
    const [seed] = await tx.select().from(dailyOperatingPeriods).where(eq(dailyOperatingPeriods.id, p.periodId))
    if (!seed) throw Error('NOT_FOUND: 经营月份不存在')
    const monthKey = periodMonth({ ...seed, end: seed.endDate })
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`daily-pk:${monthKey}`}))`)
    const monthPeriods = await tx.select().from(dailyOperatingPeriods)
      .where(sql`COALESCE(${dailyOperatingPeriods.monthKey},to_char(${dailyOperatingPeriods.endDate},'YYYY-MM'))=${monthKey}`)
      .orderBy(dailyOperatingPeriods.id).for('update')
    const period = monthPeriods.find(row => row.id === p.periodId)
    if (!period || period.version !== p.expectedVersion) throw Error('CONFLICT: PK配置或经营周期已变更，请刷新')
    const monthIds = monthPeriods.map(row => row.id)
    const validStores = await tx.select({ id: stores.storeId }).from(stores)
    if (p.stores.some(s => !validStores.some(v => v.id === s.storeId))) throw Error('INVALID_PARAMS: 门店不存在')
    const before = {
      stores: await tx.select().from(dailyPkStores).where(inArray(dailyPkStores.periodId, monthIds)),
      classes: await tx.select().from(dailyPkClasses).where(inArray(dailyPkClasses.periodId, monthIds)),
    }
    if (p.classes.length) {
      const existing = await tx.select().from(dailyPkClasses).where(inArray(dailyPkClasses.id, p.classes.map(c => c.id)))
      if (existing.some(c => !monthIds.includes(c.periodId))) throw Error('INVALID_PARAMS: 班级编号属于其他月份')
    }
    await tx.delete(dailyPkStores).where(inArray(dailyPkStores.periodId, monthIds))
    await tx.delete(dailyPkClasses).where(inArray(dailyPkClasses.periodId, monthIds))
    // period_id 保留为存量兼容关联；PK的业务归属独立使用month_key。
    if (p.classes.length) await tx.insert(dailyPkClasses).values(p.classes.map(c => ({ ...c, periodId: p.periodId, monthKey })))
    if (p.stores.length) await tx.insert(dailyPkStores).values(p.stores.map(s => ({ ...s, periodId: p.periodId, monthKey })))
    await tx.update(dailyOperatingPeriods).set({ version: sql`${dailyOperatingPeriods.version}+1`, updatedAt: new Date() }).where(inArray(dailyOperatingPeriods.id, monthIds))
    await logOperation(session, 'daily.pk.save', 'daily_pk_classes', monthKey, { before, after: { ...p, monthKey } }, tx)
  })
  revalidatePath('/settings/daily'); revalidatePath('/data-center/operating-pk'); return { success: true }
})

export const selectDailyPkMonth = withPermission('system:config', async (session, monthKey: string) => {
  requireAdmin(session)
  calendarMonth(monthKey)
  if (monthKey >= calendarToday().slice(0,7)) await automaticCalendar(null, monthKey)
  revalidatePath('/settings/daily')
  return getDailyConfiguration()
})
