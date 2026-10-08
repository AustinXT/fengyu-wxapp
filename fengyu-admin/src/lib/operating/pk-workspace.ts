import type { AuthSession } from '@/lib/types'
import type { Filters, OperatingRow, Query } from './workspace'
import { isAdminScope } from '@/lib/session-role-guards'
import { monthContext } from './pk-month'
import { boardRows } from './pk-board'
import { directory } from './operating-objects'
export async function pkWorkspace(session: AuthSession, filters: Filters, query: Query, statsQuery: Query, date: string) {
  const all = await query('SELECT store_id FROM stores')
  const allowed: string[] = isAdminScope(session) || session.roles.some(r=>r.scopeType==='总部') ? all.map(s=>s.store_id) : session.permissions.scopeStoreIds
  if(filters.storeId && !allowed.includes(filters.storeId)) throw Error('PERMISSION_DENIED: 无此门店查看权限')
  const visible = await directory(query,allowed)
  if(filters.regionId && !visible.stores.some((s:any)=>s.market_id===filters.regionId)) throw Error('PERMISSION_DENIED: 无此区域查看权限')
  const context = await monthContext(query,allowed,date,filters)
  const classes = context.monthKey ? await query(`SELECT c.id,c.name FROM daily_pk_classes c JOIN daily_operating_periods p ON p.id=c.period_id
    WHERE COALESCE(c.month_key,p.month_key,to_char(p.end_date,'YYYY-MM'))=$1 AND EXISTS(
      SELECT 1 FROM daily_pk_stores ps WHERE ps.class_id=c.id AND ps.period_id=c.period_id AND ps.store_id=ANY($2::text[])) ORDER BY c.name,c.id`,[context.monthKey,allowed]) : []
  if(filters.classId && !classes.some(c=>c.id===filters.classId)) throw Error('PERMISSION_DENIED: 无此班级查看权限')
  const classIds = classes.filter(c=>!filters.classId || c.id===filters.classId).map(c=>c.id)
  const assignments = classIds.length ? await query('SELECT * FROM daily_pk_stores WHERE class_id=ANY($1::text[]) ORDER BY store_id',[classIds]) : []
  const rows: OperatingRow[] = await boardRows(query,statsQuery,assignments,context.monthPeriods,date)
  const period = context.period
  if(filters.weekId) throw Error('INVALID_PARAMS: 跨市场PK按各自当前经营周比较，不指定统一周编号')
  const week = period?.weeks.find(w=>w.start<=date && w.end>=date) || (period ? (date<period.start ? period.weeks[0] : period.weeks[period.weeks.length-1]) : null)
  const regions = [...new Set<string>(visible.stores.map((s:any)=>s.market_id).filter(Boolean))].map(id=>({id,name:visible.stores.find((s:any)=>s.market_id===id)?.area || id}))
  if(filters.employeeId && !rows.some(row=>row.employeeId===filters.employeeId)) throw Error('PERMISSION_DENIED: 无此员工查看权限')
  return {canConfigure:isAdminScope(session) && session.permissions.actions.includes('system:config'), filters, periods:context.periods, period, week, regions, stores:visible.stores,classes,ownScopes:[],rows}
}
