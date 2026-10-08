const { normalize } = require('../routes/period');
const { directory, participantObjects } = require('./operating-objects');
const { series, marketNewCustomers } = require('./operating-series');
const { buildRows } = require('./operating-rows');
const { expand } = require('../routes/target');
async function boardRows(query, statsQuery, assignments, monthPeriods, date) {
  const storeIds = [...new Set(assignments.map(a=>a.store_id))];
  const dir = await directory(query,storeIds);
  const people = participantObjects(dir,assignments);
  if (!people.length) return [];
  const periodIds = monthPeriods.map(p=>p.id);
  const snapshots = await query('SELECT period_id,store_id FROM daily_operating_period_stores WHERE period_id=ANY($1::text[])', [periodIds]);
  const contexts = people.map(person=>{
    const matches = monthPeriods.filter(p=>p.region_id!=null && (person.scope==='market' ? p.region_id===person.marketId : snapshots.some(s=>s.period_id===p.id && s.store_id===person.storeId)));
    if(matches.length>1) throw Error('INVALID_STATE: PK参与人员经营月份配置重复');
    const row = matches[0] || monthPeriods.find(p=>p.region_id==null);
    if(!row) throw Error('INVALID_STATE: 参与门店尚未配置该经营月份，请先生成经营日历');
    const period = normalize(row);
    const week = period.weeks.find(w=>w.start<=date && w.end>=date) || (date<period.start ? period.weeks[0] : period.weeks[period.weeks.length-1]);
    return { person,period,week,cutoff:date<period.end ? date : period.end };
  });
  const start = contexts.map(c=>c.period.start).sort()[0];
  const end = contexts.map(c=>c.cutoff).sort().reverse()[0];
  const [events,targets,first] = await Promise.all([
    start<=end ? series(statsQuery,{storeIds,employeeIds:people.map(p=>p.employeeId),start,end}) : [],
    query('SELECT * FROM daily_operating_targets WHERE period_id=ANY($1::text[])',[periodIds]),
    start<=end ? marketNewCustomers(statsQuery,storeIds,start,end) : [],
  ]);
  for(const marketId of dir.fullMarkets) {
    const inMarket = id=>dir.stores.some(s=>s.id===id && s.market_id===marketId);
    for(const day of new Set(events.filter(e=>e.scope==='store' && inMarket(e.id)).map(e=>e.date))) {
      const daily = events.filter(e=>e.scope==='store' && e.date===day && inMarket(e.id));
      events.push({scope:'market',id:marketId,date:day,sales:daily.reduce((n,r)=>n+Number(r.sales),0),consumption:daily.reduce((n,r)=>n+Number(r.consumption),0),visits:daily.reduce((n,r)=>n+Number(r.visits),0),projects:daily.reduce((n,r)=>n+Number(r.projects),0),newCustomers:new Set(first.filter(r=>r.date===day && inMarket(r.store_id)).map(r=>r.client_user_id)).size});
    }
  }
  return contexts.map(({person,period,week,cutoff})=>({
    ...buildRows([person],events,targets.filter(t=>t.period_id===period.id),period,week,cutoff,expand)[0],
    periodStart:period.start,periodEnd:period.end,weekStart:week.start,weekEnd:week.end,
  }));
}
module.exports = { boardRows };
