import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DailyConfiguration from './configuration'

vi.mock('@/actions/daily-config', () => ({
  selectDailyPkMonth: vi.fn(), getDailyConfiguration: vi.fn(), previewDailyPeriod: vi.fn(), saveDailyPeriod: vi.fn(), saveDailyPk: vi.fn(),
  saveDailyCycleModes: vi.fn(), createDailyPeriodsForMonth: vi.fn(), saveDailyPeriodTemplate: vi.fn(), previewDailyMonths: vi.fn(), prepareDailyMonths: vi.fn(), restoreDailyGlobalRule: vi.fn(),
}))

const initial = { cycleModes: [], modesRevision: 'revision', periods: [], templates: [], overrides: [], periodStores: [], regions: [], classes: [], assignments: [], stores: [], members: [], logs: [] }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(actions.saveDailyCycleModes).mockResolvedValue({success:true,automatic:{calendar:{rows:[],issues:[]},created:0,keptMonths:[],boundaries:[],impact:[],token:'token'}})
  vi.mocked(actions.previewDailyMonths).mockResolvedValue({revision:'revision',rows:[]})
  // HTTP IP 地址上的 Crypto 只有 getRandomValues，没有 randomUUID。
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('HTTP 空配置显示原型模式、经营周与自然月预设', () => {
  render(<DailyConfiguration initial={initial} />)
  expect(screen.getByRole('button', { name: '自然月：1日～月末' })).toBeVisible()
  expect(screen.getByRole('button', { name: '＋ 添加一周' })).toBeVisible()
  expect(screen.getByRole('button', { name: '保存该模式' })).toBeVisible()
})

it('HTTP 环境下已有经营月可以添加多个 PK 班级', () => {
  const period = { id: 'p1', name: '十月', start: '2026-10-01', end: '2026-10-28', regionId: null, monthKey: null, templateId: null, templateSource: 'legacy', version: 1,
    weeks: [1, 2, 3, 4].map(n => ({ id: 'w' + n, name: '第' + n + '周', start: '', end: '' })) }
  render(<DailyConfiguration initial={{ ...initial, periods: [period], stores: [{ id: 's1', name: '测试门店', orgNodeId: null, area: '' }] }} />)
  fireEvent.click(screen.getByRole('tab', { name: 'PK 班级' }))
  fireEvent.click(screen.getByRole('button', { name: '添加班级' }))
  fireEvent.click(screen.getByRole('button', { name: '添加班级' }))
  expect(screen.getByLabelText('班级 1')).toBeVisible()
  expect(screen.getByLabelText('班级 2')).toBeVisible()
  expect(screen.getByLabelText('测试门店班级').querySelectorAll('option')).toHaveLength(3)
})

it('门店指导员候选覆盖所有在职员工，输入框可直接键入搜索姓名', () => {
  const period = { id: 'p1', name: '十月', start: '2026-10-01', end: '2026-10-28', regionId: null, monthKey: null, templateId: null, templateSource: 'legacy', version: 1,
    weeks: [1, 2, 3, 4].map(n => ({ id: 'w' + n, name: '第' + n + '周', start: '', end: '' })) }
  render(<DailyConfiguration initial={{ ...initial, periods: [period],
    classes: [{ id: 'c1', name: '一班', periodId: 'p1' }],
    assignments: [{ periodId: 'p1', storeId: 's1', classId: 'c1', legion: '', groupName: '', mentorName: '' }],
    stores: [{ id: 's1', name: '测试门店', orgNodeId: null, area: '测试区域' }],
    members: [
      { id: 'e1', name: '张三', storeId: 's1', position: '美容师' },
      { id: 'e2', name: '李四', storeId: 's2', position: '区域总监' },
    ],
  }} />)
  fireEvent.click(screen.getByRole('tab', { name: 'PK 班级' }))
  const input = screen.getByLabelText('测试门店mentorName')
  expect(input).toHaveAttribute('list', 'daily-mentors-s1')
  expect(document.querySelector('#daily-mentors-s1 option[value="李四"]')).toHaveAttribute('label', '区域总监 · 未分配门店')
  fireEvent.change(input, { target: { value: '李四' } })
  expect(input).toHaveValue('李四')
})


