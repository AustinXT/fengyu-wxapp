import { dailyPeriodInput } from '@/lib/daily-config'
const normalize = (row: any) => dailyPeriodInput.parse({ id:row.id,name:row.name,start:row.start_date,end:row.end_date,weeks:row.weeks,version:row.version })
import { directory, participantObjects } from './operating-objects'
import { series, marketNewCustomers } from './operating-series'
import { buildRows } from './operating-rows'
import { expand } from './target-write'
export async function boardRows(query: any, statsQuery: any, assignments: any[], monthPeriods: any[], date: string) {
  const storeIds = [...new Set(assignments.map((a: any)=>a.store_id))];
  const dir = await directory(query,storeIds);
  const people = participantObjects(dir,assignments);
  if (!people.length) return [];
  const periodIds = monthPeriods.map((p: any)=>p.id);
  const snapshots = await query('SELECT period_id,store_id FROM daily_operating_period_stores WHERE period_id=ANY($1::text[])', [periodIds]);
  const contexts = people.map((person: any)=>{
    const matches = monthPeriods.filter((p: any)=>p.region_id!=null && (person.scope==='market' ? p.region_id===person.marketId : snapshots.some((s: any)=>s.period_id===p.id && s.store_id===person.storeId)));
    if(matches.length>1) throw Error('INVALID_STATE: PK参与人员经营月份配置重复');
    const row = matches[0] || monthPeriods.find((p: any)=>p.region_id==null);
    if(!row) throw Error('INVALID_STATE: 参与门店尚未配置该经营月份，请先生成经营日历');
    const period = normalize(row);
    const week = period.weeks.find(w=>w.start<=date && w.end>=date) || (date<period.start ? period.weeks[0] : period.weeks[period.weeks.length-1]);
    return { person,period,week,cutoff:date<period.end ? date : period.end };
  });
  const start = contexts.map((c: any)=>c.period.start).sort()[0];
  const end = contexts.map((c: any)=>c.cutoff).sort().reverse()[0];
  const [events,targets,first] = await Promise.all([
    start<=end ? series(statsQuery,{storeIds,employeeIds:people.map((p: any)=>p.employeeId),start,end}) : [],
    query('SELECT * FROM daily_operating_targets WHERE period_id=ANY($1::text[])',[periodIds]),
    start<=end ? marketNewCustomers(statsQuery,storeIds,start,end) : [],
  ]);
  for(const marketId of dir.fullMarkets) {
    const inMarket = (id: any)=>dir.stores.some((s: any)=>s.id===id && s.market_id===marketId);
    for(const day of new Set(events.filter((e: any)=>e.scope==='store' && inMarket(e.id)).map((e: any)=>e.date))) {
      const daily = events.filter((e: any)=>e.scope==='store' && e.date===day && inMarket(e.id));
      events.push({scope:'market',id:marketId,date:day,sales:daily.reduce((n: number,r: any)=>n+Number(r.sales),0),consumption:daily.reduce((n: number,r: any)=>n+Number(r.consumption),0),visits:daily.reduce((n: number,r: any)=>n+Number(r.visits),0),projects:daily.reduce((n: number,r: any)=>n+Number(r.projects),0),newCustomers:new Set(first.filter((r: any)=>r.date===day && inMarket(r.store_id)).map((r: any)=>r.client_user_id)).size});
    }
  }
  return contexts.map(({person,period,week,cutoff}: any)=>({
    ...buildRows([person],events,targets.filter((t: any)=>t.period_id===period.id),period,week,cutoff,expand)[0],
    periodStart:period.start,periodEnd:period.end,weekStart:week.start,weekEnd:week.end,
  }));
}
