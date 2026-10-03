'use client'
import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { actionErrorMessage } from '@/lib/action-error'
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
export function TargetEntry({ initial }: { initial: Data }) {
  const [data, setData] = useState(initial),
    [month, setMonth] = useState(values(initial)),
    [week, setWeek] = useState(values(initial, true)),
    [penalty, setPenalty] = useState(initial.target?.penalty || ''),
    [busy, setBusy] = useState(false)
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
    editable =
      !!data.period && data.period.start <= today && today <= data.period.end,
    confirmed = !!data.target?.month_confirmed,
    countsConfirmed = !!data.target?.counts_month_confirmed,
    automatic = data.week?.id === data.period?.weeks[3].id
  async function reload(input: {
    periodId?: string
    scope?: string
    scopeId?: string
  }) {
    setBusy(true)
    try {
      const result = await getOwnOperatingTarget(input)
      setData(result)
      setMonth(values(result))
      setWeek(values(result, true))
      setPenalty(result.target?.penalty || '')
    } catch (e) {
      toast.error(actionErrorMessage(e, '读取目标失败'))
    } finally {
      setBusy(false)
    }
  }
  async function save(kind: 'month' | 'week') {
    if (!data.period || !editable || busy) return
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
        ...(kind === 'month' ? month : week),
        penalty,
      })
      const result = await getOwnOperatingTarget({
        periodId: data.period.id,
        scope: data.scope.scope,
        scopeId: data.scope.scopeId,
      })
      setData(result)
      setMonth(values(result))
      setWeek(values(result, true))
      toast.success('目标已保存')
    } catch (e) {
      toast.error(actionErrorMessage(e, '保存失败'))
    } finally {
      setBusy(false)
    }
  }
  const field = 'h-10 w-full rounded-md border border-[var(--border)] bg-white px-3'
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
  return (
    <main className="space-y-5 p-6">
      <div className="flex justify-between">
        <h1 className="text-2xl font-semibold">经营目标填报</h1>
        <Link className="text-[#C0322A]" href="/data-center/operating-progress">
          查看目标进度
        </Link>
      </div>
      <fieldset
        disabled={busy}
        className="flex flex-wrap gap-3 rounded-xl border border-[var(--border)] bg-white p-4"
      >
        <select
          aria-label="经营月"
          className="h-10 rounded-md border border-[var(--border)] px-3"
          value={data.period?.id || ''}
          onChange={(e) =>
            void reload({
              periodId: e.target.value,
              scope: data.scope.scope,
              scopeId: data.scope.scopeId,
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
          aria-label="本人目标范围"
          className="h-10 rounded-md border border-[var(--border)] px-3"
          value={data.scope.scope + ':' + data.scope.scopeId}
          onChange={(e) => {
            const s = data.scopes.find(
              (s) => s.scope + ':' + s.scopeId === e.target.value,
            )
            if (s)
              void reload({
                periodId: data.period?.id,
                scope: s.scope,
                scopeId: s.scopeId,
              })
          }}
        >
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
      {!data.period ? (
        <p className="rounded-xl border border-[var(--border)] bg-white p-8">
          尚未配置经营周期，请联系管理员。
        </p>
      ) : (
        <>
          <p className="text-sm text-gray-500">
            {data.period.start} 至 {data.period.end}
            {!editable ? ' · 历史或未来经营月仅可查看' : ''}
          </p>
          <section className="space-y-4 rounded-xl border border-[var(--border)] bg-white p-5">
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
          </section>
          {confirmed && data.week && (
            <section className="space-y-4 rounded-xl border border-[var(--border)] bg-white p-5">
              <h2 className="text-lg font-semibold">{data.week.name}目标</h2>
              <p className="text-sm text-gray-500">
                {data.week.start} 至 {data.week.end}
              </p>
              {automatic ? (
                <p>第 4 周由月目标减去前三周目标自动计算。</p>
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
            </section>
          )}
          {confirmed && (
            <section className="overflow-auto rounded-xl border border-[var(--border)] bg-white p-5">
              <h2 className="mb-4 text-lg font-semibold">四周目标安排</h2>
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
            </section>
          )}
        </>
      )}
    </main>
  )
}
