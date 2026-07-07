

import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

export interface CronContext {
  
  referenceDate?: Date
}


export function dateSqlOf(ctx?: CronContext): SQL {
  if (!ctx?.referenceDate) return sql.raw('CURRENT_DATE')
  const dateStr = formatDateStamp(ctx.referenceDate)
  return sql`(${dateStr}::date)`
}


export function nowSqlOf(ctx?: CronContext): SQL {
  if (!ctx?.referenceDate) return sql.raw('NOW()')
  const iso = ctx.referenceDate.toISOString()
  return sql`(${iso}::timestamptz)`
}


export function nowOf(ctx?: CronContext): Date {
  return ctx?.referenceDate ?? new Date()
}


export function dateStampOf(ctx?: CronContext): string {
  return formatDateStamp(nowOf(ctx))
}


function formatDateStamp(d: Date): string {
  const shanghaiMs = d.getTime() + 8 * 60 * 60 * 1000
  const shanghai = new Date(shanghaiMs)
  return shanghai.toISOString().slice(0, 10)
}
