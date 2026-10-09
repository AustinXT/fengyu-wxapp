import { expireLogin, sessionContext } from '../../utils/session';
import { callApi, showError, today } from '../../utils/cloud';
interface Period { id: string; name: string; start: string; end: string }
interface Values { weekTarget: number | null; weekDone: number; monthTarget: number | null; monthDone: number }
type Metric = 'sales' | 'consumption';
interface Row { periodStart: string; periodEnd: string; weekStart: string; weekEnd: string; employeeId: string; name: string; area: string; storeName: string; legion: string; group: string; mentor: string; rank: number; rankByMetric?: { sales: number; consumption: number }; sales: Values; consumption: Values; visits: Values; newCustomers: Values; projects: Values }
const formatValue = (metric: Metric, n: number | null) => n === null ? '未设置' : metric === 'sales' || metric === 'consumption' ? (n / 100).toFixed(2) : String(n);
const rate = (done: number, target: number | null) => target && target > 0 ? (done / target * 100).toFixed(1) + '%' : '—';
Page({
  _context: '',
  _loadId: 0,
  data: { loading: false, ready: false, periods: [] as Period[], periodIndex: 0,
    classes: [] as { id: string; name: string; members: number; stores: number }[], classIndex: 0,
    sortDescending: false, legionOptions: ['不限'] as string[], areaOptions: ['不限'] as string[], legionIndex: 0, areaIndex: 0, allRows: [] as Row[], selectedClass: false, status: '', metric: 'sales' as Metric, weekName: '', scopeLabel: '', rows: [] as (Row & { weekTargetText: string; weekDoneText: string; monthTargetText: string; monthDoneText: string; weekRate: string; monthRate: string })[] },
  onShow() { void this.load(); },
  async onPullDownRefresh() {
    expireLogin();
    try { await this.load(true); }
    finally { wx.stopPullDownRefresh(); }
  },
  async load(refreshCatalog = true) {
    const context = sessionContext();
    if (this.data.loading && this._context === context) return;
    const loadId = ++this._loadId;
    if (this._context !== context) this.setData({ periods: [], classes: [], allRows: [], rows: [],
      selectedClass: false, classIndex: 0, periodIndex: 0, ready: false });
    this._context = context;
    this.setData({ loading: true });
    try {
      if (refreshCatalog || !this.data.periods.length) {
        const periodId = this.data.periods[this.data.periodIndex]?.id;
        const data = await callApi<{ periods: Period[]; period: Period | null;
          classes: { id: string; name: string; members: number; stores: number }[]; scopeLabel: string }>('pk.classes', { periodId });
        if (context !== sessionContext() || loadId !== this._loadId) return;
        const previousId = this.data.classes[this.data.classIndex]?.id;
        this.setData({ periods: data.periods,
          periodIndex: Math.max(0, data.periods.findIndex(p => p.id === data.period?.id)),
          classes: data.classes,
          classIndex: Math.max(0, data.classes.findIndex(c => c.id === previousId)),
          scopeLabel: data.scopeLabel });
      }
      const period = this.data.periods[this.data.periodIndex];
      if (!period) { this.setData({ classes: [], rows: [], allRows: [], ready: true }); return; }
      this.setData({ status: today() < period.start ? '未开始' : today() > period.end ? '已结束' : '进行中' });
      if (this.data.classes.length && this.data.selectedClass) {
        const board = await callApi<{ rows: Row[]; week: { name: string }; scopeLabel: string }>('pk.read',
          { periodId: period.id, classId: this.data.classes[this.data.classIndex].id, metric: this.data.metric, date: today() });
        if (context !== sessionContext() || loadId !== this._loadId) return;
        this.setData({ weekName: board.week.name, scopeLabel: board.scopeLabel, allRows: board.rows,
          legionOptions: ['不限', ...new Set(board.rows.map(r => r.legion).filter(Boolean))],
          areaOptions: ['不限', ...new Set(board.rows.map(r => r.area).filter(Boolean))] });
        this.applyFilters();
      } else this.setData({ rows: [], allRows: [] });
      this.setData({ ready: true });
    } catch (e) {
      if (loadId === this._loadId) this.setData({ ready: false, rows: [], allRows: [] });
      showError(e);
    } finally { if (loadId === this._loadId) this.setData({ loading: false }); }
  },
  applyFilters() {
    const legion = this.data.legionOptions[this.data.legionIndex], area = this.data.areaOptions[this.data.areaIndex];
    const rows = this.data.allRows.filter((r) => (!this.data.legionIndex || r.legion === legion) && (!this.data.areaIndex || r.area === area))
      .map(r => ({ ...r, rank: r.rankByMetric?.[this.data.metric] ?? r.rank })).sort((a, b) => this.data.sortDescending ? b.rank - a.rank : a.rank - b.rank)
      .map((r) => {
        const v = r[this.data.metric];
        return { ...r, weekTargetText: formatValue(this.data.metric, v.weekTarget), weekDoneText: formatValue(this.data.metric, v.weekDone), monthTargetText: formatValue(this.data.metric, v.monthTarget),
          monthDoneText: formatValue(this.data.metric, v.monthDone), weekRate: rate(v.weekDone, v.weekTarget), monthRate: rate(v.monthDone, v.monthTarget) };
      });
    this.setData({ rows });
  },
  sortChange(e: WechatMiniprogram.CustomEvent<{ value: boolean }>) { this.setData({ sortDescending: e.detail.value }); this.applyFilters(); },
  legionChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ legionIndex: Number(e.detail.value) }); this.applyFilters(); },
  areaChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ areaIndex: Number(e.detail.value) }); this.applyFilters(); },
  periodChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.loading) return;
    this.setData({ periodIndex: Number(e.detail.value), classIndex: 0, selectedClass: false, legionIndex: 0, areaIndex: 0, sortDescending: false, rows: [], allRows: [], ready: false }); void this.load();
  },
  openClass(e: WechatMiniprogram.CustomEvent) {
    if (this.data.loading) return;
    this.setData({ classIndex: Number(e.currentTarget.dataset.index), selectedClass: true, legionIndex: 0, areaIndex: 0, sortDescending: false, rows: [], allRows: [], ready: false }); void this.load(false);
  },
  classList() { if (!this.data.loading) this.setData({ selectedClass: false }); },
  classChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.loading) return;
    this.setData({ classIndex: Number(e.detail.value), legionIndex: 0, areaIndex: 0, rows: [], allRows: [], ready: false }); void this.load(false);
  },
  metricChange(e: WechatMiniprogram.CustomEvent) {
    if (this.data.loading) return;
    const metric = e.currentTarget.dataset.metric as Metric;
    if (metric !== 'sales' && metric !== 'consumption') return;
    this.setData({ metric });
    if (this._context === sessionContext() && this.data.ready &&
        this.data.allRows.every(row => row.rankByMetric)) this.applyFilters();
    else void this.load(false);
  },
  retry() { void this.load(); },
});
