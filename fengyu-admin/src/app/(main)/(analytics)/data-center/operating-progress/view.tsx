'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Pagination } from '@/components/ui/pagination'
import { ExportButton } from '@/components/ui/export-button'
import { Card } from '@/components/ui/card'
import { ReportInfoBar } from '../_components/report/report-info-bar'
import { actionErrorMessage } from '@/lib/action-error'
import {
  getOperatingProgress,
  getOperatingPk,
} from '@/actions/operating-targets'
import type { Filters, Metric, OperatingRow } from '@/lib/operating/workspace'
const labels: Record<Metric, string> = {
  sales: '业绩',
  consumption: '消耗',
  visits: '客量',
  newCustomers: '新客',
  projects: '项目数',
}
const keys = Object.keys(labels) as Metric[]
const amount = (n: number | null, k: Metric) =>
  n == null
    ? '未设置'
    : k === 'sales' || k === 'consumption'
      ? (n / 100).toFixed(2)
      : String(n)
const rate = (done: number, target: number | null) =>
  target != null && target > 0 ? ((done / target) * 100).toFixed(2) + '%' : '—'
function dates(start: string, end: string) {
  const out = []
  for (
    let t = Date.parse(start + 'T12:00:00Z');
    t <= Date.parse(end + 'T12:00:00Z');
    t += 86400000
  )
    out.push(new Date(t).toISOString().slice(0, 10))
  return out
}
type Data = Awaited<ReturnType<typeof getOperatingProgress>>
type ProgressDimension = NonNullable<Filters['dimension']>
const dimensionTitle: Record<ProgressDimension, string> = {
  personal: '美容师目标进度表',
  store: '门店目标进度表',
  market: '区域目标进度表',
}
export function OperatingView({
  initial,
  pk = false,
  dimension = 'personal',
}: {
  initial: Data
  pk?: boolean
  dimension?: ProgressDimension
}) {
  const [data, setData] = useState(initial),
    [filters, setFilters] = useState<Filters>({
      ...initial.filters,
      periodId: initial.period?.id,
      dimension,
    }),
    [metric, setMetric] = useState<Metric | 'all'>(pk ? 'sales' : 'all'),
    [layout, setLayout] = useState<'block' | 'matrix'>('block'),
    [view, setView] = useState<'week' | 'month'>('week'),
    [reverse, setReverse] = useState(false),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState(1),
    [search, setSearch] = useState('')
  const selected = metric === 'all' ? keys : [metric]
  const rows = useMemo(() => {
    const rows = data.rows.slice()
    if (pk) {
      const key = metric === 'all' ? 'sales' : metric
      rows.sort((a, b) => {
        const x = a.values[key],
          y = b.values[key]
        if (!(x.weekTarget && x.weekTarget > 0))
          return y.weekTarget && y.weekTarget > 0 ? 1 : 0
        if (!(y.weekTarget && y.weekTarget > 0)) return -1
        const left = BigInt(x.weekDone) * BigInt(y.weekTarget),
          right = BigInt(y.weekDone) * BigInt(x.weekTarget)
        return left === right ? 0 : left > right ? -1 : 1
      })
    }
    const ranked = rows
      .map((r, index) => ({ ...r, rank: index + 1 }))
      .filter(
        (r) =>
          !search ||
          [r.name, r.storeName, r.position, r.scopeName].some((v) =>
            v?.includes(search),
          ),
      )
    return reverse ? ranked.reverse() : ranked
  }, [data.rows, metric, reverse, pk, search])
  async function load(next: Filters) {
    setBusy(true)
    try {
      const scoped = { ...next, dimension }
      setData(await (pk ? getOperatingPk(scoped) : getOperatingProgress(scoped)))
      setFilters(scoped)
      setPage(1)
    } catch (e) {
      toast.error(actionErrorMessage(e, '读取失败'))
    } finally {
      setBusy(false)
    }
  }
  const field = 'h-10 rounded-md border border-[var(--border)] bg-white px-3 text-sm text-[var(--foreground)]'
  const actual = (row: OperatingRow, key: Metric) => {
    const v = row.values[key]
    return view === 'week' ? v.weekDone : v.monthDone
  }
  const target = (row: OperatingRow, key: Metric) => {
    const v = row.values[key]
    return view === 'week' ? v.weekTarget : v.monthTarget
  }
  const columns = pk
    ? []
    : view === 'week' && data.week
      ? dates(data.week.start, data.week.end)
      : data.period?.weeks.map((w) => w.id) || []
  const breakdown = (row: OperatingRow, key: Metric, column: string) => {
    const v = row.values[key]
    return view === 'week'
      ? v.days.find((d) => d.date === column)?.done || 0
      : v.weeks.find((w) => w.id === column)?.done || 0
  }
  async function exportRows() {
    const ExcelJS = (await import('exceljs')).default
    const book = new ExcelJS.Workbook()
    const sheet = book.addWorksheet(pk ? 'PK榜' : '目标进度')
    sheet.addRow([
      '名次',
      '姓名／对象',
      '区域',
      '门店',
      '岗位',
      '统计范围',
      '军团',
      '指导员',
      '指标',
      ...(pk
        ? [
            '本周目标',
            '本周完成',
            '本周完成率',
            '本月目标',
            '本月完成',
            '本月完成率',
          ]
        : [
            '目标',
            '实际完成',
            '完成率',
            ...columns.map((c) =>
              view === 'week'
                ? c
                : data.period?.weeks.find((w) => w.id === c)?.name || c,
            ),
          ]),
    ])
    for (const row of rows)
      for (const key of selected) {
        const v = row.values[key]
        sheet.addRow([
          row.rank,
          row.name,
          row.area || '',
          row.storeName || '',
          row.position || '',
          row.scopeName,
          row.legion || '',
          row.mentor || '',
          labels[key],
          ...(pk
            ? [
                amount(v.weekTarget, key),
                amount(v.weekDone, key),
                rate(v.weekDone, v.weekTarget),
                amount(v.monthTarget, key),
                amount(v.monthDone, key),
                rate(v.monthDone, v.monthTarget),
              ]
            : [
                amount(target(row, key), key),
                amount(actual(row, key), key),
                rate(actual(row, key), target(row, key)),
                ...columns.map((c) => amount(breakdown(row, key, c), key)),
              ]),
        ])
      }
    sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }]
    sheet.columns.forEach((c) => (c.width = 18))
    const bytes = await book.xlsx.writeBuffer()
    const url = URL.createObjectURL(
      new Blob([bytes as ArrayBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download = (pk ? 'PK榜' : '目标进度') + '-' + data.period?.name + '.xlsx'
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[var(--foreground)]">
          {pk ? '经营指标 PK 榜' : dimensionTitle[dimension]}
        </h1>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link className="rounded-md border border-[var(--border)] bg-white px-3 py-2 text-[var(--foreground)] hover:border-[var(--primary)] hover:text-[var(--primary)]" href="/data-center/operating-targets">目标填报</Link>
          <Link
            className="rounded-md border border-[var(--border)] bg-white px-3 py-2 text-[var(--foreground)] hover:border-[var(--primary)] hover:text-[var(--primary)]"
            href={
              pk
                ? '/data-center/operating-progress'
              : '/data-center/operating-pk'
            }
          >
            {pk ? '目标进度' : 'PK 榜'}
          </Link>
          {data.canConfigure && (
            <Link className="rounded-md border border-[var(--border)] bg-white px-3 py-2 text-[var(--foreground)] hover:border-[var(--primary)] hover:text-[var(--primary)]" href="/settings/daily">周期与分班配置</Link>
          )}
        </div>
      </div>
      <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap gap-3">
        <select
          aria-label="经营月"
          className={field}
          value={filters.periodId || ''}
          disabled={busy}
          onChange={(e) =>
            void load({
              ...filters,
              periodId: e.target.value,
              weekId: undefined,
              classId: undefined,
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
          aria-label="区域"
          className={field}
          disabled={busy}
          value={filters.regionId || ''}
          onChange={(e) =>
            void load({
              ...filters,
              regionId: e.target.value,
              storeId: undefined,
              classId: undefined,
            })
          }
        >
          <option value="">全部授权区域</option>
          {data.regions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select
          aria-label="门店"
          className={field}
          disabled={busy || filters.dimension === 'market'}
          value={filters.storeId || ''}
          onChange={(e) => void load({ ...filters, storeId: e.target.value })}
        >
          <option value="">全部授权门店</option>
          {data.stores
            .filter(
              (s: any) => !filters.regionId || s.market_id === filters.regionId,
            )
            .map((s: any) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
        {pk ? (
          <select
            aria-label="班级"
            className={field}
            disabled={busy}
            value={filters.classId || ''}
            onChange={(e) => void load({ ...filters, classId: e.target.value })}
          >
            <option value="">全部班级</option>
            {data.classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          <div className={`${field} inline-flex items-center gap-2`} aria-label="统计对象">
            <span className="text-[var(--muted-foreground)]">统计对象</span>
            <span className="font-medium">{dimensionTitle[dimension]}</span>
          </div>
        )}
        <input
          aria-label="筛选员工或对象"
          placeholder="姓名、门店或岗位"
          className={field}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
        />
        <ExportButton
          disabled={busy || !rows.length}
          onExport={exportRows}
          label="导出当前结果"
        />
      </div>
      <div role="tablist" aria-label="成果周期" className="flex flex-wrap items-stretch gap-2 border-t border-[var(--border)] pt-3">
        {!pk && (
          <>
            <Button
              role="tab"
              aria-selected={view === 'week'}
              variant={view === 'week' ? 'default' : 'outline'}
              onClick={() => setView('week')}
            >
              <span className="text-left">周成果表<span className="block text-xs font-normal opacity-75">本周目标 · 每日达成</span></span>
            </Button>
            <Button
              role="tab"
              aria-selected={view === 'month'}
              variant={view === 'month' ? 'default' : 'outline'}
              onClick={() => setView('month')}
            >
              <span className="text-left">月成果表<span className="block text-xs font-normal opacity-75">本月目标 · 各周完成</span></span>
            </Button>
          </>
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2" role="group" aria-label="指标">
          <span className="mr-1 text-sm font-medium text-[var(--muted-foreground)]">指标</span>
          <select
            aria-label="指标"
            className="sr-only"
            value={metric}
            onChange={(e) => {
              const next = e.target.value as Metric | 'all'
              setMetric(next)
              if (next !== 'all') setLayout('block')
              setPage(1)
            }}
          >
            <option value="all">全指标</option>
            {keys.map((key) => <option key={key} value={key}>{labels[key]}</option>)}
          </select>
          {(['all', ...keys] as Array<Metric | 'all'>).map((key) => {
            const unit = key === 'all' ? `${keys.length} 项` : key === 'sales' || key === 'consumption' ? '元' : key === 'visits' ? '人次' : key === 'newCustomers' ? '人' : '次'
            return (
              <button
                key={key}
                type="button"
                aria-pressed={metric === key}
                onClick={() => {
                  setMetric(key)
                  if (key !== 'all') setLayout('block')
                  setPage(1)
                }}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${metric === key ? 'border-[var(--primary)] bg-[#FFF0EE] font-medium text-[var(--primary)]' : 'border-[var(--border)] bg-white text-[var(--foreground)] hover:border-[var(--primary)]'}`}
              >
                <span className="block">{key === 'all' ? '全指标' : labels[key]}</span>
                <span className="block text-xs opacity-70">{unit}</span>
              </button>
            )
          })}
        </div>
        {!pk && metric === 'all' && (
          <div className="flex items-center gap-1" role="group" aria-label="指标视图">
            <Button variant={layout === 'block' ? 'default' : 'outline'} onClick={() => setLayout('block')}>折叠块</Button>
            <Button variant={layout === 'matrix' ? 'default' : 'outline'} onClick={() => setLayout('matrix')}>对齐矩阵</Button>
          </div>
        )}
        {(view === 'week' || pk) && (
          <select
            aria-label="经营周"
            className={field}
            disabled={busy}
            value={data.week?.id || ''}
            onChange={(e) => void load({ ...filters, weekId: e.target.value })}
          >
            {data.period?.weeks.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} · {w.start}—{w.end}
              </option>
            ))}
          </select>
        )}
        {pk && (
          <Button variant="outline" onClick={() => setReverse(!reverse)}>
            {reverse ? '名次倒序' : '名次正序'}
          </Button>
        )}
      </div>
      </Card>
      <ReportInfoBar items={[
        { label: '经营月', value: data.period ? `${data.period.name}（${data.period.start} 至 ${data.period.end}）` : '尚未配置经营周期' },
        { label: '统计对象', value: `${rows.length} 个${busy ? ' · 正在更新…' : ''}` },
      ]} />
      {!pk && metric === 'all' && layout === 'matrix' ? (
        <div className="overflow-auto rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card)]">
          <table className="w-full min-w-[1100px] whitespace-nowrap text-sm">
            <thead className="bg-[#F8F9FB] text-[var(--muted-foreground)]">
              <tr>
                <th rowSpan={2} className="sticky left-0 z-20 border-b border-[var(--border)] bg-[#F8F9FB] px-3 py-3 text-left">名次</th>
                <th rowSpan={2} className="sticky left-16 z-20 min-w-36 border-b border-[var(--border)] bg-[#F8F9FB] px-3 py-3 text-left">姓名／对象</th>
                <th rowSpan={2} className="border-b border-[var(--border)] px-3 py-3 text-left">区域</th>
                <th rowSpan={2} className="border-b border-[var(--border)] px-3 py-3 text-left">门店</th>
                <th rowSpan={2} className="border-b border-[var(--border)] px-3 py-3 text-left">岗位</th>
                {keys.map((key) => <th key={key} colSpan={3} className="border-b border-[var(--border)] px-3 py-2 text-center">{labels[key]}</th>)}
                <th rowSpan={2} className="border-b border-[var(--border)] px-3 py-3 text-center">综合达标</th>
              </tr>
              <tr>
                {keys.flatMap((key) => ['目标', '完成', '完成率'].map((sub) => <th key={`${key}-${sub}`} className="border-b border-[var(--border)] px-3 py-2 text-right">{sub}</th>))}
              </tr>
            </thead>
            <tbody>
              {rows.slice((page - 1) * 20, page * 20).map((row) => {
                const achieved = keys.filter((key) => {
                  const goal = target(row, key)
                  return goal != null && goal > 0 && actual(row, key) >= goal
                }).length
                return (
                  <tr key={`${row.scope}:${row.scopeId}`} className="border-t border-[var(--border)] hover:bg-[#FAFAFA]">
                    <td className="sticky left-0 bg-white px-3 py-3">{row.rank}</td>
                    <td className="sticky left-16 bg-white px-3 py-3 font-medium">{row.name}</td>
                    <td className="px-3 py-3">{row.area || '未分配区域'}</td>
                    <td className="px-3 py-3">{row.storeName || '—'}</td>
                    <td className="px-3 py-3">{row.position || '—'}</td>
                    {keys.flatMap((key) => {
                      const goal = target(row, key)
                      const done = actual(row, key)
                      return [
                        <td key={`${key}-target`} className="px-3 py-3 text-right">{amount(goal, key)}</td>,
                        <td key={`${key}-done`} className="px-3 py-3 text-right">{amount(done, key)}</td>,
                        <td key={`${key}-rate`} className="px-3 py-3 text-right">{rate(done, goal)}</td>,
                      ]
                    })}
                    <td className="px-3 py-3 text-center font-medium">{achieved}/{keys.length}</td>
                  </tr>
                )
              })}
              {!rows.length && <tr><td colSpan={21} className="p-8 text-center text-[var(--muted-foreground)]">暂无授权范围内的数据</td></tr>}
            </tbody>
            {rows.length > 0 && <tfoot className="bg-[#F8F9FB] font-medium"><tr>
              <td colSpan={5} className="px-3 py-3">合计（各指标独立小计）</td>
              {keys.flatMap((key) => {
                const goal = rows.reduce((sum, row) => sum + (target(row, key) || 0), 0)
                const done = rows.reduce((sum, row) => sum + actual(row, key), 0)
                return [
                  <td key={`${key}-sum-target`} className="px-3 py-3 text-right">{amount(goal, key)}</td>,
                  <td key={`${key}-sum-done`} className="px-3 py-3 text-right">{amount(done, key)}</td>,
                  <td key={`${key}-sum-rate`} className="px-3 py-3 text-right">{rate(done, goal)}</td>,
                ]
              })}
              <td className="px-3 py-3 text-center">—</td>
            </tr></tfoot>}
          </table>
        </div>
      ) : !pk && metric === 'all' ? (
        <div className="space-y-3">
          {keys.map((key) => {
            const goalTotal = rows.reduce((sum, row) => sum + (target(row, key) || 0), 0)
            const doneTotal = rows.reduce((sum, row) => sum + actual(row, key), 0)
            return (
              <details key={key} open={key === keys[0]} className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card)]">
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 bg-[#F8F9FB] px-4 py-3 text-sm marker:hidden">
                  <span className="font-semibold">{labels[key]} <span className="font-normal text-[var(--muted-foreground)]">{key === 'sales' || key === 'consumption' ? '元' : key === 'visits' ? '人次' : key === 'newCustomers' ? '人' : '次'}</span></span>
                  <span className="text-[var(--muted-foreground)]">汇总：目标 {amount(goalTotal, key)} / 完成 {amount(doneTotal, key)}</span>
                  <span className="ml-auto font-semibold">{rate(doneTotal, goalTotal)}</span>
                </summary>
                <div className="overflow-auto">
                  <table className="w-full min-w-[900px] whitespace-nowrap text-sm">
                    <thead className="text-[var(--muted-foreground)]"><tr>{['名次', '姓名／对象', '区域', '门店', '岗位', '目标', '实际完成', '完成率', '状态'].map((col) => <th key={col} className="border-b border-[var(--border)] px-3 py-3 text-left font-medium">{col}</th>)}</tr></thead>
                    <tbody>
                      {rows.slice((page - 1) * 20, page * 20).map((row) => {
                        const goal = target(row, key)
                        const done = actual(row, key)
                        return <tr key={`${row.scope}:${row.scopeId}:${key}`} className="border-t border-[var(--border)] hover:bg-[#FAFAFA]">
                          <td className="px-3 py-3">{row.rank}</td><td className="px-3 py-3 font-medium">{row.name}</td><td className="px-3 py-3">{row.area || '未分配区域'}</td><td className="px-3 py-3">{row.storeName || '—'}</td><td className="px-3 py-3">{row.position || '—'}</td><td className="px-3 py-3 text-right">{amount(goal, key)}</td><td className="px-3 py-3 text-right">{amount(done, key)}</td><td className="px-3 py-3 text-right">{rate(done, goal)}</td><td className="px-3 py-3">{goal == null ? '未设置' : goal === 0 ? '不计算完成率' : done >= goal ? '已达成' : '未达成'}</td>
                        </tr>
                      })}
                      {!rows.length && <tr><td colSpan={9} className="p-8 text-center text-[var(--muted-foreground)]">暂无授权范围内的数据</td></tr>}
                    </tbody>
                  </table>
                </div>
              </details>
            )
          })}
        </div>
      ) : (
      <div className="overflow-auto rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card)]">
        <table className="w-full whitespace-nowrap text-sm">
          <thead className="bg-[#F8F9FB] text-[var(--muted-foreground)]">
            <tr>
              {[
                '名次',
                '姓名／对象',
                '区域',
                '门店',
                '岗位',
                '统计范围',
                ...(pk ? ['军团', '指导员'] : []),
                '指标',
                ...(pk
                  ? [
                      '本周目标',
                      '本周完成',
                      '本周完成率',
                      '本月目标',
                      '本月完成',
                      '本月完成率',
                    ]
                  : [
                      '目标',
                      '实际完成',
                      '完成率',
                      '状态',
                      ...columns.map((c) =>
                        view === 'week'
                          ? c.slice(5)
                          : data.period?.weeks.find((w) => w.id === c)?.name ||
                            c,
                      ),
                    ]),
              ].map((c, i) => (
                <th
                  key={i}
                  className={`border-b border-[var(--border)] px-3 py-3 text-left font-medium ${i < 2 ? 'sticky bg-[#F8F9FB] ' + (i === 0 ? 'left-0 w-16' : 'left-16 min-w-36') : ''}`}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice((page - 1) * 20, page * 20).flatMap((row) =>
              selected.map((key) => {
                const v = row.values[key],
                  t = target(row, key),
                  done = actual(row, key)
                return (
                  <tr
                    key={`${row.scope}:${row.scopeId}:${row.employeeId}:${key}`}
                    className="border-t border-[var(--border)] transition-colors hover:bg-[#FAFAFA]"
                  >
                    <td className="sticky left-0 bg-white px-3 py-3">{row.rank}</td>
                    <td className="sticky left-16 bg-white px-3 py-3 font-medium">{row.name}</td>
                    <td className="px-3 py-3">{row.area || '未分配区域'}</td>
                    <td className="px-3 py-3">{row.storeName || '—'}</td>
                    <td className="px-3 py-3">{row.position || '—'}</td>
                    <td className="px-3 py-3">{row.scopeName}</td>
                    {pk && (
                      <>
                        <td className="px-3 py-3">{row.legion || '—'}</td>
                        <td className="px-3 py-3">{row.mentor || '—'}</td>
                      </>
                    )}
                    <td className="px-3 py-3">{labels[key]}</td>
                    {pk ? (
                      <>
                        {[
                          amount(v.weekTarget, key),
                          amount(v.weekDone, key),
                          rate(v.weekDone, v.weekTarget),
                          amount(v.monthTarget, key),
                          amount(v.monthDone, key),
                          rate(v.monthDone, v.monthTarget),
                        ].map((x, i) => (
                          <td key={i} className="px-3 py-3 text-right">
                            {x}
                          </td>
                        ))}
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-3 text-right">{amount(t, key)}</td>
                        <td className="px-3 py-3 text-right">{amount(done, key)}</td>
                        <td className="px-3 py-3 text-right">{rate(done, t)}</td>
                        <td
                          className={`px-3 py-3 ${t == null ? 'text-gray-500' : t > 0 && done >= t ? 'text-green-700' : 'text-amber-700'}`}
                        >
                          {t == null
                            ? '未设置'
                            : t === 0
                              ? '不计算完成率'
                              : done >= t
                                ? '已达成'
                                : '未达成'}
                        </td>
                        {columns.map((c) => (
                          <td key={c} className="px-3 py-3 text-right">
                            {amount(breakdown(row, key, c), key)}
                          </td>
                        ))}
                      </>
                    )}
                  </tr>
                )
              }),
            )}
            {!rows.length && (
              <tr>
                <td colSpan={20} className="p-8 text-center text-[var(--muted-foreground)]">
                  暂无授权范围内的数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      )}
      <Pagination
        total={rows.length}
        page={page}
        pageSize={20}
        onPageChange={setPage}
      />
    </div>
  )
}
