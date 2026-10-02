'use client'
import { useState } from 'react'
import { getDailyConfiguration, previewDailyPeriod, saveDailyPeriod, saveDailyPk } from '@/actions/daily-config'
import { type DailyPeriodInput } from '@/lib/daily-config'
import { actionErrorMessage } from '@/lib/action-error'

type Configuration = Awaited<ReturnType<typeof getDailyConfiguration>>
const blank = (): DailyPeriodInput => ({ id: crypto.randomUUID().slice(0, 30), name: '', start: '', end: '', version: 0,
  weeks: [1, 2, 3, 4].map((n) => ({ id: 'w' + n, name: '第' + n + '周', start: '', end: '' })) })
const field = 'rounded border px-3 py-2 bg-white w-full'
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
const button = 'rounded bg-[#C0322A] text-white px-4 py-2 disabled:opacity-50'
export default function DailyConfiguration({ initial: initialConfiguration }: { initial: Configuration }) {
  const [initial, setInitial] = useState(initialConfiguration)
  const [tab, setTab] = useState('period'), [selected, setSelected] = useState(initial.periods[0]?.id || '')
  const [period, setPeriod] = useState<DailyPeriodInput>(initial.periods[0] || blank())
  const [classes, setClasses] = useState(initial.classes.filter((c) => c.periodId === selected))
  const [assignments, setAssignments] = useState(initial.assignments.filter((s) => s.periodId === selected))
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [impact, setImpact] = useState<Awaited<ReturnType<typeof previewDailyPeriod>> | null>(null)
  const change = (id: string, configuration = initial) => {
    const p = configuration.periods.find((p) => p.id === id)
    setSelected(id); setPeriod(p || blank()); setImpact(null); setMessage('')
    setClasses(configuration.classes.filter((c) => c.periodId === id)); setAssignments(configuration.assignments.filter((s) => s.periodId === id))
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
    setClasses(classes.filter((c) => c.id !== id)); setAssignments(assignments.filter((s) => s.classId !== id))
  }
  const pk = async () => {
    const p = initial.periods.find((p) => p.id === selected)
    if (!p) return
    setBusy(true); setMessage('')
    try { await saveDailyPk({ periodId: selected, expectedVersion: p.version, classes, stores: assignments }); const configuration = await getDailyConfiguration(); setInitial(configuration); change(selected, configuration); setMessage('PK 班级及门店已保存') }
    catch (e) { setMessage(actionErrorMessage(e, '保存失败，请重试')) } finally { setBusy(false) }
  }
  return <main className="space-y-6 p-6"><h1 className="text-2xl font-semibold">日报经营配置</h1>
    <div className="flex gap-3"><button onClick={() => setTab('period')} className={tab === 'period' ? button : 'px-4 py-2'}>经营周期</button><button onClick={() => setTab('pk')} className={tab === 'pk' ? button : 'px-4 py-2'}>PK 班级</button></div>
    {message && <div role="status" className="rounded bg-amber-50 p-3">{message}</div>}
    <fieldset disabled={busy} className="space-y-5">
      <div className="flex items-center gap-4"><label>经营月份<select className={field} value={selected} onChange={(e) => change(e.target.value)}><option value="">新增经营月</option>{initial.periods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{tab === 'period' && <button onClick={() => change('')} className={button}>新增经营月</button>}</div>
      {tab === 'period' ? <section className="space-y-5 rounded-xl border bg-white p-5"><h2 className="text-lg font-semibold">{period.version ? '编辑经营周期' : '新建经营周期'}</h2>
        <div className="grid gap-4 md:grid-cols-3"><label>月份名称<input className={field} value={period.name} onChange={(e) => edit({ name: e.target.value })} maxLength={60}/></label><label>开始日期<input type="date" className={field} value={period.start} onChange={(e) => edit({ start: e.target.value })}/></label><label>结束日期<input type="date" className={field} value={period.end} onChange={(e) => edit({ end: e.target.value })}/></label></div>
        <p className="text-sm text-gray-500">配置四个连续经营周，可使用不同天数；四周必须完整覆盖经营月。</p>
        {period.weeks.map((w, i) => <div key={w.id} className="grid gap-4 md:grid-cols-3"><label>第 {i + 1} 周名称<input className={field} value={w.name} onChange={(e) => edit({ weeks: period.weeks.map((v, n) => n === i ? { ...v, name: e.target.value } : v) })}/></label><label>开始日期<input type="date" className={field} value={w.start} onChange={(e) => edit({ weeks: period.weeks.map((v, n) => n === i ? { ...v, start: e.target.value } : v) })}/></label><label>结束日期<input type="date" className={field} value={w.end} onChange={(e) => edit({ weeks: period.weeks.map((v, n) => n === i ? { ...v, end: e.target.value } : v) })}/></label></div>)}
        <button className={button} onClick={() => void preview()}>预览影响</button>
        {impact && <div className="space-y-3 rounded bg-amber-50 p-4"><p>日期范围内涉及 {impact.reports} 份日报、{impact.targets} 项目标、{impact.classes} 个 PK 班级。</p><p>实时统计按新周期计算；已提交日报的原始快照保留。</p>{impact.changes.map((change) => <p key={change.name}>{change.name}：{change.before} → {change.after}</p>)}<button className={button} onClick={() => void save()}>确认并保存配置</button></div>}
      </section> : <section className="space-y-4 rounded-xl border bg-white p-5"><h2 className="text-lg font-semibold">班级与门店分配</h2>
        {!selected ? <p>请先创建并选择经营月。</p> : <><p className="text-sm text-gray-500">每家门店同月只能参加一个班级，员工与店长按员工档案的所属门店参与。</p>
          <div className="space-y-2">{classes.map((c, i) => <div key={c.id} className="flex items-end gap-3"><label className="flex-1">班级 {i + 1}<input className={field} value={c.name} maxLength={30} onChange={(e) => setClasses(classes.map((v, n) => n === i ? { ...v, name: e.target.value } : v))}/></label><button type="button" className="px-4 py-2 text-[#C0322A]" onClick={() => removeClass(c.id)}>移除班级</button></div>)}</div>
          <button className={button} onClick={() => setClasses([...classes, { id: crypto.randomUUID(), name: '', periodId: selected }])}>添加班级</button>
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['门店', '班级', '军团', '小组', '指导员'].map((s) => <th className="p-3 text-left" key={s}>{s}</th>)}</tr></thead><tbody>{initial.stores.map((store) => {
            const assignment = assignments.find((s) => s.storeId === store.id)
            return <tr key={store.id} className="border-t"><td className="p-3">{store.name}</td><td className="p-3"><select aria-label={store.name + '班级'} className={field} value={assignment?.classId || ''} onChange={(e) => {
              const rest = assignments.filter((s) => s.storeId !== store.id)
              setAssignments(e.target.value ? [...rest, { periodId: selected, storeId: store.id, classId: e.target.value, legion: assignment?.legion || '', groupName: assignment?.groupName || '', mentorName: assignment?.mentorName || '' }] : rest)
            }}><option value="">不参加</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name || '未命名班级'}</option>)}</select></td>{(['legion', 'groupName', 'mentorName'] as const).map((key) => <td key={key} className="p-3"><input aria-label={store.name + key} disabled={!assignment} className={field} value={assignment?.[key] || ''} onChange={(e) => setAssignments(assignments.map((s) => s.storeId === store.id ? { ...s, [key]: e.target.value } : s))}/></td>)}</tr>
          })}</tbody></table></div><button className={button} onClick={() => void pk()}>保存 PK 配置</button></>}
        {classes.map((c) => {
          const rows = initial.members.filter((m) => assignments.some((a) => a.classId === c.id && a.storeId === m.storeId))
          return <section key={c.id} className="space-y-3 rounded-xl border p-4"><h3 className="font-semibold">{c.name || '未命名班级'}</h3><p className="text-sm text-gray-500">{assignments.filter((a) => a.classId === c.id).length} 家门店 · {rows.length} 位参与人员</p><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['区域', '军团', '小组', '指导员', '姓名', '岗位', '门店'].map((label) => <th key={label} className="p-3 text-left">{label}</th>)}</tr></thead><tbody>{rows.map((member) => {
            const store = initial.stores.find((s) => s.id === member.storeId), a = assignments.find((a) => a.storeId === member.storeId)
            return <tr key={member.id} className="border-t">{[store?.area, a?.legion, a?.groupName, a?.mentorName, member.name, member.position, store?.name].map((value, i) => <td key={i} className="p-3">{value || '—'}</td>)}</tr>
          })}{!rows.length && <tr><td colSpan={7} className="p-3 text-gray-500">暂无参与人员</td></tr>}</tbody></table></div></section>
        })}
      </section>}
    </fieldset>
    <section className="space-y-3 rounded-xl border bg-white p-5"><h2 className="text-lg font-semibold">配置修改记录</h2><p className="text-sm text-gray-500">最近30条操作，记录操作人、时间和变更前后的配置。</p>{initial.logs.map((log) => <details key={log.id} className="rounded border p-3"><summary className="cursor-pointer">{log.action === 'daily.period.save' ? '修改经营周期' : '修改PK班级'} · {log.operator || '系统'} · {new Date(log.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</summary><div className="mt-3 space-y-2 text-sm"><p>变更前：{auditText(log.detail, 'before', initial.stores)}</p><p>变更后：{auditText(log.detail, 'after', initial.stores)}</p></div></details>)}{!initial.logs.length && <p className="text-gray-500">暂无修改记录</p>}</section>
  </main>
}
