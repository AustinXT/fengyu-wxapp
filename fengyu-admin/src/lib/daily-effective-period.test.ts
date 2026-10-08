import {describe,expect,it} from 'vitest'
import {buildDailyPeriod,defaultDailyCyclePattern} from './daily-period-template'
import {effectivePeriod} from './daily-effective-period'
const natural = {start:{monthOffset:0 as const,day:1},end:{monthOffset:0 as const,day:31},weeks:[[1,7],[8,14],[15,21],[22,31]].map(([a,b],i)=>({id:`w${i+1}`,name:`第${i+1}周`,start:{monthOffset:0 as const,day:a},end:{monthOffset:0 as const,day:b}}))}
describe('生效日期交界',()=>{
 it('跨月改自然月，保留生效之前的月和周归属',()=>{
  const old=buildDailyPeriod('2026-10',defaultDailyCyclePattern,'old')
  const next=effectivePeriod(old,buildDailyPeriod('2026-10',natural,'preview'),'2026-10-07')
  expect(next.start).toBe('2026-09-26');expect(next.end).toBe('2026-10-31')
  for(let date=old.start;date<'2026-10-07';date=new Date(Date.parse(date)+86400000).toISOString().slice(0,10)) {
   expect(next.weeks.find(w=>w.start<=date&&w.end>=date)?.id).toBe(old.weeks.find(w=>w.start<=date&&w.end>=date)?.id)
  }
  expect(next.weeks.at(-1)?.end).toBe(next.end)
 })
 it('生效前整月保持原值，生效后整月按新规则',()=>{
  const old=buildDailyPeriod('2026-09',defaultDailyCyclePattern,'old')
  expect(effectivePeriod(old,buildDailyPeriod('2026-09',natural,'preview'),'2026-10-07')).toBe(old)
  const next=buildDailyPeriod('2026-11',natural,'preview')
  expect(effectivePeriod(buildDailyPeriod('2026-11',defaultDailyCyclePattern,'old'),next,'2026-10-07')).toEqual(next)
 })
 it('没有旧安排时从生效日开始，不补造生效前的日期',()=>{
  const next=effectivePeriod(null,buildDailyPeriod('2026-10',natural,'preview'),'2026-10-07')
  expect(next.start).toBe('2026-10-07');expect(next.weeks[0].start).toBe(next.start)
 })
 it('短月、闰年、跨年过渡连续覆盖',()=>{
  for(const month of ['2028-02','2027-02','2026-12','2027-01']) {
   const old=buildDailyPeriod(month,defaultDailyCyclePattern,'old')
   const next=effectivePeriod(old,buildDailyPeriod(month,natural,'preview'),`${month}-07`)
   expect(next.start).toBe(old.start)
   expect(next.end).toBe(buildDailyPeriod(month,natural,'preview').end)
   next.weeks.slice(1).forEach((w,i)=>expect(Date.parse(w.start)-Date.parse(next.weeks[i].end)).toBe(86400000))
  }
 })
 it('过渡月份不能悄悄改周数或结束在生效日前',()=>{
  const old=buildDailyPeriod('2026-10',defaultDailyCyclePattern,'old')
  const next=buildDailyPeriod('2026-10',natural,'preview')
  expect(()=>effectivePeriod(old,{...next,weeks:[{id:'w',name:'整月',start:next.start,end:next.end}]},'2026-10-07')).toThrow('保留原周数')
  expect(()=>effectivePeriod(old,{...next,end:'2026-10-06'},'2026-10-07')).toThrow('结束日期')
 })
})
