'use server'
import { db } from '@/db'
import { dailyOperatingPeriods, dailyOperatingTargets, dailyPkClasses, dailyPkStores, dailyReports } from '@db/daily-report'
import { stores } from '@db/org'
import { and, eq, ne, lte, gte, or, desc, sql } from 'drizzle-orm'
import { withPermission } from '@/lib/with-permission'
import { requireAdmin } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'
import { dailyPeriodInput, dailyPkInput, type DailyPeriodInput, type DailyPkInput } from '@/lib/daily-config'
import { revalidatePath } from 'next/cache'

export const getDailyConfiguration = withPermission('system:config', async (session) => {
  requireAdmin(session)
  // 例外：经营月份按日期倒序，门店按名称，便于经营配置选择。
  const [periods, classes, assignments, storeRows] = await Promise.all([
    db.select().from(dailyOperatingPeriods).orderBy(desc(dailyOperatingPeriods.startDate)),
    db.select().from(dailyPkClasses), db.select().from(dailyPkStores),
    db.select({ id: stores.storeId, name: stores.storeName }).from(stores).orderBy(stores.storeName),
  ])
  return { periods: periods.map((p) => ({ id: p.id, name: p.name, start: p.startDate, end: p.endDate,
    version: p.version, weeks: p.weeks as DailyPeriodInput['weeks'] })),
    classes: classes.map((c) => ({ id: c.id, name: c.name, periodId: c.periodId })),
    assignments: assignments.map((s) => ({ periodId: s.periodId, storeId: s.storeId, classId: s.classId,
      legion: s.legion, groupName: s.groupName, mentorName: s.mentorName })), stores: storeRows }
})

export const previewDailyPeriod = withPermission('system:config', async (session, input: DailyPeriodInput) => {
  requireAdmin(session)
  const parsed = dailyPeriodInput.safeParse(input)
  if (!parsed.success) throw Error('INVALID_PARAMS: ' + parsed.error.issues[0].message)
  const p = parsed.data
  const [old] = await db.select().from(dailyOperatingPeriods).where(eq(dailyOperatingPeriods.id, p.id))
  if ((old?.version ?? 0) !== p.version) throw Error('CONFLICT: 经营周期已变更，请刷新')
  const [reports, targets, classes] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(dailyReports).where(or(
      and(gte(dailyReports.reportDate, p.start), lte(dailyReports.reportDate, p.end)),
      old ? and(gte(dailyReports.reportDate, old.startDate), lte(dailyReports.reportDate, old.endDate)) : undefined)),
    db.select({ count: sql<number>`count(*)::int` }).from(dailyOperatingTargets).where(eq(dailyOperatingTargets.periodId, p.id)),
    db.select({ count: sql<number>`count(*)::int` }).from(dailyPkClasses).where(eq(dailyPkClasses.periodId, p.id)),
  ])
  return { reports: reports[0].count, targets: targets[0].count, classes: classes[0].count }
})

export const saveDailyPeriod = withPermission('system:config', async (session, input: DailyPeriodInput) => {
  requireAdmin(session)
  const parsed = dailyPeriodInput.safeParse(input)
  if (!parsed.success) throw Error('INVALID_PARAMS: ' + parsed.error.issues[0].message)
  const p = parsed.data
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('daily-period-config',0))`)
    const [old] = await tx.select().from(dailyOperatingPeriods).where(eq(dailyOperatingPeriods.id, p.id)).for('update')
    if ((old?.version ?? 0) !== p.version) throw Error('CONFLICT: 经营周期已变更，请刷新')
    const [overlap] = await tx.select({ id: dailyOperatingPeriods.id }).from(dailyOperatingPeriods).where(and(
      ne(dailyOperatingPeriods.id, p.id), lte(dailyOperatingPeriods.startDate, p.end), gte(dailyOperatingPeriods.endDate, p.start)))
    if (overlap) throw Error('INVALID_PARAMS: 经营月份不可重叠')
    if (old && JSON.stringify((old.weeks as DailyPeriodInput['weeks']).map((w) => w.id)) !== JSON.stringify(p.weeks.map((w) => w.id)))
      throw Error('INVALID_PARAMS: 已建周期只能调整周名称与日期，不能更换周编号')
    const values = { name: p.name, startDate: p.start, endDate: p.end, weeks: p.weeks, updatedAt: new Date() }
    if (old) await tx.update(dailyOperatingPeriods).set({ ...values, version: old.version + 1 }).where(eq(dailyOperatingPeriods.id, p.id))
    else await tx.insert(dailyOperatingPeriods).values({ id: p.id, ...values })
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
