import { callApi, showError, today, Employee, Management } from '../../utils/cloud';
import { login } from '../../utils/workspace';
interface Period { id: string; name: string; start: string; end: string; version: number;
  weeks: { id: string; name: string; start: string; end: string }[] }
interface Target { sales: number; consumption: number; penalty: string; month_confirmed: boolean; version: number;
  weeks: Record<string, { sales: number | null; consumption: number | null }> }
interface Result { reference?: { period: { start: string; end: string }; month: { sales: number; consumption: number }; week: { start: string; end: string; sales: number; consumption: number } | null } | null; period: Period | null; week: Period['weeks'][number] | null; target: Target | null }
const amount = (value: number | null | undefined) => value == null ? '未设置' : (value / 100).toFixed(2);
Page({
  data: { scope: 'personal', scopeId: '', title: '我的经营目标', user: null as Employee | null,
    periods: [] as Period[], periodIndex: 0, scopes: [] as { id: string; name: string }[], scopeIndex: 0,
    period: null as Period | null, week: null as Result['week'], target: null as Target | null,
    weeks: [] as { id: string; name: string; dates: string; current: boolean; automatic: boolean; sales: string; consumption: string }[],
    sales: '', consumption: '', penalty: '', weekSales: '', weekConsumption: '',
    monthSales: '', monthConsumption: '', monthReference: '', weekReference: '', weekSalesPercent: '—', weekConsumptionPercent: '—', confirmed: false, editable: false, automatic: false,
    loading: false, saving: false, ready: false },
  onLoad(options: Record<string, string | undefined>) {
    this.setData({ scope: ['personal', 'store', 'market'].includes(options.scope || '') ? options.scope! : 'personal', scopeId: options.scopeId || '' });
    void this.initialize();
  },
  async initialize() {
    this.setData({ loading: true });
    try {
      const { user } = await login();
      if (!user) throw Error('请先绑定员工身份');
      const { periods, period } = await callApi<{ periods: Period[]; period: Period | null }>('period.list');
      let scopes = [{ id: user.employeeId, name: user.name }];
      if (this.data.scope === 'store') scopes = user.managerStores.map((s) => ({ id: s.store_id, name: s.store_name }));
      if (this.data.scope === 'market') {
        const management = await callApi<Management>('management.read', { date: today() });
        scopes = management.nodes.filter((n) => n.type === '市场').map((n) => ({ id: n.id, name: n.name }));
      }
      const scopeIndex = Math.max(0, scopes.findIndex((s) => s.id === this.data.scopeId));
      this.setData({ user, periods, scopes, scopeIndex, scopeId: scopes[scopeIndex]?.id || '',
        periodIndex: Math.max(0, periods.findIndex((p) => p.id === period?.id)),
        title: this.data.scope === 'store' ? '本店经营目标' : this.data.scope === 'market' ? '区域经营目标' : '我的经营目标' });
      if (!scopes.length) throw Error('没有可设置目标的授权范围');
      await this.load();
    } catch (e) { showError(e); } finally { this.setData({ loading: false }); }
  },
  async load() {
    this.setData({ ready: false });
    const result = await callApi<Result>('target.read', { scope: this.data.scope, scopeId: this.data.scopeId,
      periodId: this.data.periods[this.data.periodIndex]?.id });
    const { target, period, week, reference } = result;
    const automatic = !!week && period?.weeks[3].id === week.id;
    this.setData({ monthReference: reference ? `${reference.period.start} 至 ${reference.period.end} · 业绩 ${amount(reference.month.sales)} / 消耗 ${amount(reference.month.consumption)} 元` : '暂无已配置的去年对应经营月',
      weekReference: reference?.week ? `${reference.week.start} 至 ${reference.week.end} · 业绩 ${amount(reference.week.sales)} / 消耗 ${amount(reference.week.consumption)} 元` : '暂无去年对应经营周数据',
      period, week, target, automatic, confirmed: !!target?.month_confirmed,
      editable: !!period && period.start <= today() && today() <= period.end,
      sales: target ? amount(target.sales) : '', consumption: target ? amount(target.consumption) : '', penalty: target?.penalty || '',
      monthSales: amount(target?.sales), monthConsumption: amount(target?.consumption),
      weekSales: week && target?.weeks[week.id]?.sales != null ? amount(target.weeks[week.id].sales) : '',
      weekConsumption: week && target?.weeks[week.id]?.consumption != null ? amount(target.weeks[week.id].consumption) : '',
      weeks: (period?.weeks || []).map((w, i) => ({ id: w.id, name: w.name, dates: `${w.start} 至 ${w.end}`,
        current: w.id === week?.id, automatic: i === 3, sales: amount(target?.weeks[w.id]?.sales), consumption: amount(target?.weeks[w.id]?.consumption) })), ready: true });
    this.percent();
  },
  input(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const field = e.currentTarget.dataset.field;
    if (!this.data.saving && ['sales', 'consumption', 'penalty', 'weekSales', 'weekConsumption'].includes(field)) { this.setData({ [field]: e.detail.value }); this.percent(); }
  },
  percent() {
    const sales = Number(this.data.weekSales), consumption = Number(this.data.weekConsumption);
    this.setData({ weekSalesPercent: this.data.weekSales !== '' && this.data.target && Number.isFinite(sales) ? (sales * 10000 / this.data.target.sales).toFixed(1) + '%' : '—',
      weekConsumptionPercent: this.data.weekConsumption !== '' && this.data.target && Number.isFinite(consumption) ? (consumption * 10000 / this.data.target.consumption).toFixed(1) + '%' : '—' });
  },
  async selection(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.saving || this.data.loading) return;
    const index = Number(e.detail.value);
    if (e.currentTarget.dataset.kind === 'scope') this.setData({ scopeIndex: index, scopeId: this.data.scopes[index].id });
    else this.setData({ periodIndex: index });
    this.setData({ loading: true });
    try { await this.load(); } catch (err) { showError(err); } finally { this.setData({ loading: false }); }
  },
  async save(e: WechatMiniprogram.CustomEvent) {
    if (!this.data.ready || !this.data.editable || this.data.saving || !this.data.period) return;
    const month = e.currentTarget.dataset.kind === 'month';
    this.setData({ saving: true });
    try {
      if (month) {
        const result = await wx.showModal({ title: '确认本月目标', content: '确认后本月业绩、消耗目标及负激励不可修改。是否确认？' });
        if (!result.confirm) return;
      }
      await callApi(month ? 'target.confirmMonth' : 'target.saveWeek', { scope: this.data.scope, scopeId: this.data.scopeId,
        periodId: this.data.period.id, periodVersion: this.data.period.version, version: this.data.target?.version || 0,
        sales: month ? this.data.sales : this.data.weekSales, consumption: month ? this.data.consumption : this.data.weekConsumption, penalty: this.data.penalty });
      await this.load();
      wx.showToast({ title: month ? '本月目标已确认' : '本周目标已保存', icon: 'success' });
    } catch (err) { showError(err); } finally { this.setData({ saving: false }); }
  },
});
