const pg = require('../db/pg');
const { resolve } = require('./period');
const target = require('./target');
const { rankRows } = require('../utils/pk-rules');
const { visibleStores } = require('../utils/operating-visibility');
async function classes(ctx) {
  const { period } = await resolve(pg.query, ctx.event.payload, ctx.auth);
  const allowed = await visibleStores(ctx.auth, pg);
  let rows = [];
  if (period) {
    const { directory, participantObjects } = require('../utils/operating-objects');
    const dir = await directory(pg.query, allowed);
    const assignments = await pg.query('SELECT * FROM daily_pk_stores WHERE period_id=$1 AND store_id=ANY($2::text[]) ORDER BY store_id', [period.id, allowed]);
    const participants = participantObjects(dir, assignments);
    rows = await pg.query(`SELECT c.id,c.name,count(DISTINCT ps.store_id)::int AS stores
      FROM daily_pk_classes c JOIN daily_pk_stores ps ON ps.class_id=c.id AND ps.period_id=c.period_id
      WHERE c.period_id=$1 AND ps.store_id=ANY($2::text[]) GROUP BY c.id,c.name ORDER BY c.name`, [period.id, allowed]);
    rows = rows.map(row => ({...row, members: participants.filter(p => p.classId === row.id).length}));
  }
  ctx.result = { period, classes: rows, scopeLabel: allowed.length ? '人数及排名仅统计您有权限查看的门店' : '尚未分配门店或 PK 归属，请联系管理员' };
}
async function read(ctx) {
  const { date, period, week } = await resolve(pg.query, ctx.event.payload, ctx.auth);
  if (!period) throw Error('NOT_FOUND: 经营周期不存在');
  const active = week || [...period.weeks].reverse().find((w) => w.start <= date);
  if (!active) throw Error('INVALID_STATE: 经营月尚未开始');
  const classId = ctx.event.payload?.classId;
  if (typeof classId !== 'string' || classId.length > 100) throw Error('INVALID_PARAMS: 缺少PK班级');
  const allowedStores = await visibleStores(ctx.auth, pg);
  const [klass] = await pg.query(`SELECT c.id,c.name FROM daily_pk_classes c WHERE c.id=$1 AND c.period_id=$2
    AND EXISTS(SELECT 1 FROM daily_pk_stores ps WHERE ps.class_id=c.id AND ps.period_id=c.period_id AND ps.store_id=ANY($3::text[]))`,
  [classId, period.id, allowedStores]);
  if (!klass) throw Error('NOT_FOUND: 班级不存在或无权查看');
  const { directory, participantObjects } = require('../utils/operating-objects');
  const { series, marketNewCustomers } = require('../utils/operating-series');
  const { buildRows } = require('../utils/operating-rows');
  const dir = await directory(pg.query, allowedStores);
  const assignments = await pg.query('SELECT * FROM daily_pk_stores WHERE period_id=$1 AND store_id=ANY($2::text[]) ORDER BY store_id', [period.id,allowedStores]);
  const people = participantObjects(dir, assignments).filter(p=>p.classId===classId);
  const cutoff = date < period.end ? date : period.end;
  const targets = await pg.query('SELECT * FROM daily_operating_targets WHERE period_id=$1', [period.id]);
  const events = await series(pg.query,{storeIds:allowedStores,employeeIds:people.map(p=>p.employeeId),start:period.start,end:cutoff});
  const firstVisits = await marketNewCustomers(pg.query,allowedStores,period.start,cutoff);
  for (const marketId of dir.fullMarkets) {
    const dates = [...new Set(events.filter(e=>e.scope==='store'&&dir.stores.find(s=>s.id===e.id)?.market_id===marketId).map(e=>e.date))];
    for(const day of dates) {
      const rows = events.filter(e=>e.scope==='store'&&e.date===day&&dir.stores.find(s=>s.id===e.id)?.market_id===marketId);
      events.push({scope:'market',id:marketId,date:day,sales:rows.reduce((n,r)=>n+Number(r.sales),0),consumption:rows.reduce((n,r)=>n+Number(r.consumption),0),
        visits:rows.reduce((n,r)=>n+Number(r.visits),0),projects:rows.reduce((n,r)=>n+Number(r.projects),0),
        newCustomers:new Set(firstVisits.filter(r=>r.date===day&&dir.stores.find(s=>s.id===r.store_id)?.market_id===marketId).map(r=>r.client_user_id)).size});
    }
  }
  const rows = buildRows(people,events,targets,period,active,cutoff,target.expand).map(r=>({...r,...r.values}));
  const metric = ctx.event.payload?.metric || 'sales';
  ctx.result = { period, week: active, class: klass, metric, rows: rankRows(rows, metric), scopeLabel: '排名仅统计授权门店' };
}
module.exports = { classes, read };
