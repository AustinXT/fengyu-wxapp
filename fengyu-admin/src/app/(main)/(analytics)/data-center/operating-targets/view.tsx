'use client'
import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { actionErrorMessage } from '@/lib/action-error'
import { cents, count, distributeByDays } from '@/lib/operating/operating-target'
import { ReportInfoBar } from '../_components/report/report-info-bar'
import {
  getOwnOperatingTarget,
  saveOwnOperatingTarget,
} from '@/actions/operating-targets'
import type { Metric } from '@/lib/operating/workspace'
const specs = [
  { key: 'sales', label: '业绩', unit: '元' },
  { key: 'consumption', label: '消耗', unit: '元' },
  { key: 'visits', label: '客量', unit: '人次' },
  { key: 'newCustomers', label: '新客', unit: '人' },
  { key: 'projects', label: '项目数', unit: '次' },
] as const
const display = (n: number | null | undefined, key: Metric) =>
  n == null
    ? ''
    : key === 'sales' || key === 'consumption'
      ? (n / 100).toFixed(2)
      : String(n)
type Data = Awaited<ReturnType<typeof getOwnOperatingTarget>>
function values(data: Data, week = false) {
  return Object.fromEntries(
    specs.map((s) => [
      s.key,
      display(
        week
          ? data.target?.weeks[data.week?.id || '']?.[s.key]
          : data.target?.[s.key],
        s.key,
      ),
    ]),
  ) as Record<Metric, string>
}
function planValues(data: Data) {
  return Object.fromEntries((data.period?.weeks || []).map((w) => [w.id, Object.fromEntries(specs.map((s) => [s.key, display(data.target?.weeks[w.id]?.[s.key], s.key)]))])) as Record<string, Record<Metric, string>>
}
export function TargetEntry({ initial }: { initial: Data }) {
  const [data, setData] = useState(initial),
    [month, setMonth] = useState(values(initial)),
    [week, setWeek] = useState(values(initial, true)),
    [weekPlan, setWeekPlan] = useState(planValues(initial)),
    [weekPlanTouched, setWeekPlanTouched] = useState(false),
    [penalty, setPenalty] = useState(initial.target?.penalty || ''),
    [busy, setBusy] = useState(false)
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
    editable =
      !!data.period && data.period.start <= today && today <= data.period.end,
    confirmed = !!data.target?.month_confirmed,
    countsConfirmed = !!data.target?.counts_month_confirmed,
    automatic = data.week?.id === data.period?.weeks[data.period.weeks.length - 1]?.id
  async function reload(input: {
    periodId?: string
    scope?: string
    scopeId?: string
    regionId?: string | null
  }) {
    setBusy(true)
    try {
      const result = await getOwnOperatingTarget(input)
      setData(result)
      setMonth(values(result))
      setWeek(values(result, true))
      setWeekPlan(planValues(result))
      setWeekPlanTouched(false)
      setPenalty(result.target?.penalty || '')
    } catch (e) {
      toast.error(actionErrorMessage(e, '读取目标失败'))
    } finally {
      setBusy(false)
    }
  }
  async function save(kind: 'month' | 'week') {
    if (!data.period || !data.scope || !editable || busy) return
    if (
      kind === 'month' &&
      !window.confirm('确认后本月目标不可修改，是否确认？')
    )
      return
    setBusy(true)
    try {
      await saveOwnOperatingTarget({
        kind,
        periodId: data.period.id,
        periodVersion: data.period.version,
        version: data.target?.version || 0,
        scope: data.scope.scope,
        scopeId: data.scope.scopeId,
        regionId: data.scope.regionId,
        ...(kind === 'month' ? month : week),
        ...(kind === 'month' && weekPlanTouched ? { weekPlan } : {}),
        penalty,
      })
      const result = await getOwnOperatingTarget({
        periodId: data.period.id,
        scope: data.scope.scope,
        scopeId: data.scope.scopeId,
        regionId: data.scope.regionId,
      })
      setData(result)
      setMonth(values(result))
      setWeek(values(result, true))
      setWeekPlan(planValues(result))
      setWeekPlanTouched(false)
      toast.success('目标已保存')
    } catch (e) {
      toast.error(actionErrorMessage(e, '保存失败'))
    } finally {
      setBusy(false)
    }
  }
  const field = 'h-10 w-full rounded-md border border-[var(--border)] bg-white px-3 text-sm text-[var(--foreground)]'
  const fixed = (key: Metric) =>
    (confirmed && (key === 'sales' || key === 'consumption')) ||
    (countsConfirmed &&
      (key === 'visits' || key === 'newCustomers' || key === 'projects'))
  const valid = (raw: Record<Metric, string>) =>
    specs.every((s) =>
      s.key === 'sales' || s.key === 'consumption'
        ? /^\d+(\.\d{1,2})?$/.test(raw[s.key]) &&
          Number(raw[s.key]) >= (confirmed ? 0 : 0.01)
        : /^\d+$/.test(raw[s.key]) && Number(raw[s.key]) <= 2147483647,
    )
  function autoDistribute() {
    if (!data.period) return
    const days = data.period.weeks.map((w) => Math.round((Date.parse(w.end + 'T12:00:00Z') - Date.parse(w.start + 'T12:00:00Z')) / 86400000) + 1)
    const next = { ...weekPlan }
    for (const s of specs) {
      const raw = month[s.key]
      if (!raw || !/^\d+(\.\d{1,2})?$/.test(raw)) continue
      let total: number
      try { total = s.key === 'sales' || s.key === 'consumption' ? cents(raw) : count(raw) } catch { return }
      distributeByDays(total, days).forEach((amount, i) => {
        const w = data.period!.weeks[i]
        next[w.id] = { ...next[w.id], [s.key]: s.key === 'sales' || s.key === 'consumption' ? (amount / 100).toFixed(2) : String(amount) }
      })
    }
    setWeekPlan(next)
    setWeekPlanTouched(true)
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[var(--foreground)]">经营目标填报</h1>
        <Link className="rounded-md border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] hover:border-[var(--primary)] hover:text-[var(--primary)]" href="/data-center/operating-progress">
          查看美容师进度
        </Link>
      </div>
      <fieldset
        disabled={busy}
        className="flex flex-wrap gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card)] p-4"
      >
        <select
          aria-label="经营月"
          className="h-10 rounded-md border border-[var(--border)] px-3"
          value={data.period?.id || ''}
          onChange={(e) =>
            void reload({
              periodId: e.target.value,
              ...(data.scope ? { scope: data.scope.scope, scopeId: data.scope.scopeId } : {}),
            })
          }
        >
          <option value="">当前经营月</option>
          {data.periods.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          aria-label="目标填报对象"
          className="h-10 rounded-md border border-[var(--border)] px-3"
          value={data.scope ? data.scope.scope + ':' + data.scope.scopeId : ''}
          onChange={(e) => {
            const s = data.scopes.find(
              (s) => s.scope + ':' + s.scopeId === e.target.value,
            )
            if (s)
              void reload({
                periodId: s.regionId === data.scope?.regionId ? data.period?.id : undefined,
                scope: s.scope,
                scopeId: s.scopeId,
                regionId: s.regionId,
              })
          }}
        >
          {!data.scope && <option value="">请选择填报对象</option>}
          {data.scopes.map((s) => (
            <option
              key={s.scope + ':' + s.scopeId}
              value={s.scope + ':' + s.scopeId}
            >
              {s.name}
            </option>
          ))}
        </select>
      </fieldset>
      <ReportInfoBar items={[
        { label: '填报对象', value: data.scope?.name || '请选择门店或员工' },
        { label: '经营月', value: data.period ? `${data.period.name}（${data.period.start} 至 ${data.period.end}）${!editable ? ' · 历史或未来月份仅可查看' : ''}` : '尚未配置经营周期' },
      ]} />
      {!data.scope ? (
        <Card className="p-8 text-sm text-[var(--muted-foreground)]">
          请选择一个具体门店或员工，再查看或填写该对象的经营目标。
        </Card>
      ) : !data.period ? (
        <Card className="p-8 text-sm text-[var(--muted-foreground)]">
          尚未配置经营周期，请联系管理员。
        </Card>
      ) : (
        <>
          <Card className="space-y-4 p-5">
            <div className="flex justify-between">
              <h2 className="text-lg font-semibold">本经营月目标</h2>
              <span>
                {confirmed && countsConfirmed
                  ? '已确认 · 不可修改'
                  : confirmed
                    ? '补充三项计数目标'
                    : '待确认'}
              </span>
            </div>
            <div className="grid gap-4 md:grid-cols-5">
              {specs.map((s) => (
                <label key={s.key} className="space-y-2 text-sm">
                  <span>
                    {s.label}（{s.unit}）
                  </span>
                  <Input
                    aria-label={'月' + s.label + '目标'}
                    className={field}
                    type="number"
                    min="0"
                    step={
                      s.key === 'sales' || s.key === 'consumption'
                        ? '0.01'
                        : '1'
                    }
                    disabled={busy || !editable || fixed(s.key)}
                    value={month[s.key]}
                    onChange={(e) =>
                      setMonth({ ...month, [s.key]: e.target.value })
                    }
                  />
                </label>
              ))}
            </div>
            {(!confirmed || !countsConfirmed) && editable && <div className="space-y-3 rounded-lg bg-[#F8F9FB] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-medium">按周分摊</h3><p className="text-xs text-gray-500">按经营周天数分配，最后一周自动补足；可手动调整前面各周。</p></div><Button type="button" variant="outline" onClick={autoDistribute}>按经营天数自动分摊</Button></div>
              <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm"><thead><tr><th className="p-2 text-left">经营周</th>{specs.map((s) => <th key={s.key} className="p-2 text-right">{s.label}</th>)}</tr></thead><tbody>{data.period.weeks.map((w, i) => <tr key={w.id} className="border-t"><td className="p-2">{w.name} · {w.start}—{w.end}</td>{specs.map((s) => { const raw = weekPlan[w.id]?.[s.key] || ''; const total = s.key === 'sales' || s.key === 'consumption' ? Math.round(Number(month[s.key] || 0) * 100) : Number(month[s.key] || 0); const used = data.period!.weeks.slice(0, i).reduce((n, prev) => { const v = weekPlan[prev.id]?.[s.key] || '0'; return n + (s.key === 'sales' || s.key === 'consumption' ? Math.round(Number(v) * 100) : Number(v)) }, 0); const balance = Math.max(0, total - used); return <td key={s.key} className="p-2 text-right">{i < data.period!.weeks.length - 1 ? <Input aria-label={`${w.name}${s.label}分摊`} type="number" min="0" step={s.key === 'sales' || s.key === 'consumption' ? '0.01' : '1'} value={raw} onChange={(e) => { setWeekPlan({ ...weekPlan, [w.id]: { ...weekPlan[w.id], [s.key]: e.target.value } }); setWeekPlanTouched(true) }}/>: <span>{s.key === 'sales' || s.key === 'consumption' ? (balance / 100).toFixed(2) : String(balance)}</span>}</td> })}</tr>)}</tbody></table></div>
            </div>}
            {data.scope.scope === 'personal' && (
              <label className="block space-y-2 text-sm">
                <span>本月负激励</span>
                <textarea
                  className="w-full rounded-md border border-[var(--border)] p-3"
                  maxLength={500}
                  disabled={busy || confirmed || !editable}
                  value={penalty}
                  onChange={(e) => setPenalty(e.target.value)}
                />
              </label>
            )}
            {(!confirmed || !countsConfirmed) && editable && (
              <Button
                disabled={
                  busy ||
                  !valid(month) ||
                  (data.scope.scope === 'personal' && !penalty.trim())
                }
                onClick={() => void save('month')}
              >
                {confirmed ? '补充确认三项月目标' : '确认本月五项目标'}
              </Button>
            )}
          </Card>
          {confirmed && data.week && (
            <Card className="space-y-4 p-5">
              <h2 className="text-lg font-semibold">{data.week.name}目标</h2>
              <p className="text-sm text-gray-500">
                {data.week.start} 至 {data.week.end}
              </p>
              {automatic ? (
                <p>最后一周由月目标减去前面各周目标自动计算。</p>
              ) : (
                <>
                  <div className="grid gap-4 md:grid-cols-5">
                    {specs.map((s) => (
                      <label key={s.key} className="space-y-2 text-sm">
                        <span>
                          {s.label}（{s.unit}）
                        </span>
                        <Input
                          aria-label={'周' + s.label + '目标'}
                          className={field}
                          type="number"
                          min="0"
                          step={
                            s.key === 'sales' || s.key === 'consumption'
                              ? '0.01'
                              : '1'
                          }
                          value={week[s.key]}
                          disabled={busy || !editable || !countsConfirmed}
                          onChange={(e) =>
                            setWeek({ ...week, [s.key]: e.target.value })
                          }
                        />
                      </label>
                    ))}
                  </div>
                  {editable && (
                    <Button
                      disabled={busy || !countsConfirmed || !valid(week)}
                      onClick={() => void save('week')}
                    >
                      保存当前周五项目标
                    </Button>
                  )}
                </>
              )}
            </Card>
          )}
          {confirmed && (
            <Card className="overflow-auto p-5">
              <h2 className="mb-4 text-lg font-semibold">经营周目标安排</h2>
              <table className="w-full whitespace-nowrap text-sm">
                <thead>
                  <tr>
                    <th className="p-3 text-left">经营周</th>
                    <th className="p-3 text-left">日期</th>
                    {specs.map((s) => (
                      <th className="p-3 text-right" key={s.key}>
                        {s.label}（{s.unit}）
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.period.weeks.map((w) => (
                    <tr className="border-t border-[var(--border)]" key={w.id}>
                      <td className="p-3">
                        {w.name}
                        {w.id === data.week?.id ? ' · 当前' : ''}
                      </td>
                      <td className="p-3">
                        {w.start} 至 {w.end}
                      </td>
                      {specs.map((s) => (
                        <td className="p-3 text-right" key={s.key}>
                          {display(data.target?.weeks[w.id]?.[s.key], s.key) ||
                            '未设置'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
