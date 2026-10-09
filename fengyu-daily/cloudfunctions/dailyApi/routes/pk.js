const pg = require('../db/pg');
const v = require('../utils/validation');
const { rankBothMetrics } = require('../utils/pk-rules');
const { visibleStores } = require('../utils/operating-visibility');
const { monthContext } = require('../utils/pk-month');
const { boardRows } = require('../utils/pk-board');
const jitDisabledQuery = require('../utils/query-with-jit-disabled');
const scopeLabel = '总部按月统一分班；同班展示全部参与人员，指标按各自市场的经营日期计算';
async function visibleClasses(query,monthKey,allowed) {
  if(!monthKey) return [];
  return query(`SELECT c.id,c.name FROM daily_pk_classes c JOIN daily_operating_periods p ON p.id=c.period_id
    WHERE COALESCE(c.month_key,p.month_key,to_char(p.end_date,'YYYY-MM'))=$1
    AND EXISTS(SELECT 1 FROM daily_pk_stores ps WHERE ps.class_id=c.id AND ps.period_id=c.period_id AND ps.store_id=ANY($2::text[]))
    ORDER BY c.name,c.id`,[monthKey,allowed]);
}
async function classes(ctx) {
  const allowed = await visibleStores(ctx.auth,pg);
  const data = await monthContext(pg.query,allowed,v.date(ctx.event.payload?.date),ctx.event.payload);
  let rows = await visibleClasses(pg.query,data.monthKey,allowed);
  if(rows.length) {
    const assignments = await pg.query('SELECT * FROM daily_pk_stores WHERE class_id=ANY($1::text[]) ORDER BY store_id',[rows.map(r=>r.id)]);
    const {directory,participantObjects}=require('../utils/operating-objects');
    const dir=await directory(pg.query,[...new Set(assignments.map(a=>a.store_id))]);
    const participants=participantObjects(dir,assignments);
    rows=rows.map(row=>({...row,stores:assignments.filter(a=>a.class_id===row.id).length,members:participants.filter(p=>p.classId===row.id).length}));
  }
  ctx.result={period:data.period,periods:data.periods,classes:rows,scopeLabel};
}
async function read(ctx) {
  const payload=ctx.event.payload || {};
  const date=v.date(payload.date);
  const allowed=await visibleStores(ctx.auth,pg);
  const data=await monthContext(pg.query,allowed,date,payload);
  if(!data.period) throw Error('NOT_FOUND: 经营月份不存在');
  const classId=v.text(payload.classId,100);
  const klass=(await visibleClasses(pg.query,data.monthKey,allowed)).find(c=>c.id===classId);
  if(!klass) throw Error('NOT_FOUND: 班级不存在或无权查看');
  const assignments=await pg.query('SELECT * FROM daily_pk_stores WHERE class_id=$1 ORDER BY store_id',[classId]);
  const rows=await boardRows(pg.query,jitDisabledQuery.query,assignments,data.monthPeriods,date);
  const metric=payload.metric || 'sales';
  const week=data.period.weeks.find(w=>w.start<=date && w.end>=date) || (date<data.period.start?data.period.weeks[0]:data.period.weeks[data.period.weeks.length-1]);
  ctx.result={period:data.period,week,class:klass,metric,rows:rankBothMetrics(rows.map(r=>({...r,...r.values})),metric),scopeLabel};
}
module.exports={classes,read};
