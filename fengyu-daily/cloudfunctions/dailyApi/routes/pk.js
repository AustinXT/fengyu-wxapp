const pg = require('../db/pg');
const { resolve } = require('./period');
const target = require('./target');
const { rankRows } = require('../utils/pk-rules');
const { visibleStores } = require('../utils/operating-visibility');
const jitDisabledQuery = require('../utils/query-with-jit-disabled');
async function classes(ctx) {
  const { period } = await resolve(pg.query, ctx.event.payload, ctx.auth);
  const allowed = await visibleStores(ctx.auth, pg);
  let rows = [];
  if (period) {
    // 组织授权只决定可进入的班级；进入后统一读取该班全部参与门店。
    rows = await pg.query(`SELECT c.id,c.name FROM daily_pk_classes c
      WHERE c.period_id=$1 AND EXISTS(SELECT 1 FROM daily_pk_stores ps
        WHERE ps.class_id=c.id AND ps.period_id=c.period_id AND ps.store_id=ANY($2::text[]))
      ORDER BY c.name,c.id`, [period.id, allowed]);
    if (rows.length) {
      const { directory, participantObjects } = require('../utils/operating-objects');
      const assignments = await pg.query(`SELECT * FROM daily_pk_stores
        WHERE period_id=$1 AND class_id=ANY($2::text[]) ORDER BY store_id`, [period.id, rows.map(row => row.id)]);
      const classStores = [...new Set(assignments.map(row => row.store_id))];
      const dir = await directory(pg.query, classStores);
      const participants = participantObjects(dir, assignments);
      rows = rows.map(row => ({ ...row,
        stores: assignments.filter(a => a.class_id === row.id).length,
        members: participants.filter(p => p.classId === row.id).length,
      }));
    }
  }
  ctx.result = { period, classes: rows, scopeLabel: allowed.length ? '同一班级统一展示全部参与人员及排名' : '尚未分配门店或 PK 归属，请联系管理员' };
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
  const assignments = await pg.query('SELECT * FROM daily_pk_stores WHERE period_id=$1 AND class_id=$2 ORDER BY store_id', [period.id,classId]);
  const classStores = [...new Set(assignments.map(row => row.store_id))];
  const dir = await directory(pg.query, classStores);
  const people = participantObjects(dir, assignments).filter(p=>p.classId===classId);
  const cutoff = date < period.end ? date : period.end;
  const targets = await pg.query('SELECT * FROM daily_operating_targets WHERE period_id=$1', [period.id]);
  const events = await series(jitDisabledQuery.query,{storeIds:classStores,employeeIds:people.map(p=>p.employeeId),start:period.start,end:cutoff});
  const firstVisits = await marketNewCustomers(jitDisabledQuery.query,classStores,period.start,cutoff);
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
  ctx.result = { period, week: active, class: klass, metric, rows: rankRows(rows, metric), scopeLabel: '同一班级统一展示全部参与人员及排名' };
}
module.exports = { classes, read };
