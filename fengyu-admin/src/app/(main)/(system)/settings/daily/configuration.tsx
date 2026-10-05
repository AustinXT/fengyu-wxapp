'use client'
import { useMemo, useState } from 'react'
import { getDailyConfiguration, previewDailyPeriod, saveDailyPeriod, saveDailyPk } from '@/actions/daily-config'
import { type DailyPeriodInput } from '@/lib/daily-config'
import { actionErrorMessage } from '@/lib/action-error'

type Configuration = Awaited<ReturnType<typeof getDailyConfiguration>>
// getRandomValues 在 HTTP 测试地址也可用；randomUUID 仅在安全上下文可用。
const configurationId = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), (n) => n.toString(16).padStart(2, '0')).join('')
const blank = (): DailyPeriodInput => ({ id: configurationId(), name: '', start: '', end: '', version: 0,
  weeks: [1, 2, 3, 4].map((n) => ({ id: 'w' + n, name: '第' + n + '周', start: '', end: '' })) })
const field = 'rounded-lg border border-gray-300 px-3 py-2 bg-white w-full focus:border-[#C0322A] focus:outline-none focus:ring-2 focus:ring-[#C0322A]/15'
const button = 'inline-flex items-center justify-center rounded-lg bg-[#C0322A] text-white px-4 py-2 text-sm font-medium hover:bg-[#a92922] disabled:opacity-50'
const subtleButton = 'inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50'
const auditText = (detail: unknown, key: 'before' | 'after', stores: { id: string; name: string }[]) => {
  const value = (detail as Record<string, unknown> | null)?.[key]
  if (!value || typeof value !== 'object') return '尚未配置'
  const data = value as Record<string, unknown>
  if (Array.isArray(data.classes)) {
    const classes = data.classes as { id: string; name: string }[], assigned = Array.isArray(data.stores) ? data.stores as { storeId: string; classId: string; legion: string; groupName: string; mentorName: string }[] : []
    return `班级：${classes.map((c) => c.name).join('、') || '无'}；${assigned.map((a) => `${stores.find((s) => s.id === a.storeId)?.name || '已移除门店'}：${classes.find((c) => c.id === a.classId)?.name || '无班级'} / ${a.legion || '未设置军团'} / ${a.groupName || '未设置小组'} / ${a.mentorName || '未设置指导员'}`).join('；') || '无参与门店'}`
  }
  const weeks = Array.isArray(data.weeks) ? data.weeks as { name: string; start: string; end: string }[] : []
  return `${data.name || '经营周期'} · ${data.start || ''} 至 ${data.end || ''}；${weeks.map((w) => `${w.name} ${w.start} 至 ${w.end}`).join('；')}`
}
const dayCount = (start: string, end: string) => {
  if (!start || !end) return '—'
  const days = Math.round((Date.parse(end + 'T12:00:00Z') - Date.parse(start + 'T12:00:00Z')) / 86400000) + 1
  return days > 0 ? `${days} 天` : '日期有误'
}
const dateLabel = (start: string, end: string) => start && end ? `${start} 至 ${end}` : '日期待配置'

