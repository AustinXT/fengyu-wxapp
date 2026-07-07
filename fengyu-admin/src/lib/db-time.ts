
import { sql } from 'drizzle-orm'
import { fmtDateTime } from './datetime'


export function nowTs() {
  return sql`NOW()`
}


export function beijingTs(d: Date) {
  const wallClock = fmtDateTime(d) 
  return sql`${wallClock}::timestamp`
}
