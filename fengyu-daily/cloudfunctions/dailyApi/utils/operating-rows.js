const keys = ['sales','consumption','visits','newCustomers','projects'];
function buildRows(objects, events, targetRows, period, week, cutoff, expand) {
  const targets = new Map(targetRows.map(t=>[`${t.scope}:${t.scope_id}`,t]));
  return objects.map(object=>{
    const target = targets.get(`${object.scope}:${object.scopeId}`);
    const configured = target?.month_confirmed ? expand(target,period) : null;
    const daily = events.filter(e=>e.scope===object.scope&&e.id===object.scopeId);
    const values = {};
    for(const key of keys){
      const sum=(a,b)=>daily.filter(e=>e.date>=a&&e.date<=b).reduce((n,e)=>n+Number(e[key]||0),0);
      values[key]={monthTarget:configured?.[key]??null,monthDone:sum(period.start,cutoff),weekTarget:configured?.weeks[week?.id]?.[key]??null,
        weekDone:week?sum(week.start,week.end<cutoff?week.end:cutoff):0,
        days:week?daily.filter(e=>e.date>=week.start&&e.date<=week.end).map(e=>({date:e.date,done:Number(e[key]||0)})):[],
        weeks:period.weeks.map(w=>({id:w.id,done:sum(w.start,w.end<cutoff?w.end:cutoff)}))};
      if(![values[key].monthDone,values[key].weekDone].every(Number.isSafeInteger))throw Error('INVALID_STATE: 统计值超出范围');
    }
    return {...object,values};
  });
}
module.exports={keys,buildRows};
