'use client'
import { useMemo, useState } from 'react'
import { getDailyConfiguration, saveDailyPk, selectDailyPkMonth } from '@/actions/daily-config'
import { periodMonth, monthRange } from '@/lib/daily-cycle-planner'
import DailyCycleSettings from './cycle-settings'
import { actionErrorMessage } from '@/lib/action-error'

type Configuration = Omit<Awaited<ReturnType<typeof getDailyConfiguration>>, 'disabledTemplateIds'> & { disabledTemplateIds?: string[] }
// getRandomValues 在 HTTP 测试地址也可用；randomUUID 仅在安全上下文可用。
const monthPeriod = (data: Configuration, id: string) => {
  const chosen = data.periods.find(p => p.id === id)
  if (!chosen) return ''
  const group = data.periods.filter(p => periodMonth(p) === periodMonth(chosen))
  return group.find(p => !p.regionId)?.id || group.slice().sort((a, b) => a.id.localeCompare(b.id))[0]?.id || ''
}
const configurationId = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), (n) => n.toString(16).padStart(2, '0')).join('')
const field = 'rounded-lg border border-gray-300 px-3 py-2 bg-white w-full focus:border-[#C0322A] focus:outline-none focus:ring-2 focus:ring-[#C0322A]/15'
const button = 'inline-flex items-center justify-center rounded-lg bg-[#C0322A] text-white px-4 py-2 text-sm font-medium hover:bg-[#a92922] disabled:opacity-50'
const subtleButton = 'inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50'
const auditText = (detail: unknown, key: 'before' | 'after', stores: { id: string; name: string }[]) => {
  const value = (detail as Record<string, unknown> | null)?.[key]
  if (Array.isArray(value)) return value.map(m => `${m.name || '周期模式'}：${m.isDefault ? '总部默认' : `${m.regionIds?.length || 0}个市场`}`).join('；') || '无周期模式'
  if (!value || typeof value !== 'object') return '尚未配置'
  const data = value as Record<string, unknown>
  if (Array.isArray(data.classes)) {
    const classes = data.classes as { id: string; name: string }[], assigned = Array.isArray(data.stores) ? data.stores as { storeId: string; classId: string; legion: string; groupName: string; mentorName: string }[] : []
    return `班级：${classes.map((c) => c.name).join('、') || '无'}；${assigned.map((a) => `${stores.find((s) => s.id === a.storeId)?.name || '已移除门店'}：${classes.find((c) => c.id === a.classId)?.name || '无班级'} / ${a.legion || '未设置军团'} / ${a.groupName || '未设置小组'} / ${a.mentorName || '未设置指导员'}`).join('；') || '无参与门店'}`
  }
  if (data.name === '沿用总部规则') return '沿用总部规则（已有月份保留原安排）'
  const pattern = (data.pattern || (typeof data.start === 'object' ? data : null)) as { start: { monthOffset: number; day: number }; end: { monthOffset: number; day: number } } | null
  if (pattern) {
    const point = (p: { monthOffset: number; day: number }) => `${p.monthOffset === -1 ? '上月' : p.monthOffset === 1 ? '下月' : '当月'}${p.day}日`
    return `${data.name || '日期规则'}：${point(pattern.start)} 至 ${point(pattern.end)}`
  }
  const weeks = Array.isArray(data.weeks) ? data.weeks as { name: string; start: string; end: string }[] : []
  return `${data.name || '经营周期'} · ${data.start || ''} 至 ${data.end || ''}；${weeks.map((w) => `${w.name} ${w.start} 至 ${w.end}`).join('；')}`
}
export default function DailyConfiguration({ initial: initialConfiguration }: { initial: Configuration }) {
  const [initial, setInitial] = useState(initialConfiguration)
  const [tab, setTab] = useState('period'), [selected, setSelected] = useState(monthPeriod(initial, (initial.periods.find(p => p.start <= new Date(Date.now()+8*3600000).toISOString().slice(0,10) && p.end >= new Date(Date.now()+8*3600000).toISOString().slice(0,10)) || initial.periods[0])?.id || ''))
  const currentMonth = periodMonth(initial.periods.find(p => p.start <= new Date(Date.now()+8*3600000).toISOString().slice(0,10) && p.end >= new Date(Date.now()+8*3600000).toISOString().slice(0,10)) || { name: '', end: new Date(Date.now()+8*3600000).toISOString().slice(0,10) })
  const [requestedMonth, setRequestedMonth] = useState(periodMonth(initial.periods.find(p => p.id === selected) || {name:''}))
  const [classes, setClasses] = useState(initial.classes.filter((c) => initial.periods.some(p => p.id === c.periodId && periodMonth(p) === periodMonth(initial.periods.find(p => p.id === selected) || { name: '' }))))
  const [assignments, setAssignments] = useState(initial.assignments.filter((s) => initial.periods.some(p => p.id === s.periodId && periodMonth(p) === periodMonth(initial.periods.find(p => p.id === selected) || { name: '' }))))
  const [selectedClass, setSelectedClass] = useState(classes[0]?.id || '')
  const [storeSearch, setStoreSearch] = useState(''), [areaFilter, setAreaFilter] = useState(''), [storeFilter, setStoreFilter] = useState('all')
  const [unsaved, setUnsaved] = useState(false)
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const change = (id: string, configuration = initial) => {
    id = monthPeriod(configuration, id)
    const p = configuration.periods.find((p) => p.id === id)
    setSelected(p?.id || ''); setRequestedMonth(p ? periodMonth(p) : ''); setMessage('')
    const monthIds = configuration.periods.filter(row => p && periodMonth(row) === periodMonth(p)).map(row => row.id)
    const nextClasses = configuration.classes.filter((c) => monthIds.includes(c.periodId))
    setClasses(nextClasses); setAssignments(configuration.assignments.filter((s) => monthIds.includes(s.periodId)))
    setSelectedClass(nextClasses[0]?.id || ''); setStoreSearch(''); setAreaFilter(''); setStoreFilter('all')
  }
  const pkMonth = async (key: string) => {
    if (!key) return;
    setRequestedMonth(key); setBusy(true); setMessage(''); setSelected(''); setClasses([]); setAssignments([]);
    try { const next = await selectDailyPkMonth(key); setInitial(next); change(next.periods.find(p => periodMonth(p) === key)?.id || '', next); }
    catch (e) { setMessage(actionErrorMessage(e, '该月安排失败，请检查日期规则')); }
    finally { setBusy(false); }
  }
  const removeClass = (id: string) => {
    if (assignments.some((s) => s.classId === id) && !window.confirm('移除班级会同时取消本月该班级的门店分配。确认移除？')) return
    const next = classes.filter((c) => c.id !== id)
    setClasses(next); setAssignments(assignments.filter((s) => s.classId !== id))
    if (selectedClass === id) setSelectedClass(next[0]?.id || '')
  }
  const pk = async () => {
    const p = initial.periods.find((p) => p.id === selected)
    if (!p) return
    setBusy(true); setMessage('')
    try { await saveDailyPk({ periodId: selected, expectedVersion: p.version, classes, stores: assignments }); const configuration = await getDailyConfiguration(); setInitial(configuration); change(selected, configuration); setMessage('PK 班级及门店已保存') }
    catch (e) { setMessage(actionErrorMessage(e, '保存失败，请重试')) } finally { setBusy(false) }
  }

  const areas = useMemo(() => [...new Set(initial.stores.map((s) => s.area).filter((area): area is string => Boolean(area)))].sort(), [initial.stores])
  const classStats = (id: string) => {
    const storeIds = assignments.filter((a) => a.classId === id).map((a) => a.storeId)
    return { stores: storeIds.length, members: initial.members.filter((m) => m.storeId !== null && storeIds.includes(m.storeId)).length }
  }
  const visibleStores = initial.stores.filter((store) => {
    const assignment = assignments.find((a) => a.storeId === store.id)
    const matchesClass = storeFilter === 'all' || (storeFilter === 'unassigned' ? !assignment : assignment?.classId === selectedClass)
    return  matchesClass && (!areaFilter || store.area === areaFilter) && (!storeSearch || store.name.toLowerCase().includes(storeSearch.toLowerCase()))
  })

  return <div className="space-y-4">
    <h1 className="text-2xl font-bold text-[var(--foreground)]">日报经营配置</h1>

    <div className="flex gap-2 border-b" role="tablist" aria-label="日报配置类型">
      {[['period', '经营周期'], ['pk', 'PK 班级']].map(([key, label]) => <button key={key} type="button" role="tab" disabled={busy} aria-selected={tab === key} className={`px-5 py-3 text-sm font-medium ${tab === key ? 'border-b-2 border-[#C0322A] text-[#C0322A]' : 'text-gray-500'}`} onClick={() => { if (key !== tab && unsaved && !window.confirm('放弃尚未保存的经营周期修改？')) return; setTab(key); setMessage('') }}>{label}</button>)}
    </div>
    {message && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">{message}</div>}
    {tab === 'period' ? <DailyCycleSettings configuration={initial} onBusyChange={setBusy} onDirtyChange={setUnsaved} onConfigurationChange={configuration => { setInitial(configuration); change(selected || configuration.periods[0]?.id || '', configuration) }} /> : <fieldset disabled={busy} className="space-y-5">
      <section className="rounded-xl border bg-white p-4"><div className="flex flex-wrap gap-3"><label className="text-sm font-medium">PK所属月份<select className={`${field} mt-2`} value={requestedMonth} onChange={e => { void pkMonth(e.target.value) }}><option value="">选择PK所属月份</option>{[...new Set([...initial.periods.map(p => periodMonth(p)), ...monthRange(currentMonth,13)])].sort().reverse().map(key => <option key={key}>{key}</option>)}</select></label><div className="text-sm font-medium">配置范围<div className={`${field} mt-2 bg-gray-50`}>全部市场</div></div></div><p className="mt-2 text-sm text-gray-500">总部按经营月份统一配置全部市场的班级与门店，支持跨市场同班。下方区域筛选仅用于查找门店。</p></section>
      <section className="space-y-5">
        {!selected ? <div className="rounded-xl border bg-white p-8 text-center"><p className="font-medium">{busy ? '正在自动安排该月日期…' : message ? '该月日期安排未完成' : '请先选择PK所属月份'}</p><p className="mt-1 text-sm text-gray-500">所选月份的日期安排成功后，才能配置班级与门店。</p><button type="button" className={`${button} mt-4`} onClick={() => { setTab('period'); change('') }}>查看经营周期</button></div> : <>
          <section className="rounded-xl border bg-white p-4 md:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">班级分组</h2><p className="mt-1 text-sm text-gray-500">选择班级查看和分配门店；同一家门店同月只能加入一个班级。</p></div><button type="button" className={subtleButton} onClick={() => { const id = configurationId(); setClasses([...classes, { id, name: '', periodId: selected }]); setSelectedClass(id) }}>添加班级</button></div>
            {classes.length ? <div className="mt-4 divide-y rounded-lg border">{classes.map((c, i) => { const stats = classStats(c.id); const active = selectedClass === c.id; return <div key={c.id} className={`grid gap-2 p-3 md:grid-cols-[100px_minmax(220px,1fr)_220px_64px] md:items-center ${active ? 'bg-[#C0322A]/5' : 'bg-white'}`}>
              <button type="button" role="tab" aria-label={`班级 ${i + 1}`} aria-selected={active} onClick={() => setSelectedClass(c.id)} className={`rounded-md px-2 py-2 text-left text-sm font-medium ${active ? 'text-[#C0322A]' : 'text-gray-600 hover:bg-gray-50'}`}>班级 {i + 1}</button>
              <input aria-label={`班级${i + 1}名称`} className={`${field} py-1.5 text-sm`} value={c.name} maxLength={30} placeholder="填写班级名称" onFocus={() => setSelectedClass(c.id)} onChange={(e) => setClasses(classes.map((v) => v.id === c.id ? { ...v, name: e.target.value } : v))}/>
              <span className="px-2 text-xs text-gray-500">{stats.stores} 家门店 · {stats.members} 位参与人员</span>
              <button type="button" aria-label="移除班级" className="px-2 py-1.5 text-left text-sm text-[#C0322A]" onClick={() => removeClass(c.id)}>移除</button>
            </div>})}</div> : <p className="mt-4 rounded-lg bg-gray-50 p-4 text-sm text-gray-500">还没有班级，添加班级后即可开始分配门店。</p>}
          </section>

          <section className="overflow-hidden rounded-xl border bg-white">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b p-4 md:px-5"><div><h2 className="font-semibold">门店分配</h2><p className="mt-1 text-sm text-gray-500">正在配置：{classes.find((c) => c.id === selectedClass)?.name || '请选择班级'}。员工与店长按员工档案的所属门店参与。</p></div><div className="text-sm text-gray-500">当前 {visibleStores.length} 家门店</div></div>
            <div className="grid gap-3 border-b bg-gray-50/70 p-4 md:grid-cols-[minmax(220px,1fr)_220px] md:px-5">
              <label className="text-sm">搜索门店<input type="search" className={`${field} mt-1`} placeholder="输入门店名称" value={storeSearch} onChange={(e) => setStoreSearch(e.target.value)}/></label>
              <label className="text-sm">区域<select className={`${field} mt-1`} value={areaFilter} onChange={(e) => setAreaFilter(e.target.value)}><option value="">全部区域</option>{areas.map((area) => <option key={area} value={area}>{area}</option>)}</select></label>
              <div className="flex flex-wrap gap-2 md:col-span-2" role="group" aria-label="门店范围">{([['all', '全部门店'], ['current', '当前班级'], ['unassigned', '未分配']] as const).map(([key, label]) => <button type="button" key={key} onClick={() => setStoreFilter(key)} className={`rounded-full border px-3 py-1.5 text-xs ${storeFilter === key ? 'border-[#C0322A] bg-white text-[#C0322A]' : 'border-gray-300 bg-white text-gray-600'}`}>{label}</button>)}</div>
            </div>
            <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-sm"><thead className="bg-gray-50 text-xs text-gray-500"><tr>{['门店', '区域', '班级', '军团', '指导员'].map((s) => <th className="px-4 py-3 text-left font-medium" key={s}>{s}</th>)}</tr></thead><tbody>{visibleStores.map((store) => {
              const assignment = assignments.find((s) => s.storeId === store.id)
              const mentorListId = `daily-mentors-${store.id}`
              return <tr key={store.id} className="border-t"><td className="px-4 py-3 font-medium">{store.name}</td><td className="px-4 py-3 text-gray-500">{store.area || '未分配区域'}</td><td className="w-56 px-4 py-2"><select aria-label={store.name + '班级'} className={field} value={assignment?.classId || ''} onChange={(e) => {
                const rest = assignments.filter((s) => s.storeId !== store.id)
                setAssignments(e.target.value ? [...rest, { periodId: selected, storeId: store.id, classId: e.target.value, legion: assignment?.legion || '', groupName: assignment?.groupName || '', mentorName: assignment?.mentorName || '' }] : rest)
              }}><option value="">不参加</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name || '未命名班级'}</option>)}</select></td><td className="w-52 px-4 py-2"><select aria-label={store.name + 'legion'} disabled={!assignment} className={field} value={assignment?.legion || ''} onChange={(e) => setAssignments(assignments.map((s) => s.storeId === store.id ? { ...s, legion: e.target.value } : s))}><option value="">选择军团</option><option value="红军">红军</option><option value="蓝军">蓝军</option></select></td><td className="w-52 px-4 py-2"><input aria-label={store.name + 'mentorName'} list={mentorListId} disabled={!assignment} placeholder="选择或搜索全体员工" className={field} value={assignment?.mentorName || ''} onChange={(e) => setAssignments(assignments.map((s) => s.storeId === store.id ? { ...s, mentorName: e.target.value } : s))}/><datalist id={mentorListId}>{initial.members.map((member) => {
                const memberStore = initial.stores.find((item) => item.id === member.storeId)?.name
                const label = [member.position || '未设置岗位', memberStore || '未分配门店'].join(' · ')
                return <option key={member.id} value={member.name || ''} label={label}/>
              })}</datalist></td></tr>
            })}{!visibleStores.length && <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-500">没有符合条件的门店</td></tr>}</tbody></table></div>
            <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t bg-white/95 px-4 py-3 backdrop-blur md:px-5"><span className="text-xs text-gray-500">门店调整只会在保存后生效</span><button className={button} onClick={() => void pk()}>保存 PK 配置</button></div>
          </section>

          <section className="rounded-xl border bg-white p-4 md:p-5"><h2 className="font-semibold">人员预览</h2><p className="mt-1 text-sm text-gray-500">根据门店所属班级展示参与人员；展开班级查看名单。</p><div className="mt-3 space-y-2">{classes.map((c) => {
            const rows = initial.members.filter((m) => assignments.some((a) => a.classId === c.id && a.storeId === m.storeId))
            return <details key={c.id} className="rounded-lg border"><summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-4 py-3"><span className="font-medium">{c.name || '未命名班级'}</span><span className="text-sm text-gray-500">{classStats(c.id).stores} 家门店 · {rows.length} 位参与人员</span></summary><div className="overflow-x-auto border-t"><table className="w-full min-w-[650px] text-sm"><thead className="bg-gray-50 text-xs text-gray-500"><tr>{['区域', '军团', '指导员', '姓名', '岗位', '门店'].map((label) => <th key={label} className="px-3 py-2 text-left font-medium">{label}</th>)}</tr></thead><tbody>{rows.map((member) => {
              const store = initial.stores.find((s) => s.id === member.storeId), a = assignments.find((a) => a.storeId === member.storeId)
              return <tr key={member.id} className="border-t">{[store?.area, a?.legion, a?.mentorName, member.name, member.position, store?.name].map((value, i) => <td key={i} className="px-3 py-2">{value || '—'}</td>)}</tr>
            })}{!rows.length && <tr><td colSpan={6} className="p-3 text-gray-500">暂无参与人员</td></tr>}</tbody></table></div></details>
          })}</div></section>
        </>}
      </section>
    </fieldset>}

    <details className="rounded-xl border bg-white"><summary className="cursor-pointer px-4 py-4 font-semibold">配置修改记录 <span className="ml-2 text-sm font-normal text-gray-500">最近 {initial.logs.length} 条</span></summary><div className="border-t px-4 py-3"><p className="mb-3 text-sm text-gray-500">记录操作人、时间和变更前后的配置。</p>{initial.logs.map((log) => <details key={log.id} className="mb-2 rounded-lg border p-3"><summary className="cursor-pointer text-sm">{({ 'daily.period.save': '调整本月日期', 'daily.pk.save': '修改 PK 班级', 'daily.period_template.save': '保存长期日期规则', 'daily.period_template.inherit': '恢复沿用总部', 'daily.period_override.save': '保存本月特殊安排', 'daily.period.generate': '准备月份安排', 'daily.cycle_modes.save': '保存周期模式' } as Record<string, string>)[log.action] || log.action} · {log.operator || '系统'} · {new Date(log.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</summary><div className="mt-3 space-y-2 text-sm text-gray-600"><p>变更前：{auditText(log.detail, 'before', initial.stores)}</p><p>变更后：{auditText(log.detail, 'after', initial.stores)}</p></div></details>)}{!initial.logs.length && <p className="text-sm text-gray-500">暂无修改记录</p>}</div></details>
  </div>
}