import * as actions from '@/actions/daily-config'
import { defaultDailyCyclePattern } from '@/lib/daily-period-template'

it('新增模式支持自然月、多市场分配与同次保存', async () => {
  const config = { ...initial, disabledTemplateIds: [], regions: [{ id: 'r1', name: '昭通' }, { id: 'r2', name: '九江' }] }
  vi.mocked(actions.getDailyConfiguration).mockResolvedValue(config)
  render(<DailyConfiguration initial={config} />)
  fireEvent.click(screen.getByRole('button', { name: '＋ 新增周期模式' }))
  expect(screen.getByLabelText('经营月开始日号')).toHaveValue(1)
  fireEvent.click(screen.getByLabelText('适用市场 昭通'))
  fireEvent.click(screen.getByLabelText('适用市场 九江'))
  fireEvent.click(screen.getByRole('button', { name: '保存该模式' }))
  await waitFor(() => expect(actions.saveDailyCycleModes).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button',{name:'确认应用'}))
  await waitFor(() => expect(actions.saveDailyCycleModes).toHaveBeenCalledTimes(2))
  expect(vi.mocked(actions.saveDailyCycleModes).mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({ regionIds: ['r1', 'r2'], isDefault: false })]))
})

it('未保存时仍可查看旧安排，预览读取草稿，编辑后确认失效', async () => {
  const period={id:'old',name:'202611',start:'2026-11-01',end:'2026-11-30',monthKey:'2026-11',regionId:'r1',templateId:null,templateSource:'global-template',version:1,weeks:[{id:'one',name:'整月',start:'2026-11-01',end:'2026-11-30'}]}
  render(<DailyConfiguration initial={{...initial,periods:[period],regions:[{id:'r1',name:'昭通'}]}} />)
  fireEvent.change(screen.getByLabelText('日期预览开始月份'),{target:{value:'2026-11'}})
  fireEvent.change(screen.getByLabelText('日期预览结束月份'),{target:{value:'2026-11'}})
  fireEvent.click(screen.getByRole('button',{name:'自然月：1日～月末'}))
  expect(screen.getAllByText('2026-11-01 至 2026-11-30').length).toBeGreaterThan(0)
  expect(screen.getByRole('button',{name:'确认应用'})).toBeDisabled()
  fireEvent.click(screen.getByRole('button',{name:'预览／校验'}))
  await waitFor(()=>expect(actions.saveDailyCycleModes).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({pattern:expect.objectContaining({start:{monthOffset:0,day:1}})})]),'revision','',true,{from:'2026-11',to:'2026-11',modeId:'headquarters'}))
  await waitFor(()=>expect(screen.getByRole('button',{name:'确认应用'})).toBeEnabled())
  fireEvent.change(screen.getByLabelText('模式名称'),{target:{value:'新名称'}})
  await waitFor(()=>expect(screen.getByRole('button',{name:'确认应用'})).toBeDisabled())
})

it('预览有断档时禁用应用并定位问题月份',async()=>{
  vi.mocked(actions.saveDailyCycleModes).mockResolvedValue({success:false,automatic:{calendar:{rows:[],issues:[{month:'2026-11',message:'2026-10-26至2026-10-31没有归属'}]},created:0,keptMonths:[],boundaries:[],impact:[],token:'token'}})
  render(<DailyConfiguration initial={{...initial,regions:[{id:'r1',name:'昭通'}]}} />)
  fireEvent.click(screen.getByRole('button',{name:'预览／校验'}))
  await waitFor(()=>expect(screen.getByText('2026-10-26至2026-10-31没有归属')).toBeVisible())
  expect(screen.getByRole('button',{name:'确认应用'})).toBeDisabled()
  fireEvent.click(screen.getByRole('button',{name:'调整2026-11'}))
  expect(screen.getByLabelText('新增配置归属月')).toHaveValue('2026-11')
  expect(screen.getByLabelText('2026-11月开始日号')).toBeVisible()
})

