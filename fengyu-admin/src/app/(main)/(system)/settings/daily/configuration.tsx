'use client'
import { useState } from 'react'
import { getDailyConfiguration, previewDailyPeriod, saveDailyPeriod, saveDailyPk } from '@/actions/daily-config'
import { type DailyPeriodInput } from '@/lib/daily-config'
import { actionErrorMessage } from '@/lib/action-error'

type Configuration = Awaited<ReturnType<typeof getDailyConfiguration>>
const blank = (): DailyPeriodInput => ({ id: crypto.randomUUID().slice(0, 30), name: '', start: '', end: '', version: 0,
  weeks: [1, 2, 3, 4].map((n) => ({ id: 'w' + n, name: '第' + n + '周', start: '', end: '' })) })
const field = 'rounded border px-3 py-2 bg-white w-full'
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
        {impact && <div className="space-y-3 rounded bg-amber-50 p-4"><p>日期范围内涉及 {impact.reports} 份日报、{impact.targets} 项目标、{impact.classes} 个 PK 班级。</p><p>实时统计按新周期计算；已提交日报的原始快照保留。</p><button className={button} onClick={() => void save()}>确认并保存配置</button></div>}
      </section> : <section className="space-y-4 rounded-xl border bg-white p-5"><h2 className="text-lg font-semibold">班级与门店分配</h2>
        {!selected ? <p>请先创建并选择经营月。</p> : <><p className="text-sm text-gray-500">每家门店同月只能参加一个班级，员工与店长按员工档案的所属门店参与。</p>
          <div className="space-y-2">{classes.map((c, i) => <label key={c.id} className="block">班级 {i + 1}<input className={field} value={c.name} maxLength={30} onChange={(e) => setClasses(classes.map((v, n) => n === i ? { ...v, name: e.target.value } : v))}/></label>)}</div>
          <button className={button} onClick={() => setClasses([...classes, { id: crypto.randomUUID(), name: '', periodId: selected }])}>添加班级</button>
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['门店', '班级', '军团', '小组', '指导员'].map((s) => <th className="p-3 text-left" key={s}>{s}</th>)}</tr></thead><tbody>{initial.stores.map((store) => {
            const assignment = assignments.find((s) => s.storeId === store.id)
            return <tr key={store.id} className="border-t"><td className="p-3">{store.name}</td><td className="p-3"><select aria-label={store.name + '班级'} className={field} value={assignment?.classId || ''} onChange={(e) => {
              const rest = assignments.filter((s) => s.storeId !== store.id)
              setAssignments(e.target.value ? [...rest, { periodId: selected, storeId: store.id, classId: e.target.value, legion: assignment?.legion || '', groupName: assignment?.groupName || '', mentorName: assignment?.mentorName || '' }] : rest)
            }}><option value="">不参加</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name || '未命名班级'}</option>)}</select></td>{(['legion', 'groupName', 'mentorName'] as const).map((key) => <td key={key} className="p-3"><input aria-label={store.name + key} disabled={!assignment} className={field} value={assignment?.[key] || ''} onChange={(e) => setAssignments(assignments.map((s) => s.storeId === store.id ? { ...s, [key]: e.target.value } : s))}/></td>)}</tr>
          })}</tbody></table></div><button className={button} onClick={() => void pk()}>保存 PK 配置</button></>}
      </section>}
    </fieldset>
  </main>
}
