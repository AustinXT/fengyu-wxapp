
import { sql } from 'drizzle-orm'
import { fmtDateTime } from './datetime'


export function nowTs() {
  return sql`NOW()`
}


export function beijingTs(d: Date) {
  const wallClock = fmtDateTime(d) 
  return sql`${wallClock}::timestamp AT TIME ZONE 'Asia/Shanghai'`
}


export function beijingBoundaryTs(dateStr: string, time: '00:00:00' | '23:59:59') {
  return sql`${`${dateStr} ${time}`}::timestamp AT TIME ZONE 'Asia/Shanghai'`
}
