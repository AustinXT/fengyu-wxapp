import { callApi, showError, today, Employee } from '../../utils/cloud'
import { login } from '../../utils/workspace'
interface Period {
  id: string
  name: string
  start: string
  end: string
  version: number
  weeks: { id: string; name: string; start: string; end: string }[]
}
interface Target {
  visits: number | null
  newCustomers: number | null
  projects: number | null
  counts_month_confirmed: boolean
  sales: number
  consumption: number
  penalty: string
  month_confirmed: boolean
  version: number
  weeks: Record<
    string,
    {
      sales: number | null
      consumption: number | null
      visits?: number | null
      newCustomers?: number | null
      projects?: number | null
    }
  >
}
interface Result {
  periods: Period[]
  reference?: {
    period: { start: string; end: string }
    month: { sales: number; consumption: number }
    week: {
      start: string
      end: string
      sales: number
      consumption: number
    } | null
  } | null
  period: Period | null
  week: Period['weeks'][number] | null
  target: Target | null
}
const amount = (value: number | null | undefined) =>
  value == null ? '未设置' : (value / 100).toFixed(2)
const parseAmount = (raw: string): number | null => {
  if (!/^\d+(\.\d{1,2})?$/.test(raw.trim())) return null
  const [whole, fraction = ''] = raw.trim().split('.')
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(value) ? value : null
}
Page({
  data: {
    scope: 'personal',
    scopeId: '',
    title: '我的经营目标',
    user: null as Employee | null,
    periods: [] as Period[],
    periodIndex: 0,
    scopes: [] as { id: string; name: string }[],
    scopeIndex: 0,
    period: null as Period | null,
    week: null as Result['week'],
    target: null as Target | null,
    weeks: [] as {
      id: string
      name: string
      dates: string
      current: boolean
      automatic: boolean
      metrics: { label: string; value: string }[]
    }[],
    sales: '',
    consumption: '',
    penalty: '',
    weekSales: '',
    weekConsumption: '',
    monthSales: '',
    monthConsumption: '',
    monthReference: '',
    weekReference: '',
    weekSalesPercent: '—',
    weekConsumptionPercent: '—',
    confirmed: false,
    editable: false,
    automatic: false,
    visits: '',
    newCustomers: '',
    projects: '',
    weekVisits: '',
    weekNewCustomers: '',
    weekProjects: '',
    countsConfirmed: false,
    countFields: [] as {
      key: string
      weekKey: string
      label: string
      unit: string
      month: string
      week: string
      weekPercent: string
    }[],
    monthError: '',
    weekError: '',
    loading: false,
    saving: false,
    ready: false,
  },
  onLoad(options: Record<string, string | undefined>) {
    this.setData({
      scope: ['personal', 'store', 'market'].includes(options.scope || '')
        ? options.scope!
        : 'personal',
      scopeId: options.scopeId || '',
    })
    void this.initialize()
  },
  async initialize() {
    this.setData({ loading: true })
    try {
      const { user } = await login()
      if (!user) throw Error('请先绑定员工身份')
      if (this.data.scope === 'personal' && user.managerStores.length > 0)
        throw Error('店长无需设置个人经营目标，请在店长工作台设置本店目标')
      let scopes = [{ id: user.employeeId, name: user.name }]
      if (this.data.scope === 'store')
        scopes = user.managerStores.map((s) => ({
          id: s.store_id,
          name: s.store_name,
        }))
      if (this.data.scope === 'market') {
        scopes = user.roleBindings
          .filter((r) => r.scopeType === '市场' && r.scopeId)
          .map((r) => ({ id: r.scopeId!, name: r.scopeName }))
      }
      const scopeIndex = Math.max(
        0,
        scopes.findIndex((s) => s.id === this.data.scopeId),
      )
      this.setData({
        user,
        scopes,
        scopeIndex,
        scopeId: scopes[scopeIndex]?.id || '',
        title:
          this.data.scope === 'store'
            ? '本店经营目标'
            : this.data.scope === 'market'
              ? '区域经营目标'
              : '我的经营目标',
      })
      if (!scopes.length) throw Error('没有可设置目标的授权范围')
      await this.load()
    } catch (e) {
      showError(e)
    } finally {
      this.setData({ loading: false })
    }
  },
  async load() {
    this.setData({ ready: false })
    const result = await callApi<Result>('target.read', {
      scope: this.data.scope,
      scopeId: this.data.scopeId,
      periodId: this.data.periods[this.data.periodIndex]?.id,
    })
    const { target, period, week, reference } = result
    const periods = result.periods || []
    const automatic = !!week && period?.weeks[3].id === week.id
    this.setData({
      monthReference: reference
        ? `${reference.period.start} 至 ${reference.period.end} · 业绩 ${amount(reference.month.sales)} / 消耗 ${amount(reference.month.consumption)} 元`
        : '暂无已配置的去年对应经营月',
      weekReference: reference?.week
        ? `${reference.week.start} 至 ${reference.week.end} · 业绩 ${amount(reference.week.sales)} / 消耗 ${amount(reference.week.consumption)} 元`
        : '暂无去年对应经营周数据',
      period,
      periods,
      periodIndex: Math.max(0, periods.findIndex((p) => p.id === period?.id)),
      week,
      target,
      automatic,
      confirmed: !!target?.month_confirmed,
      countsConfirmed: !!target?.counts_month_confirmed,
      visits: target?.visits == null ? '' : String(target.visits),
      newCustomers:
        target?.newCustomers == null ? '' : String(target.newCustomers),
      projects: target?.projects == null ? '' : String(target.projects),
      weekVisits:
        week && target?.weeks[week.id]?.visits != null
          ? String(target.weeks[week.id].visits)
          : '',
      weekNewCustomers:
        week && target?.weeks[week.id]?.newCustomers != null
          ? String(target.weeks[week.id].newCustomers)
          : '',
      weekProjects:
        week && target?.weeks[week.id]?.projects != null
          ? String(target.weeks[week.id].projects)
          : '',
      editable: !!period && period.start <= today() && today() <= period.end,
      sales: target ? amount(target.sales) : '',
      consumption: target ? amount(target.consumption) : '',
      penalty: target?.penalty || '',
      monthSales: amount(target?.sales),
      monthConsumption: amount(target?.consumption),
      weekSales:
        week && target?.weeks[week.id]?.sales != null
          ? amount(target.weeks[week.id].sales)
          : '',
      weekConsumption:
        week && target?.weeks[week.id]?.consumption != null
          ? amount(target.weeks[week.id].consumption)
          : '',
      weeks: (period?.weeks || []).map((w, i) => {
        const values = target?.weeks[w.id]
        const weeklyValue = (value: number | null | undefined) =>
          i === 3 && value == null ? '待计算' : amount(value)
        return {
          id: w.id,
          name: w.name,
          dates: `${w.start} 至 ${w.end}`,
          current: w.id === week?.id,
          automatic: i === 3,
          metrics: [
            { label: '业绩', value: weeklyValue(values?.sales) },
            { label: '消耗', value: weeklyValue(values?.consumption) },
            { label: '客量', value: String(values?.visits ?? '未设置') },
            { label: '新客', value: String(values?.newCustomers ?? '未设置') },
            { label: '项目数', value: String(values?.projects ?? '未设置') },
          ],
        }
      }),
      ready: true,
    })
    this.percent()
  },
  input(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const field = e.currentTarget.dataset.field
    if (
      !this.data.saving &&
      [
        'sales',
        'consumption',
        'penalty',
        'weekSales',
        'weekConsumption',
        'visits',
        'newCustomers',
        'projects',
        'weekVisits',
        'weekNewCustomers',
        'weekProjects',
      ].includes(field)
    ) {
      this.setData({ [field]: e.detail.value })
      this.percent()
    }
  },
  percent() {
    const sales = Number(this.data.weekSales),
      consumption = Number(this.data.weekConsumption)
    let monthError = '',
      weekError = ''
    const monthSales = parseAmount(this.data.sales),
      monthConsumption = parseAmount(this.data.consumption)
    if (
      monthSales === null ||
      monthConsumption === null ||
      monthSales <= 0 ||
      monthConsumption <= 0
    )
      monthError = '请填写大于0的月度业绩与消耗目标，最多两位小数。'
    else if (this.data.scope === 'personal' && !this.data.penalty.trim())
      monthError = '请填写本月负激励。'
    if (!this.data.confirmed) weekError = '请先确认本月目标。'
    else if (!this.data.week) weekError = '当前经营月没有可设置的经营周。'
    else if (this.data.automatic) weekError = '第4周由剩余目标自动生成。'
    else {
      for (const metric of ['sales', 'consumption'] as const) {
        const raw =
          metric === 'sales' ? this.data.weekSales : this.data.weekConsumption
        const value = parseAmount(raw)
        if (value === null) {
          weekError = '请填写非负的本周业绩与消耗目标，最多两位小数。'
          break
        }
        const used = (this.data.period?.weeks.slice(0, 3) || []).reduce(
          (sum, week) =>
            sum +
            (week.id === this.data.week?.id
              ? value
              : (this.data.target?.weeks[week.id]?.[metric] ?? 0)),
          0,
        )
        if (
          !Number.isSafeInteger(used) ||
          used > (this.data.target?.[metric] ?? 0)
        ) {
          weekError = `${metric === 'sales' ? '业绩' : '消耗'}前三周目标累计不能超过月目标。`
          break
        }
      }
    }
    const countFields = [
      {
        key: 'visits',
        weekKey: 'weekVisits',
        label: '客量',
        unit: '人次',
        month: this.data.visits,
        week: this.data.weekVisits,
        weekPercent:
          this.data.weekVisits !== '' && Number(this.data.visits) > 0
            ? ((Number(this.data.weekVisits) * 100) / Number(this.data.visits)).toFixed(1) + '%'
            : '—',
      },
      {
        key: 'newCustomers',
        weekKey: 'weekNewCustomers',
        label: '新客',
        unit: '人',
        month: this.data.newCustomers,
        week: this.data.weekNewCustomers,
        weekPercent:
          this.data.weekNewCustomers !== '' && Number(this.data.newCustomers) > 0
            ? ((Number(this.data.weekNewCustomers) * 100) / Number(this.data.newCustomers)).toFixed(1) + '%'
            : '—',
      },
      {
        key: 'projects',
        weekKey: 'weekProjects',
        label: '项目数',
        unit: '次',
        month: this.data.projects,
        week: this.data.weekProjects,
        weekPercent:
          this.data.weekProjects !== '' && Number(this.data.projects) > 0
            ? ((Number(this.data.weekProjects) * 100) / Number(this.data.projects)).toFixed(1) + '%'
            : '—',
      },
    ]
    for (const field of countFields) {
      const valid = (raw: string) =>
        /^\d+$/.test(raw.trim()) && Number(raw) <= 2147483647
      if (!valid(field.month))
        monthError = '请填写客量、新客、项目数月目标（非负整数）。'
      if (this.data.confirmed && !this.data.countsConfirmed)
        weekError = '请先补充确认三项月目标。'
      if (
        this.data.confirmed &&
        this.data.countsConfirmed &&
        !this.data.automatic &&
        this.data.week
      ) {
        if (!valid(field.week)) {
          weekError = '请填写完整的五项本周目标，计数须为非负整数。'
          continue
        }
        const metric = field.key as 'visits' | 'newCustomers' | 'projects'
        const used = (this.data.period?.weeks.slice(0, 3) || []).reduce(
          (sum, w) =>
            sum +
            (w.id === this.data.week?.id
              ? Number(field.week)
              : (this.data.target?.weeks[w.id]?.[metric] ?? 0)),
          0,
        )
        if (used > Number(field.month))
          weekError = `${field.label}前三周合计不能超过月目标。`
      }
    }
    this.setData({
      countFields,
      monthError,
      weekError,
      weekSalesPercent:
        this.data.weekSales !== '' &&
        this.data.target &&
        this.data.target.sales > 0 &&
        Number.isFinite(sales)
          ? ((sales * 10000) / this.data.target.sales).toFixed(1) + '%'
          : '—',
      weekConsumptionPercent:
        this.data.weekConsumption !== '' &&
        this.data.target &&
        this.data.target.consumption > 0 &&
        Number.isFinite(consumption)
          ? ((consumption * 10000) / this.data.target.consumption).toFixed(1) +
            '%'
          : '—',
    })
  },
  async selection(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.saving || this.data.loading) return
    const index = Number(e.detail.value)
    if (e.currentTarget.dataset.kind === 'scope')
      this.setData({ scopeIndex: index, scopeId: this.data.scopes[index].id })
    else this.setData({ periodIndex: index })
    this.setData({ loading: true })
    try {
      await this.load()
    } catch (err) {
      showError(err)
    } finally {
      this.setData({ loading: false })
    }
  },
  async save(e: WechatMiniprogram.CustomEvent) {
    if (
      !this.data.ready ||
      !this.data.editable ||
      this.data.saving ||
      !this.data.period
    )
      return
    const month = e.currentTarget.dataset.kind === 'month'
    this.percent()
    const error = month ? this.data.monthError : this.data.weekError
    if (error) {
      wx.showToast({ title: error, icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      if (month) {
        const result = await wx.showModal({
          title: '确认本月目标',
          content: '确认后本月五项目标及负激励不可修改。是否确认？',
        })
        if (!result.confirm) return
      }
      await callApi(month ? 'target.confirmMonth' : 'target.saveWeek', {
        scope: this.data.scope,
        scopeId: this.data.scopeId,
        periodId: this.data.period.id,
        periodVersion: this.data.period.version,
        version: this.data.target?.version || 0,
        sales: month ? this.data.sales : this.data.weekSales,
        consumption: month ? this.data.consumption : this.data.weekConsumption,
        penalty: this.data.penalty,
        visits: month ? this.data.visits : this.data.weekVisits,
        newCustomers: month
          ? this.data.newCustomers
          : this.data.weekNewCustomers,
        projects: month ? this.data.projects : this.data.weekProjects,
      })
      await this.load()
      wx.showToast({
        title: month ? '本月目标已确认' : '本周目标已保存',
        icon: 'success',
      })
    } catch (err) {
      showError(err)
    } finally {
      this.setData({ saving: false })
    }
  },
})
