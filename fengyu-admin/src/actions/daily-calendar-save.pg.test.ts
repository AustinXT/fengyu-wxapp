import {describe,it,expect,vi,afterAll} from 'vitest'
import type {AuthSession} from '@/lib/types'
const state=vi.hoisted(()=>{const url=process.env.DAILY_TEST_DATABASE_URL;if(url){const p=new URL(url);if(p.hostname!=='101.34.242.103'||p.port!=='8151'||p.pathname.slice(1)!==process.env.DAILY_TEST_TEMP_DB||!/^daily_regression_[a-f0-9]{24}$/.test(p.pathname.slice(1)))throw Error('只允许独立临时库');process.env.E2E_DATABASE_URL=url;}return {url,session:null as AuthSession|null}})
vi.mock('@/lib/auth',()=>({getSession:async()=>state.session}))
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}))
import {db} from '@/db'
import {writeTarget} from '@/lib/operating/target-write'
import {queryWith} from '@/lib/operating/workspace'
import {sql} from 'drizzle-orm'
import {buildDailyPeriod,defaultDailyCyclePattern} from '@/lib/daily-period-template'
import {getDailyConfiguration,saveDailyCycleModes,selectDailyPkMonth} from './daily-config'
const point=(day:number)=>({monthOffset:0 as const,day})
const pattern={start:point(1),end:point(31),weeks:[[1,7],[8,14],[15,21],[22,31]].map(([a,b],i)=>({id:'w'+i,name:'第'+(i+1)+'周',start:point(a),end:point(b)}))}
describe.skipIf(!state.url)('保存自动沿用真实PG',()=>{
const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse('2028-02-08T04:00:00Z'))
it('首次保存真实模式同事务补齐当前与两个月，无需手动生成',async()=>{
 await db.execute(sql`INSERT INTO org_nodes(id,name,type) VALUES('head','总部','总部')`)
 for(const r of ['a','b']){await db.execute(sql`INSERT INTO org_nodes(id,name,type,parent_id) VALUES(${r},${'市场'+r},'市场','head')`);await db.execute(sql`INSERT INTO org_nodes(id,name,type,parent_id) VALUES(${'n'+r},${'门店'+r},'门店',${r})`);await db.execute(sql`INSERT INTO stores(store_id,store_name,org_node_id) VALUES(${'s'+r},${'门店'+r},${'n'+r})`)}
 await db.execute(sql`INSERT INTO staff_wechat_users(employee_id,name,store_id) VALUES('employee','配置测试','sa')`)
 state.session={employeeId:'employee',name:'配置测试',phone:'',roles:[{role:'admin',scopeId:'head',scopeType:'总部',isSuperAdmin:true}],permissions:{actions:['system:config'],scopeStoreIds:[]}}
 const c=await getDailyConfiguration()
 const result=await saveDailyCycleModes([{id:'base',name:'自然月',isDefault:true,regionIds:[],effectiveFrom:'2028-02-01',pattern}],c.modesRevision)
 expect(result.automatic.created).toBe(6)
 const after=await getDailyConfiguration();expect(after.periods).toHaveLength(6);expect(after.periods.filter(p=>p.monthKey==='2028-02').every(p=>p.end==='2028-02-29')).toBe(true)
},30000)
it('规则另存版本，已配置未来月份及编号保持原值，返回最早缺少月份',async()=>{
 const c=await getDailyConfiguration();const next=structuredClone(pattern);next.weeks[0].end.day=6;next.weeks[1].start.day=7
 const result=await saveDailyCycleModes([{...c.cycleModes[0],pattern:next}],c.modesRevision)
 expect(result.automatic.created).toBe(0);expect(result.automatic.keptMonths).toEqual(['2028-02','2028-03','2028-04']);expect(result.automatic.boundaries.every(r=>r.month==='2028-05')).toBe(true)
 expect((await getDailyConfiguration()).periods).toEqual(c.periods)
},30000)
it('草稿预览只读，未来旧安排按范围替换，当前月份保留，新增业务使令牌失效',async()=>{
 const c=await getDailyConfiguration();const next=structuredClone(pattern);next.weeks[0].end.day=5;next.weeks[1].start.day=6
 const modes=c.cycleModes.map(m=>({...m,pattern:next}))
 const range={from:'2028-02',to:'2028-04',modeId:modes[0].id}
 const preview=await saveDailyCycleModes(modes,c.modesRevision,'',true,range)
 expect(preview.automatic.calendar?.issues).toEqual([])
 expect(preview.automatic.calendar?.rows.filter(r=>r.month==='2028-02').every(r=>r.action==='keep')).toBe(true)
 expect(preview.automatic.calendar?.rows.filter(r=>r.month!=='2028-02').every(r=>r.action==='update')).toBe(true)
 expect((await getDailyConfiguration()).periods).toEqual(c.periods)
 const march=c.periods.find(p=>p.regionId==='a'&&p.monthKey==='2028-03')!
 await db.execute(sql`INSERT INTO daily_operating_targets(period_id,scope,scope_id,sales,consumption) VALUES(${march.id},'market','a',100,200)`)
 await expect(saveDailyCycleModes(modes,c.modesRevision,preview.automatic.token,false,range)).rejects.toThrow('重新预览')
 expect((await getDailyConfiguration()).modesRevision).toBe(c.modesRevision)
 expect((await getDailyConfiguration()).periods).toEqual(c.periods)
 await db.execute(sql`DELETE FROM daily_operating_targets WHERE period_id=${march.id}`)
 const fresh=await saveDailyCycleModes(modes,c.modesRevision,'',true,range)
 await saveDailyCycleModes(modes,c.modesRevision,fresh.automatic.token,false,range)
 const after=await getDailyConfiguration()
 expect(after.periods.filter(p=>p.monthKey==='2028-02')).toEqual(c.periods.filter(p=>p.monthKey==='2028-02'))
 expect(after.periods.filter(p=>p.monthKey!=='2028-02').every(p=>p.weeks[0].end.endsWith('-05'))).toBe(true)
 expect(after.periods.map(p=>p.id).sort()).toEqual(c.periods.map(p=>p.id).sort())
 expect(after.periods.map(p=>p.weeks.map(w=>w.id))).toEqual(c.periods.map(p=>p.weeks.map(w=>w.id)))
},30000)
it('范围外相邻月份断档只在预览提示，确认应用不写入；人工月份不批量替换',async()=>{
 const c=await getDailyConfiguration();const cross={start:{monthOffset:-1 as const,day:26},end:point(25),weeks:[{id:'one',name:'整月',start:{monthOffset:-1 as const,day:26},end:point(25)}]}
 const modes=c.cycleModes.map(m=>({...m,pattern:cross}))
 const range={from:'2028-03',to:'2028-04',modeId:modes[0].id}
 const preview=await saveDailyCycleModes(modes,c.modesRevision,'',true,range)
 expect(preview.automatic.calendar?.issues.some(i=>i.message.includes('重叠'))).toBe(true)
 await expect(saveDailyCycleModes(modes,c.modesRevision,preview.automatic.token,false,range)).rejects.toThrow('重叠')
 expect((await getDailyConfiguration()).periods).toEqual(c.periods)
 const march=c.periods.find(p=>p.regionId==='a'&&p.monthKey==='2028-03')!
 await db.execute(sql`UPDATE daily_operating_periods SET template_source='manual' WHERE id=${march.id}`)
 const changed=structuredClone(pattern);changed.weeks[0].end.day=4;changed.weeks[1].start.day=5
 const kept=await saveDailyCycleModes(c.cycleModes.map(m=>({...m,pattern:changed})),c.modesRevision,'',true,range)
 expect(kept.automatic.calendar?.rows.find(r=>r.regionId==='a'&&r.month==='2028-03')).toMatchObject({action:'keep',source:'manual'})
 await db.execute(sql`UPDATE daily_operating_periods SET template_source='global-template' WHERE id=${march.id}`)
},30000)
it('已配置未来月份可明确调整，普通规则和其他月份保持原值',async()=>{
 const c=await getDailyConfiguration();const special=structuredClone(pattern);special.weeks[0].end.day=6;special.weeks[1].start.day=7
 const modes=[{...c.cycleModes[0],monthly:{'2028-03':special}}]
 const preview=await saveDailyCycleModes(modes,c.modesRevision,'',true)
 expect(preview.automatic.impact).toHaveLength(2)
 expect((await getDailyConfiguration()).periods).toEqual(c.periods)
 await saveDailyCycleModes(modes,c.modesRevision,preview.automatic.token)
 const after=await getDailyConfiguration()
 expect(after.periods.filter(p=>p.monthKey!=='2028-03')).toEqual(c.periods.filter(p=>p.monthKey!=='2028-03'))
 expect(after.periods.filter(p=>p.monthKey==='2028-03').every(p=>p.weeks[0].end==='2028-03-06')).toBe(true)
 expect(after.periods.filter(p=>p.monthKey==='2028-03').map(p=>p.weeks.map(w=>w.id))).toEqual(c.periods.filter(p=>p.monthKey==='2028-03').map(p=>p.weeks.map(w=>w.id)))
},30000)
it('当前月份必须确认，非法衔接完整回滚，恢复普通规则也预览',async()=>{
 const c=await getDailyConfiguration();const special=structuredClone(pattern);special.weeks[0].end.day=6;special.weeks[1].start.day=7
 const modes=[{...c.cycleModes[0],monthly:{...c.cycleModes[0].monthly,'2028-02':special}}]
 await expect(saveDailyCycleModes(modes,c.modesRevision)).rejects.toThrow('确认应用')
 const preview=await saveDailyCycleModes(modes,c.modesRevision,'',true)
 await saveDailyCycleModes(modes,c.modesRevision,preview.automatic.token)
 const after=await getDailyConfiguration();const malformed=structuredClone(special);malformed.start.day=2;malformed.weeks[0].start.day=2
 await expect(saveDailyCycleModes([{...after.cycleModes[0],monthly:{...after.cycleModes[0].monthly,'2028-03':malformed}}],after.modesRevision,'',true)).rejects.toThrow('不连续')
 expect((await getDailyConfiguration()).periods).toEqual(after.periods)
 const restored=[{...after.cycleModes[0],monthly:{}}];const restorePreview=await saveDailyCycleModes(restored,after.modesRevision,'',true)
 expect(restorePreview.automatic.impact).toHaveLength(4)
 await saveDailyCycleModes(restored,after.modesRevision,restorePreview.automatic.token)
},30000)
it('旧全局月份只修正选中市场，保留目标数值、其他市场、日报快照及PK分班',async()=>{
 const c=await getDailyConfiguration();const old=c.periods.find(p=>p.monthKey==='2028-04')!
 await db.execute(sql`DELETE FROM daily_operating_period_stores WHERE period_id IN (SELECT id FROM daily_operating_periods WHERE month_key='2028-04')`)
 await db.execute(sql`DELETE FROM daily_operating_periods WHERE month_key='2028-04'`)
 await db.execute(sql`INSERT INTO daily_operating_periods(id,name,start_date,end_date,weeks,month_key) VALUES('global-april','202804','2028-04-01','2028-04-30',${JSON.stringify(old.weeks)}::jsonb,'2028-04')`)
 await db.execute(sql`INSERT INTO daily_operating_targets(period_id,scope,scope_id,sales,consumption,weeks,version) VALUES('global-april','personal','employee',100,200,'{}',3)`)
 await db.execute(sql`INSERT INTO daily_pk_classes(id,period_id,month_key,name) VALUES('class','global-april','2028-04','旧班级')`)
 await db.execute(sql`INSERT INTO daily_pk_stores(period_id,store_id,class_id,month_key) VALUES('global-april','sa','class','2028-04')`)
 await db.execute(sql`INSERT INTO daily_reports(id,employee_id,report_date,store_id,employee_name,store_name,status,submitted_at,period_snapshot,metric_snapshot) VALUES('snapshot','employee','2028-04-08','sa','测试','门店a','submitted',now(),'{}','{}')`)
 const current=await getDailyConfiguration();const special=structuredClone(pattern);special.weeks[0].end.day=6;special.weeks[1].start.day=7
 const modes=[...current.cycleModes,{id:'special-a',name:'市场a模式',isDefault:false,regionIds:['a'],effectiveFrom:'0001-01-01',pattern,monthly:{'2028-04':special}}]
 const beforeReports=await db.execute(sql`SELECT * FROM daily_reports`);const beforePk=await db.execute(sql`SELECT * FROM daily_pk_stores`)
 const preview=await saveDailyCycleModes(modes,current.modesRevision,'',true)
 expect(preview.automatic.impact.map(r=>r.market)).toEqual(['市场a'])
 expect(preview.automatic.impact[0]).toMatchObject({reports:1,targets:1,classes:1})
 await expect(saveDailyCycleModes(modes,current.modesRevision)).rejects.toThrow('确认应用')
 await saveDailyCycleModes(modes,current.modesRevision,preview.automatic.token)
 const after=await getDailyConfiguration();const regional=after.periods.find(p=>p.regionId==='a'&&p.monthKey==='2028-04')!
 expect(regional.weeks[0].end).toBe('2028-04-06');expect(after.periods.find(p=>p.id==='global-april')!.weeks).toEqual(old.weeks)
 expect(await db.execute(sql`SELECT sales::int,consumption::int,version FROM daily_operating_targets WHERE period_id=${regional.id}`)).toEqual([{sales:100,consumption:200,version:3}])
 expect(await db.execute(sql`SELECT count(*)::int AS count FROM daily_operating_targets`)).toEqual([{count:1}])
 await expect(writeTarget((work:(query:ReturnType<typeof queryWith>)=>Promise<unknown>)=>db.transaction(tx=>work(queryWith(tx))),[{scope:'personal',scopeId:'employee'}],{scope:'personal',scopeId:'employee',periodId:'global-april',periodVersion:1,version:0},true)).rejects.toThrow('已调整特殊月份')
 expect(await db.execute(sql`SELECT * FROM daily_reports`)).toEqual(beforeReports);expect(await db.execute(sql`SELECT * FROM daily_pk_stores`)).toEqual(beforePk)
},30000)
it('历史月份拒绝，预览后新增业务需要重新确认，业务月份不可增减周',async()=>{
 const c=await getDailyConfiguration();const current=c.cycleModes.find(m=>!m.isDefault)!;const special=structuredClone(pattern);special.weeks[0].end.day=5;special.weeks[1].start.day=6
 const modes=c.cycleModes.map(m=>m.id===current.id ? {...m,monthly:{'2028-04':special}}:m)
 const preview=await saveDailyCycleModes(modes,c.modesRevision,'',true)
 await db.execute(sql`INSERT INTO daily_reports(id,employee_id,report_date,store_id,employee_name,store_name) VALUES('new-business','employee','2028-04-09','sa','测试','门店a')`)
 await expect(saveDailyCycleModes(modes,c.modesRevision,preview.automatic.token)).rejects.toThrow('重新预览')
 expect((await getDailyConfiguration()).periods).toEqual(c.periods)
 const one={...special,weeks:[{id:'one',name:'整月',start:point(1),end:point(31)}]}
 await expect(saveDailyCycleModes(c.cycleModes.map(m=>m.id===current.id ? {...m,monthly:{'2028-04':one}}:m),c.modesRevision,'',true)).rejects.toThrow('不能增减经营周')
 clock.mockReturnValue(Date.parse('2028-05-08T04:00:00Z'))
 await expect(saveDailyCycleModes(modes,c.modesRevision,'',true)).rejects.toThrow('已结束')
 clock.mockReturnValue(Date.parse('2028-02-08T04:00:00Z'))
},30000)
it('PK未来月份自动准备全部市场，旧月份不复制班级，非法范围拒绝',async()=>{
 const c=await selectDailyPkMonth('2028-06');expect(c.periods.filter(p=>p.monthKey==='2028-06')).toHaveLength(2);expect(c.classes.filter(p=>c.periods.some(r=>r.id===p.periodId&&r.monthKey==='2028-06'))).toHaveLength(0)
 await expect(selectDailyPkMonth('2029-03')).rejects.toThrow('未来12个月');await expect(selectDailyPkMonth('2028-13')).rejects.toThrow('有效月份')
},15000)
it('草稿应用可以新增未来月份；当前月份调整需要同一预览的确认令牌',async()=>{
 const c=await getDailyConfiguration();const mode=c.cycleModes.find(m=>m.isDefault)!
 const range={from:'2028-07',to:'2028-08',modeId:mode.id}
 // 范围前6月已在上一用例准备，未来普通规则自然月相接。
 const preview=await saveDailyCycleModes(c.cycleModes,c.modesRevision,'',true,range)
 expect(preview.automatic.calendar?.issues).toEqual([])
 expect(preview.automatic.calendar?.rows.every(r=>r.action==='create')).toBe(true)
 await saveDailyCycleModes(c.cycleModes,c.modesRevision,preview.automatic.token,false,range)
 const created=await getDailyConfiguration();expect(created.periods.some(p=>p.monthKey==='2028-08')).toBe(true)
 const pattern2=structuredClone(pattern);pattern2.weeks[0].end.day=4;pattern2.weeks[1].start.day=5
 const modes=created.cycleModes.map(m=>m.id===mode.id?{...m,monthly:{...m.monthly,'2028-02':pattern2}}:m)
 const currentRange={from:'2028-02',to:'2028-02',modeId:mode.id}
 const current=await saveDailyCycleModes(modes,created.modesRevision,'',true,currentRange)
 expect(current.automatic.calendar?.issues).toEqual([])
 expect(current.automatic.impact.some(r=>r.requiresConfirmation)).toBe(true)
 await expect(saveDailyCycleModes(modes,created.modesRevision,'',false,currentRange)).rejects.toThrow('确认应用')
 expect((await getDailyConfiguration()).periods).toEqual(created.periods)
 await saveDailyCycleModes(modes,created.modesRevision,current.automatic.token,false,currentRange)
 expect((await getDailyConfiguration()).periods.find(p=>p.regionId==='b'&&p.monthKey==='2028-02')!.weeks[0].end).toBe('2028-02-04')
},30000)
it('应用中途数据库拒绝插入时，规则与已写入月份全部回滚',async()=>{
 const c=await getDailyConfiguration();const mode=c.cycleModes.find(m=>m.isDefault)!
 const next=structuredClone(pattern);next.weeks[0].end.day=3;next.weeks[1].start.day=4
 const modes=c.cycleModes.map(m=>m.id===mode.id?{...m,pattern:next}:m)
 const range={from:'2028-09',to:'2028-10',modeId:mode.id}
 const preview=await saveDailyCycleModes(modes,c.modesRevision,'',true,range)
 expect(preview.automatic.calendar?.issues).toEqual([])
 await db.execute(sql`ALTER TABLE daily_operating_periods ADD CONSTRAINT draft_apply_test_failure CHECK (month_key IS DISTINCT FROM '2028-10')`)
 try {
   await expect(saveDailyCycleModes(modes,c.modesRevision,preview.automatic.token,false,range)).rejects.toThrow()
   const after=await getDailyConfiguration()
   expect(after.modesRevision).toBe(c.modesRevision)
   expect(after.periods).toEqual(c.periods)
 } finally { await db.execute(sql`ALTER TABLE daily_operating_periods DROP CONSTRAINT draft_apply_test_failure`) }
},30000)
it('按生效日期建立过渡月，范围自动包含已生成1月，生效前月周归属保留且原业务不变',async()=>{
 clock.mockReturnValue(Date.parse('2028-10-08T04:00:00Z'))
 await db.execute(sql`INSERT INTO org_nodes(id,name,type,parent_id) VALUES('c','过渡市场','市场','head')`)
 const original=await getDailyConfiguration()
 const crossMode={id:'transition-c',name:'过渡模式',isDefault:false,regionIds:['c'],effectiveFrom:'2028-10-07',pattern:defaultDailyCyclePattern,monthly:{}}
 const previous=[...original.cycleModes,crossMode]
 await db.execute(sql`UPDATE system_configs SET value=${JSON.stringify(previous)} WHERE key='daily_cycle_modes'`)
 for(const month of ['2028-10','2028-11','2028-12','2029-01']) {
  const p=buildDailyPeriod(month,defaultDailyCyclePattern,'transition-'+month)
  await db.execute(sql`INSERT INTO daily_operating_periods(id,name,month_key,region_id,start_date,end_date,weeks,template_source) VALUES(${p.id},${p.name},${month},'c',${p.start},${p.end},${JSON.stringify(p.weeks)}::jsonb,'global-template')`)
 }
 const c=await getDailyConfiguration()
 const modes=c.cycleModes.map(m=>m.id===crossMode.id?{...m,pattern}:m)
 const range={from:'2028-10',to:'2028-12',modeId:crossMode.id}
 const preview=await saveDailyCycleModes(modes,c.modesRevision,'',true,range)
 expect(preview.automatic.calendar?.issues).toEqual([])
 expect(preview.automatic.calendar?.rows.map(r=>r.month)).toEqual(['2028-10','2028-11','2028-12','2029-01'])
 expect(preview.automatic.calendar?.rows[0]).toMatchObject({action:'adjust',after:{start:'2028-09-26',end:'2028-10-31'}})
 expect((await getDailyConfiguration()).periods).toEqual(c.periods)
 await expect(saveDailyCycleModes(modes,c.modesRevision,'',false,range)).rejects.toThrow('确认应用')
 const reports=await db.execute(sql`SELECT * FROM daily_reports`)
 await saveDailyCycleModes(modes,c.modesRevision,preview.automatic.token,false,range)
 const after=await getDailyConfiguration()
 const actual=after.periods.filter(p=>p.regionId==='c').sort((a,b)=>a.start.localeCompare(b.start))
 expect(actual[0].start).toBe('2028-09-26');expect(actual[0].end).toBe('2028-10-31')
 expect(actual.at(-1)?.start).toBe('2029-01-01')
 actual.slice(1).forEach((p,i)=>expect(Date.parse(p.start)-Date.parse(actual[i].end)).toBe(86400000))
 expect(actual.map(p=>p.id).sort()).toEqual(c.periods.filter(p=>p.regionId==='c').map(p=>p.id).sort())
 expect(await db.execute(sql`SELECT * FROM daily_reports`)).toEqual(reports)
 const again=await saveDailyCycleModes(after.cycleModes,after.modesRevision,'',true,range)
 expect(again.automatic.calendar?.rows.every(r=>r.action==='keep')).toBe(true)
 clock.mockReturnValue(Date.parse('2028-02-08T04:00:00Z'))
},30000)
afterAll(async()=>{clock.mockRestore();await (globalThis as unknown as {pgClient?:{end:()=>Promise<void>}}).pgClient?.end()})

})
