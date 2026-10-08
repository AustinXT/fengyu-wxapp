import { randomUUID } from 'node:crypto'
// 后台与云函数独立保留实现；一致性由跨端测试守护，不共享运行时目录。
type Query = (sql: string, args?: any[]) => Promise<any[]>
type Point = { monthOffset: number; day: number }
type Pattern = { start: Point; end: Point; weeks: { id: string; name: string; start: Point; end: Point }[] }
type Period = { id: string; name: string; start: string; end: string; weeks: { id: string; name: string; start: string; end: string }[] }
export const calendarToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
export function calendarMonth(key: string, offset = 0) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key) || !Number.isInteger(offset)) throw Error('INVALID_PARAMS: 请选择有效月份')
  return new Date(Date.UTC(Number(key.slice(0,4)), Number(key.slice(5))-1+offset, 1)).toISOString().slice(0,7)
}
const monthOf = (p: any): string => p.month_key || (/^\d{6}$/.test(p.name) ? p.name.slice(0,4)+'-'+p.name.slice(4) : p.end_date.slice(0,7))
export function calendarPoint(month: string, point: Point) {
  calendarMonth(month)
  if (!point || ![-1,0,1].includes(point.monthOffset) || !Number.isInteger(point.day) || point.day<1 || point.day>31) throw Error('INVALID_STATE: 日期规则格式有误')
  const d = new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5))-1+point.monthOffset,1))
  d.setUTCDate(Math.min(point.day,new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()))
  return d.toISOString().slice(0,10)
}
export function calendarPeriod(month: string, pattern: Pattern): Period {
  const start=calendarPoint(month,pattern.start), end=calendarPoint(month,pattern.end)
  if(!Array.isArray(pattern.weeks) || pattern.weeks.length<1 || pattern.weeks.length>31 || start>end) throw Error('INVALID_STATE: 经营月需配置1至31个有效经营周')
  const weeks=pattern.weeks.map(w=>({id:w.id,name:w.name,start:calendarPoint(month,w.start),end:calendarPoint(month,w.end)}))
  let expected=start
  const ids=new Set<string>()
  for(const w of weeks) {
    if(!w.id || ids.has(w.id) || !w.name || w.start!==expected || w.start>w.end || w.end>end) throw Error('INVALID_STATE: 经营周须连续、无重叠地覆盖经营月')
    ids.add(w.id); expected=new Date(Date.parse(w.end+'T12:00:00Z')+86400000).toISOString().slice(0,10)
  }
  if(expected!==new Date(Date.parse(end+'T12:00:00Z')+86400000).toISOString().slice(0,10)) throw Error('INVALID_STATE: 经营周须覆盖完整经营月')
  return {id:'preview',name:month.replace('-',''),start,end,weeks}
}
export function calendarRule(data: any, regionId: string, month: string) {
  const revisions=data.history.length ? data.history : data.modes.length ? [{validFrom:'0001-01-01',modes:data.modes}] : []
  for(const revision of revisions.slice().reverse()) {
    if(!Array.isArray(revision.modes)) throw Error('INVALID_STATE: 周期模式历史损坏')
    const specific=revision.modes.find((m:any)=>!m.isDefault && m.regionIds.includes(regionId))
    const base=revision.modes.find((m:any)=>m.isDefault)
    for(const mode of [specific,base]) {
      if(!mode) continue
      const pattern=mode.monthly?.[month] || mode.pattern
      const first=calendarPoint(month,pattern.start)
      if(first>=revision.validFrom && first>=(mode.effectiveFrom || '0001-01-01')) return {pattern,modeId:mode.id,revisionIndex:revisions.indexOf(revision),source:mode.monthly?.[month]?'month-override':mode.isDefault?'global-template':'region-template'}
      if(specific) break
    }
  }
  if(revisions.length) return null
  const specific=data.templates.find((t:any)=>t.region_id===regionId && !data.disabled.includes(t.id))
  const template=specific || data.templates.find((t:any)=>!t.region_id)
  if(!template) return null
  const override=data.overrides.find((o:any)=>o.template_id===template.id && o.month_key===month && o.region_id===regionId) || data.overrides.find((o:any)=>o.template_id===template.id && o.month_key===month && !o.region_id)
  return {pattern:override?.pattern || template.pattern,modeId:null,revisionIndex:-1,source:override?'month-override':specific?'region-template':'global-template'}
}
export async function calendarData(query: Query, allowedStores: string[] | null) {
  const [regions,templates,overrides,periods,configs,storeRows]=await Promise.all([
    query(`SELECT id,name FROM org_nodes WHERE type='市场' ORDER BY id`),
    query('SELECT * FROM daily_operating_period_templates'),query('SELECT * FROM daily_operating_period_overrides'),
    query('SELECT * FROM daily_operating_periods ORDER BY start_date DESC,id'),
    query(`SELECT key,value FROM system_configs WHERE key=ANY($1::text[])`,[['daily_cycle_modes','daily_cycle_mode_history','daily_period_inherited_templates']]),
    query(`WITH RECURSIVE lineage AS (SELECT s.store_id,n.id,n.type,n.parent_id FROM stores s JOIN org_nodes n ON n.id=s.org_node_id
      UNION ALL SELECT l.store_id,n.id,n.type,n.parent_id FROM lineage l JOIN org_nodes n ON n.id=l.parent_id)
      SELECT store_id,id AS region_id FROM lineage WHERE type='市场'`),
  ])
  const parse=(key:string,fallback:any[])=>{const raw=configs.find(c=>c.key===key)?.value;if(!raw)return fallback;try{const out=JSON.parse(raw);if(!Array.isArray(out))throw Error();return out}catch{throw Error('INVALID_STATE: 周期配置损坏，请联系管理员')}}
  const visible=allowedStores===null ? regions : regions.filter(r=>storeRows.some(s=>s.region_id===r.id && allowedStores.includes(s.store_id)))
  return {regions:visible,templates,overrides,periods,stores:storeRows,history:parse('daily_cycle_mode_history',[]),modes:parse('daily_cycle_modes',[]),disabled:parse('daily_period_inherited_templates',[])}
}
const stored=(data:any,region:string,key:string)=>data.periods.find((p:any)=>p.region_id===region && monthOf(p)===key) || data.periods.find((p:any)=>!p.region_id && monthOf(p)===key)
export function calendarPreview(data:any,region:any,key:string) {
  calendarMonth(key)
  const existing=stored(data,region.id,key), rule=calendarRule(data,region.id,key)
  const period=existing ? {id:existing.id,name:existing.name,start:existing.start_date,end:existing.end_date,weeks:existing.weeks} : rule ? calendarPeriod(key,rule.pattern) : null
  return {regionId:region.id,regionName:region.name,monthKey:key,modeId:rule?.modeId,period,existing:!!existing,status:existing?'已配置，保留原安排':'将自动安排'}
}
export function calendarPlan(data:any,date:string,requested?:string) {
  const rows:any[]=[]
  for(const region of data.regions) {
    const relevant=data.periods.filter((p:any)=>p.region_id===region.id || (!p.region_id && !data.periods.some((r:any)=>r.region_id===region.id && monthOf(r)===monthOf(p))))
    const active=relevant.filter((p:any)=>p.start_date<=date && p.end_date>=date)
    const current=active.find((p:any)=>p.region_id===region.id) || active.find((p:any)=>!p.region_id)
    let first=current ? monthOf(current) : ''
    if(!first) {
      const candidates=[-1,0,1].map(n=>calendarMonth(date.slice(0,7),n))
      first=candidates.find(key=>{const rule=calendarRule(data,region.id,key);if(!rule)return false;const p=calendarPeriod(key,rule.pattern);return p.start<=date && p.end>=date}) || ''
    }
    if(!first) throw Error(`INVALID_STATE: ${region.name}：当前日期没有可用的已生效规则，请配置经营周期`)
    let last=calendarMonth(first,2)
    if(requested && requested>last)last=requested
    for(let key=first;key<=last;key=calendarMonth(key,1)) {
      const row=calendarPreview(data,region,key)
      if(!row.period)throw Error(`INVALID_STATE: ${region.name} ${key}：没有可用的已生效规则`)
      if(!row.existing && row.period.end<date)throw Error(`INVALID_STATE: ${region.name} ${key}：历史月份不自动补造`)
      rows.push(row)
    }
  }
  for(const row of rows.filter(r=>!r.existing)) {
    const p=row.period, region=row.regionId
    const others=data.periods.filter((o:any)=>o.region_id===region || (!o.region_id && !data.periods.some((r:any)=>r.region_id===region && monthOf(r)===monthOf(o))))
    const overlap=others.find((o:any)=>o.start_date<=p.end && o.end_date>=p.start)
    if(overlap)throw Error(`INVALID_STATE: ${row.regionName} ${row.monthKey}：${p.start} 至 ${p.end}与已有月份${overlap.start_date} 至 ${overlap.end_date}重叠`)
    for(const offset of [-1,1]) {
      const key=calendarMonth(row.monthKey,offset)
      const neighbor=rows.find(r=>r.regionId===region && r.monthKey===key)?.period
        || (()=>{const o=stored(data,region,key);return o ? {start:o.start_date,end:o.end_date}:null})()
      if(neighbor && (offset===-1 ? Date.parse(p.start)-Date.parse(neighbor.end) : Date.parse(neighbor.start)-Date.parse(p.end))!==86400000)
        throw Error(`INVALID_STATE: ${row.regionName} ${row.monthKey}：新日期${p.start} 至 ${p.end}与已有相邻月份${neighbor.start} 至 ${neighbor.end}不连续；已有日期不会改写`)
    }
  }
  return rows
}
export async function ensureCalendar(query:Query,allowedStores:string[]|null,date=calendarToday(),requested?:string) {
  // 调用方必须在事务中使用同一连接，锁与规则保存共用一个键。
  await query("SELECT pg_advisory_xact_lock(hashtextextended('daily-period-config',0))")
  if(requested)calendarMonth(requested)
  const data=await calendarData(query,allowedStores)
  if(!data.templates.length && !data.history.length && !data.modes.length){
    if(data.regions.length)throw Error('INVALID_STATE: 尚未配置经营周期，请联系管理员保存日期规则')
    return {created:0,kept:0,rows:[],data}
  }
  const baseline=calendarPlan(data,date)
  const firstMonths=data.regions.map(r=>baseline.find(row=>row.regionId===r.id)?.monthKey).filter(Boolean).sort()
  if(requested && (!firstMonths.length || requested<firstMonths[0] || requested>calendarMonth(firstMonths[firstMonths.length-1],12))) throw Error('INVALID_PARAMS: 只能准备当前月起未来12个月')
  const rows=requested ? calendarPlan(data,date,requested) : baseline
  let created=0
  for(const row of rows.filter(r=>!r.existing)) {
    const id=randomUUID().replaceAll('-','').slice(0,30), p=row.period
    const template=data.templates.find(t=>t.region_id===row.regionId && !data.disabled.includes(t.id)) || data.templates.find(t=>!t.region_id)
    await query(`INSERT INTO daily_operating_periods(id,name,start_date,end_date,weeks,region_id,month_key,template_id,template_source)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,[id,p.name,p.start,p.end,JSON.stringify(p.weeks),row.regionId,row.monthKey,template?.id || null,calendarRule(data,row.regionId,row.monthKey)?.source || 'manual'])
    const stores=data.stores.filter(s=>s.region_id===row.regionId).map(s=>s.store_id)
    if(stores.length)await query('INSERT INTO daily_operating_period_stores(period_id,store_id) SELECT $1,unnest($2::text[])',[id,stores])
    await query(`INSERT INTO operation_logs(action,target_type,target_id,detail,source)
      VALUES('daily.period.generate','daily_operating_periods',$1,$2::jsonb,'dailyCalendar')`,[id,JSON.stringify({automatic:true,monthKey:row.monthKey,regionId:row.regionId,after:{...p,id}})])
    row.period.id=id;created++
  }
  return {created,kept:rows.length-created,rows,data}
}
