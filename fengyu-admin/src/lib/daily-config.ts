import { z } from 'zod'
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '请输入有效日期').refine((s) => {
  const n = Date.parse(s + 'T12:00:00Z')
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === s
}, '请输入有效日期')
export const dailyPeriodInput = z.object({
  id: z.string().min(1).max(30), name: z.string().trim().min(1).max(60),
  start: date, end: date, version: z.number().int().nonnegative(),
  weeks: z.array(z.object({ id: z.string().min(1).max(30), name: z.string().trim().min(1).max(30), start: date, end: date })).length(4),
}).superRefine((p, ctx) => {
  let expected = Date.parse(p.start + 'T12:00:00Z')
  const end = Date.parse(p.end + 'T12:00:00Z'), ids = new Set<string>()
  for (const w of p.weeks) {
    const a = Date.parse(w.start + 'T12:00:00Z'), b = Date.parse(w.end + 'T12:00:00Z')
    if (ids.has(w.id) || a !== expected || a > b || b > end) {
      ctx.addIssue({ code: 'custom', message: '四个经营周须连续、无重叠地覆盖经营月，且编号唯一' }); return
    }
    ids.add(w.id); expected = b + 86400000
  }
  if (expected !== end + 86400000) ctx.addIssue({ code: 'custom', message: '经营周须覆盖完整经营月' })
})
export type DailyPeriodInput = z.infer<typeof dailyPeriodInput>
export const dailyPkInput = z.object({
  periodId: z.string().min(1).max(30), expectedVersion: z.number().int().positive(),
  classes: z.array(z.object({ id: z.string().min(1).max(100), name: z.string().trim().min(1).max(30) })),
  stores: z.array(z.object({ storeId: z.string().min(1), classId: z.string().min(1), legion: z.string().max(100), groupName: z.string().max(100), mentorName: z.string().max(100) })),
}).superRefine((p, ctx) => {
  const ids = new Set(p.classes.map((c) => c.id)), names = new Set(p.classes.map((c) => c.name))
  if (ids.size !== p.classes.length || names.size !== p.classes.length || new Set(p.stores.map((s) => s.storeId)).size !== p.stores.length || p.stores.some((s) => !ids.has(s.classId)))
    ctx.addIssue({ code: 'custom', message: '班级名称及编号不可重复，每店同月只能加入一个有效班级' })
})
export type DailyPkInput = z.infer<typeof dailyPkInput>

const point = z.object({ monthOffset: z.union([z.literal(-1), z.literal(0), z.literal(1)]), day: z.number().int().min(1).max(31) })
export const dailyCyclePattern = z.object({
  start: point,
  end: point,
  weeks: z.array(z.object({ id: z.string().min(1).max(30), name: z.string().trim().min(1).max(30), start: point, end: point })).length(4),
})
export const dailyPeriodTemplateInput = z.object({
  id: z.string().min(1).max(50), regionId: z.string().min(1).max(100).nullable(),
  name: z.string().trim().min(1).max(60), pattern: dailyCyclePattern, version: z.number().int().nonnegative(),
})
export type DailyCyclePatternInput = z.infer<typeof dailyCyclePattern>
export type DailyPeriodTemplateInput = z.infer<typeof dailyPeriodTemplateInput>
