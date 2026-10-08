import { dailyPeriodInput } from '@/lib/daily-config'
const normalize = (row: any) => dailyPeriodInput.parse({ id:row.id,name:row.name,start:row.start_date,end:row.end_date,weeks:row.weeks,version:row.version })

export const monthOf = (row: any) => row.month_key || (/^\d{6}$/.test(row.name) ? row.name.slice(0,4)+'-'+row.name.slice(4) : String(row.end_date).slice(0,7));
export async function monthContext(query: (sql: string, args?: any[]) => Promise<any[]>, allowedStores: string[], date: string, payload: { periodId?: string } = {}) {
  const visible = await query(`SELECT p.* FROM daily_operating_periods p WHERE p.region_id IS NULL OR EXISTS(
    SELECT 1 FROM daily_operating_period_stores ps WHERE ps.period_id=p.id AND ps.store_id=ANY($1::text[]))
    ORDER BY p.start_date DESC,p.id`, [allowedStores]);
  const months = [...new Set(visible.map(monthOf))];
  const all = months.length ? await query(`SELECT * FROM daily_operating_periods WHERE COALESCE(month_key,to_char(end_date,'YYYY-MM'))=ANY($1::text[]) ORDER BY start_date DESC,id`, [months]) : [];
  const representatives = months.map(month => all.find((p: any)=>monthOf(p)===month && p.region_id==null) || all.find((p: any)=>monthOf(p)===month));
  let requested = payload.periodId ? all.find((p: any)=>p.id===payload.periodId) : null;
  if (payload.periodId && !requested) throw Error('NOT_FOUND: PK月份不存在或无权查看');
  if (!requested) requested = visible.find((p: any)=>p.start_date<=date && p.end_date>=date) || representatives[0];
  const monthKey = requested ? monthOf(requested) : null;
  const selected = representatives.find((p: any)=>monthOf(p)===monthKey);
  return { monthKey, period: selected ? normalize(selected) : null, periods: representatives.map(normalize), monthPeriods: all.filter((p: any)=>monthOf(p)===monthKey) };
}