it('普通及特殊月份均可增减周数，预览显示短月日期', () => {
  render(<DailyConfiguration initial={{...initial,regions:[{id:'r1',name:'昭通'}]}} />)
  fireEvent.click(screen.getByRole('button', { name: '自然月：1日～月末' }))
  fireEvent.click(screen.getByRole('button', { name: '＋ 添加一周' }))
  expect(screen.getByLabelText('第5周名称')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '删除第5周' }))
  fireEvent.click(screen.getByText(/④ 特殊月份/))
  fireEvent.change(screen.getByLabelText('新增配置归属月'), { target: { value: '2028-02' } })
  fireEvent.click(screen.getByRole('button', { name: '设置这个月' }))
  expect(screen.getByLabelText('2028-02 第4周结束日号')).toHaveValue(31)
})

it('PK未来月份自动安排，失败时没有可保存的半成品', async()=>{
  vi.mocked(actions.selectDailyPkMonth).mockRejectedValue(Error('INVALID_STATE: 昭通 2027-02 日期不连续'))
  render(<DailyConfiguration initial={initial} />)
  fireEvent.click(screen.getByRole('tab',{name:'PK 班级'}))
  const select=screen.getByRole('combobox',{name:'PK所属月份'})
  const next=select.querySelectorAll('option')[1].value
  fireEvent.change(select,{target:{value:next}})
  await waitFor(()=>expect(actions.selectDailyPkMonth).toHaveBeenCalledWith(next))
  await waitFor(()=>expect(screen.getByText(/昭通 2027-02 日期不连续/)).toBeVisible())
  expect(screen.queryByRole('button',{name:'保存 PK 配置'})).not.toBeInTheDocument()
  expect(screen.getByText('全部市场')).toBeVisible()
})

it('日期预览读取失败就近提示，不持续显示加载',async()=>{
  vi.mocked(actions.saveDailyCycleModes).mockRejectedValue(Error('INVALID_STATE: 日期规则损坏'))
  render(<DailyConfiguration initial={initial} />)
  fireEvent.click(screen.getByRole('button',{name:'预览／校验'}))
  await waitFor(()=>expect(screen.getAllByText('日期规则损坏').length).toBeGreaterThan(0))
  expect(screen.queryByText('读取日期预览中…')).not.toBeInTheDocument()
})

it('已有月份设置带出实际日期，重复打开不新增例外',()=>{
 const period={id:'old',name:'202611',start:'2026-10-26',end:'2026-11-25',monthKey:'2026-11',regionId:null,templateId:null,templateSource:'legacy',version:1,weeks:[{id:'whole',name:'整月',start:'2026-10-26',end:'2026-11-25'}]}
 render(<DailyConfiguration initial={{...initial,periods:[period],regions:[{id:'r1',name:'昭通'}]}} />)
 fireEvent.click(screen.getByText(/④ 特殊月份/));fireEvent.change(screen.getByLabelText('新增配置归属月'),{target:{value:'2026-11'}})
 const button=screen.getByRole('button',{name:'设置这个月'});expect(button).toBeEnabled();fireEvent.click(button)
 expect(screen.getByLabelText('2026-11月开始日号')).toHaveValue(26);expect(screen.getByLabelText('2026-11月开始月份')).toHaveValue('-1')
 fireEvent.click(button);expect(screen.getAllByRole('button',{name:'恢复普通规则'})).toHaveLength(1)
})

it('相同日期冲突合并展示，适用市场展开查看',async()=>{
 const message='2026-12与2027-01日期重叠，请调整相关月份'
 vi.mocked(actions.saveDailyCycleModes).mockResolvedValue({success:false,automatic:{calendar:{rows:[],issues:[{month:'2026-12',message:'昭通 '+message},{month:'2026-12',message:'南昌 '+message}]},created:0,keptMonths:[],boundaries:[],impact:[],token:'token'}})
 render(<DailyConfiguration initial={{...initial,regions:[{id:'r1',name:'昭通'},{id:'r2',name:'南昌'}]}} />)
 fireEvent.click(screen.getByRole('button',{name:'预览／校验'}))
 await waitFor(()=>expect(screen.getAllByRole('alert')).toHaveLength(1))
 expect(screen.getByText('涉及2个市场')).toBeVisible()
 expect(screen.getByRole('button',{name:'确认应用'})).toBeDisabled()
})
