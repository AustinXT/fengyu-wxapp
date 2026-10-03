'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Pagination } from '@/components/ui/pagination'
import { ExportButton } from '@/components/ui/export-button'
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
export function OperatingView({
  initial,
  pk = false,
}: {
  initial: Data
  pk?: boolean
}) {
  const [data, setData] = useState(initial),
    [filters, setFilters] = useState<Filters>({
      ...initial.filters,
      periodId: initial.period?.id,
      dimension: 'personal',
    }),
    [metric, setMetric] = useState<Metric | 'all'>('sales'),
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
      setData(await (pk ? getOperatingPk(next) : getOperatingProgress(next)))
      setFilters(next)
      setPage(1)
    } catch (e) {
      toast.error(actionErrorMessage(e, '读取失败'))
    } finally {
      setBusy(false)
    }
  }
  const field = 'h-10 rounded-md border border-[var(--border)] bg-white px-3 text-sm'
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
    <main className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          {pk ? '经营指标 PK 榜' : '经营目标进度'}
        </h1>
        <div className="flex gap-4 text-sm text-[#C0322A]">
          <Link href="/data-center/operating-targets">目标填报</Link>
          <Link
            href={
              pk
                ? '/data-center/operating-progress'
                : '/data-center/operating-pk'
            }
          >
            {pk ? '目标进度' : 'PK 榜'}
          </Link>
          {data.canConfigure && (
            <Link href="/settings/daily">周期与分班配置</Link>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-3 rounded-xl border border-[var(--border)] bg-white p-4">
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
          <select
            aria-label="统计对象"
            className={field}
            disabled={busy}
            value={filters.dimension}
            onChange={(e) =>
              void load({
                ...filters,
                dimension: e.target.value as Filters['dimension'],
                storeId: undefined,
              })
            }
          >
            <option value="personal">员工目标进度</option>
            <option value="store">门店目标进度</option>
            <option value="market">区域目标进度</option>
          </select>
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
      <div className="flex flex-wrap items-center gap-3">
        {!pk && (
          <>
            <Button
              variant={view === 'week' ? 'default' : 'outline'}
              onClick={() => setView('week')}
            >
              周成果表
            </Button>
            <Button
              variant={view === 'month' ? 'default' : 'outline'}
              onClick={() => setView('month')}
            >
              月成果表
            </Button>
          </>
        )}
        <select
          className={field}
          aria-label="指标"
          value={metric}
          onChange={(e) => {
            setMetric(e.target.value as Metric | 'all')
            setPage(1)
          }}
        >
          {keys.map((k) => (
            <option key={k} value={k}>
              {labels[k]}（
              {k === 'sales' || k === 'consumption'
                ? '元'
                : k === 'visits'
                  ? '人次'
                  : k === 'newCustomers'
                    ? '人'
                    : '次'}
              ）
            </option>
          ))}
          <option value="all">全指标</option>
        </select>
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
      <div className="text-sm text-gray-500">
        {data.period
          ? `${data.period.name} · ${data.period.start} 至 ${data.period.end}`
          : '尚未配置经营周期'}{' '}
        · 共 {rows.length} 个对象{busy ? ' · 正在更新…' : ''}
      </div>
      <div className="overflow-auto rounded-xl border border-[var(--border)] bg-white">
        <table className="w-full whitespace-nowrap text-sm">
          <thead className="bg-gray-50">
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
                  className={`p-3 text-left ${i < 2 ? 'sticky bg-gray-50 ' + (i === 0 ? 'left-0 w-16' : 'left-16 min-w-36') : ''}`}
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
                    className="border-t border-[var(--border)]"
                  >
                    <td className="sticky left-0 bg-white p-3">{row.rank}</td>
                    <td className="sticky left-16 bg-white p-3">{row.name}</td>
                    <td className="p-3">{row.area || '未分配区域'}</td>
                    <td className="p-3">{row.storeName || '—'}</td>
                    <td className="p-3">{row.position || '—'}</td>
                    <td className="p-3">{row.scopeName}</td>
                    {pk && (
                      <>
                        <td className="p-3">{row.legion || '—'}</td>
                        <td className="p-3">{row.mentor || '—'}</td>
                      </>
                    )}
                    <td className="p-3">{labels[key]}</td>
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
                          <td key={i} className="p-3 text-right">
                            {x}
                          </td>
                        ))}
                      </>
                    ) : (
                      <>
                        <td className="p-3 text-right">{amount(t, key)}</td>
                        <td className="p-3 text-right">{amount(done, key)}</td>
                        <td className="p-3 text-right">{rate(done, t)}</td>
                        <td
                          className={`p-3 ${t == null ? 'text-gray-500' : t > 0 && done >= t ? 'text-green-700' : 'text-amber-700'}`}
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
                          <td key={c} className="p-3 text-right">
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
                <td colSpan={20} className="p-8 text-center text-gray-500">
                  暂无授权范围内的数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        total={rows.length}
        page={page}
        pageSize={20}
        onPageChange={setPage}
      />
    </main>
  )
}
