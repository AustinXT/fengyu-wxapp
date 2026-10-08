import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { ensureCalendar, calendarToday } from './daily-calendar-auto'
export function calendarQuery(executor: { execute: typeof db.execute }) {
  return async (text: string, args: any[] = []) => {
    const parts=text.split(/(\$\d+)/g).filter(Boolean).map(part=>{
      if(!/^\$\d+$/.test(part))return sql.raw(part)
      const value=args[Number(part.slice(1))-1]
      const bound=Array.isArray(value)?'{'+value.map(v=>JSON.stringify(String(v))).join(',')+'}':value
      return sql`${bound}`
    })
    return Array.from(await executor.execute(sql.join(parts,sql.raw(''))))
  }
}
export async function automaticCalendar(allowedStores: string[] | null, requested?: string) {
  return db.transaction(tx=>ensureCalendar(calendarQuery(tx),allowedStores,calendarToday(),requested))
}