export default function DailyConfiguration({ initial: initialConfiguration }: { initial: Configuration }) {
  const [initial, setInitial] = useState(initialConfiguration)
  const [tab, setTab] = useState('period'), [selected, setSelected] = useState(initial.periods[0]?.id || '')
  const [period, setPeriod] = useState<DailyPeriodInput>(() => initial.periods[0] || blank())
  const [classes, setClasses] = useState(initial.classes.filter((c) => c.periodId === selected))
  const [assignments, setAssignments] = useState(initial.assignments.filter((s) => s.periodId === selected))
  const [selectedClass, setSelectedClass] = useState('')
  const [storeSearch, setStoreSearch] = useState(''), [areaFilter, setAreaFilter] = useState(''), [storeFilter, setStoreFilter] = useState('all')
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [impact, setImpact] = useState<Awaited<ReturnType<typeof previewDailyPeriod>> | null>(null)
  const change = (id: string, configuration = initial) => {
    const p = configuration.periods.find((p) => p.id === id)
    setSelected(id); setPeriod(p || blank()); setImpact(null); setMessage('')
    const nextClasses = configuration.classes.filter((c) => c.periodId === id)
    setClasses(nextClasses); setAssignments(configuration.assignments.filter((s) => s.periodId === id))
    setSelectedClass(nextClasses[0]?.id || ''); setStoreSearch(''); setAreaFilter(''); setStoreFilter('all')
  }
  const edit = (data: Partial<DailyPeriodInput>) => { setPeriod({ ...period, ...data }); setImpact(null) }
  const preview = async () => {
    setBusy(true); setMessage('')
    try { setImpact(await previewDailyPeriod(period)) } catch (e) { setMessage(actionErrorMessage(e, '预览失败，请重试')) } finally { setBusy(false) }
  }
  const save = async () => {
    setBusy(true); setMessage('')
    try { await saveDailyPeriod(period); const configuration = await getDailyConfiguration(); setInitial(configuration); change(period.id, configuration); setMessage('经营周期已保存') }
    catch (e) { setMessage(actionErrorMessage(e, '保存失败，请重试')) } finally { setBusy(false) }
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
    return matchesClass && (!areaFilter || store.area === areaFilter) && (!storeSearch || store.name.toLowerCase().includes(storeSearch.toLowerCase()))
  })

  return <div className="space-y-4">
    <h1 className="text-2xl font-bold text-[var(--foreground)]">日报经营配置</h1>

    <section className="rounded-xl border bg-white p-4 md:p-5">
      <div className="grid gap-4 md:grid-cols-[minmax(240px,360px)_1fr] md:items-end">
        <label className="block text-sm font-medium">当前经营月份
          <select className={`${field} mt-1`} value={selected} onChange={(e) => change(e.target.value)}>
            <option value="">新增经营月</option>{initial.periods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <div className="rounded-lg bg-gray-50 px-4 py-3 text-sm">
          <span className="text-gray-500">经营日期</span><p className="mt-1 font-medium">{dateLabel(period.start, period.end)}</p>
        </div>
      </div>
      <div className="mt-5 flex gap-2 border-b" role="tablist" aria-label="日报配置类型">
        {([['period', '经营周期'], ['pk', 'PK 班级']] as const).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => { setTab(key); setMessage('') }} className={`-mb-px border-b-2 px-4 py-3 text-sm font-medium ${tab === key ? 'border-[#C0322A] text-[#C0322A]' : 'border-transparent text-gray-500 hover:text-gray-900'}`}>{label}</button>)}
      </div>
    </section>

    {message && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">{message}</div>}

    <fieldset disabled={busy} className="min-w-0 space-y-5 disabled:opacity-75">
      {tab === 'period' ? <section className="overflow-hidden rounded-xl border bg-white">
        <div className="border-b px-4 py-4 md:px-5"><h2 className="font-semibold">{period.version ? '经营周期' : '新建经营周期'}</h2><p className="mt-1 text-sm text-gray-500">四个经营周连续覆盖整月，可按实际经营安排设置不同天数。</p></div>
        <div className="grid gap-4 p-4 md:grid-cols-3 md:px-5">
          <label className="text-sm font-medium">月份名称<input className={`${field} mt-1`} value={period.name} onChange={(e) => edit({ name: e.target.value })} maxLength={60}/></label>
          <label className="text-sm font-medium">经营月开始<input aria-label="经营月开始日期" type="date" className={`${field} mt-1`} value={period.start} onChange={(e) => edit({ start: e.target.value })}/></label>
          <label className="text-sm font-medium">经营月结束<input aria-label="经营月结束日期" type="date" className={`${field} mt-1`} value={period.end} onChange={(e) => edit({ end: e.target.value })}/></label>
        </div>
        <div className="px-4 pb-2 md:px-5"><h3 className="font-medium">周次安排</h3><p className="mt-1 text-sm text-gray-500">检查每周起止日期连续衔接，并覆盖上方经营月。</p></div>
        <div className="space-y-3 px-4 pb-5 md:px-5">
          <div className="hidden grid-cols-[minmax(130px,1fr)_minmax(160px,1fr)_minmax(160px,1fr)_100px] gap-3 text-xs font-medium text-gray-500 md:grid"><span>周次名称</span><span>开始日期</span><span>结束日期</span><span>时长</span></div>
          {period.weeks.map((w, i) => <div key={w.id} className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50/60 p-3 md:grid-cols-[minmax(130px,1fr)_minmax(160px,1fr)_minmax(160px,1fr)_100px] md:items-center md:border-0 md:bg-transparent md:p-0">
            <label className="text-xs text-gray-500 md:text-sm md:text-gray-900">第 {i + 1} 周名称<input aria-label={`第${i + 1}周名称`} className={`${field} mt-1`} value={w.name} onChange={(e) => edit({ weeks: period.weeks.map((v, n) => n === i ? { ...v, name: e.target.value } : v) })}/></label>
            <label className="text-xs text-gray-500 md:text-sm md:text-gray-900">开始日期<input aria-label={`${w.name}开始日期`} type="date" className={`${field} mt-1`} value={w.start} onChange={(e) => edit({ weeks: period.weeks.map((v, n) => n === i ? { ...v, start: e.target.value } : v) })}/></label>
            <label className="text-xs text-gray-500 md:text-sm md:text-gray-900">结束日期<input aria-label={`${w.name}结束日期`} type="date" className={`${field} mt-1`} value={w.end} onChange={(e) => edit({ weeks: period.weeks.map((v, n) => n === i ? { ...v, end: e.target.value } : v) })}/></label>
            <div className="text-sm text-gray-600"><span className="md:hidden">本周时长：</span>{dayCount(w.start, w.end)}</div>
          </div>)}
        </div>
        {impact && <div className="mx-4 mb-4 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm md:mx-5"><p className="font-medium">保存影响预览</p><p>日期范围内涉及 {impact.reports} 份日报、{impact.targets} 项目标、{impact.classes} 个 PK 班级。</p><p>实时统计按新周期计算；已提交日报的原始快照保留。</p>{impact.changes.map((change) => <p key={change.name}>{change.name}：{change.before} → {change.after}</p>)}</div>}
        <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t bg-white/95 px-4 py-3 backdrop-blur md:px-5"><span className="text-xs text-gray-500">保存前会展示对现有日报和目标的影响</span>{impact ? <button className={button} onClick={() => void save()}>确认并保存</button> : <button className={button} onClick={() => void preview()}>预览影响</button>}</div>
      </section> : <section className="space-y-5">
        {!selected ? <div className="rounded-xl border bg-white p-8 text-center"><p className="font-medium">请先创建经营月份</p><p className="mt-1 text-sm text-gray-500">PK 班级和门店分配按经营月分别保存。</p><button type="button" className={`${button} mt-4`} onClick={() => { setTab('period'); change('') }}>新建经营月</button></div> : <>
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
              return <tr key={store.id} className="border-t"><td className="px-4 py-3 font-medium">{store.name}</td><td className="px-4 py-3 text-gray-500">{store.area || '未分配区域'}</td><td className="w-56 px-4 py-2"><select aria-label={store.name + '班级'} className={field} value={assignment?.classId || ''} onChange={(e) => {
                const rest = assignments.filter((s) => s.storeId !== store.id)
                setAssignments(e.target.value ? [...rest, { periodId: selected, storeId: store.id, classId: e.target.value, legion: assignment?.legion || '', groupName: assignment?.groupName || '', mentorName: assignment?.mentorName || '' }] : rest)
              }}><option value="">不参加</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name || '未命名班级'}</option>)}</select></td><td className="w-52 px-4 py-2"><select aria-label={store.name + 'legion'} disabled={!assignment} className={field} value={assignment?.legion || ''} onChange={(e) => setAssignments(assignments.map((s) => s.storeId === store.id ? { ...s, legion: e.target.value } : s))}><option value="">选择军团</option><option value="红军">红军</option><option value="蓝军">蓝军</option></select></td><td className="w-52 px-4 py-2"><input aria-label={store.name + 'mentorName'} disabled={!assignment} placeholder="指导员" className={field} value={assignment?.mentorName || ''} onChange={(e) => setAssignments(assignments.map((s) => s.storeId === store.id ? { ...s, mentorName: e.target.value } : s))}/></td></tr>
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
      </section>}
    </fieldset>

    <details className="rounded-xl border bg-white"><summary className="cursor-pointer px-4 py-4 font-semibold">配置修改记录 <span className="ml-2 text-sm font-normal text-gray-500">最近 {initial.logs.length} 条</span></summary><div className="border-t px-4 py-3"><p className="mb-3 text-sm text-gray-500">记录操作人、时间和变更前后的配置。</p>{initial.logs.map((log) => <details key={log.id} className="mb-2 rounded-lg border p-3"><summary className="cursor-pointer text-sm">{log.action === 'daily.period.save' ? '修改经营周期' : '修改 PK 班级'} · {log.operator || '系统'} · {new Date(log.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</summary><div className="mt-3 space-y-2 text-sm text-gray-600"><p>变更前：{auditText(log.detail, 'before', initial.stores)}</p><p>变更后：{auditText(log.detail, 'after', initial.stores)}</p></div></details>)}{!initial.logs.length && <p className="text-sm text-gray-500">暂无修改记录</p>}</div></details>
  </div>
}
