import { callApi, showError, today } from '../../utils/cloud';
interface Period { id: string; name: string; start: string; end: string }
interface Values { weekTarget: number | null; weekDone: number; monthTarget: number | null; monthDone: number }
interface Row { employeeId: string; name: string; area: string; legion: string; group: string; mentor: string; rank: number; sales: Values; consumption: Values }
const money = (n: number | null) => n === null ? '未设置' : (n / 100).toFixed(2);
const rate = (done: number, target: number | null) => target && target > 0 ? (done / target * 100).toFixed(1) + '%' : '—';
Page({
  data: { loading: false, ready: false, periods: [] as Period[], periodIndex: 0,
    classes: [] as { id: string; name: string; members: number; stores: number }[], classIndex: 0,
    selectedClass: false, status: '', metric: 'sales', weekName: '', scopeLabel: '', rows: [] as (Row & { weekTargetText: string; weekDoneText: string; monthTargetText: string; monthDoneText: string; weekRate: string; monthRate: string })[] },
  onShow() { void this.load(); },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true, ready: false });
    try {
      if (!this.data.periods.length) {
        const data = await callApi<{ periods: Period[]; period: Period | null }>('period.list');
        this.setData({ periods: data.periods, periodIndex: Math.max(0, data.periods.findIndex((p) => p.id === data.period?.id)) });
      }
      const periodId = this.data.periods[this.data.periodIndex]?.id;
      if (!periodId) { this.setData({ classes: [], rows: [], ready: true }); return; }
      const data = await callApi<{ classes: { id: string; name: string; members: number; stores: number }[]; scopeLabel: string }>('pk.classes', { periodId });
      const index = Math.min(this.data.classIndex, Math.max(0, data.classes.length - 1));
      this.setData({ classes: data.classes, classIndex: index, scopeLabel: data.scopeLabel, rows: [] });
      const period = this.data.periods[this.data.periodIndex];
      this.setData({ status: today() < period.start ? '未开始' : today() > period.end ? '已结束' : '进行中' });
      if (data.classes.length && this.data.selectedClass) {
        const board = await callApi<{ rows: Row[]; week: { name: string }; scopeLabel: string }>('pk.read',
          { periodId, classId: data.classes[index].id, metric: this.data.metric, date: today() });
        this.setData({ weekName: board.week.name, scopeLabel: board.scopeLabel, rows: board.rows.map((r) => {
          const v = this.data.metric === 'sales' ? r.sales : r.consumption;
          return { ...r, weekTargetText: money(v.weekTarget), weekDoneText: money(v.weekDone), monthTargetText: money(v.monthTarget),
            monthDoneText: money(v.monthDone), weekRate: rate(v.weekDone, v.weekTarget), monthRate: rate(v.monthDone, v.monthTarget) };
        }) });
      }
      this.setData({ ready: true });
    } catch (e) { showError(e); } finally { this.setData({ loading: false }); }
  },
  periodChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.loading) return;
    this.setData({ periodIndex: Number(e.detail.value), classIndex: 0, selectedClass: false }); void this.load();
  },
  openClass(e: WechatMiniprogram.CustomEvent) {
    if (this.data.loading) return;
    this.setData({ classIndex: Number(e.currentTarget.dataset.index), selectedClass: true }); void this.load();
  },
  classList() { if (!this.data.loading) this.setData({ selectedClass: false }); },
  classChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.loading) return;
    this.setData({ classIndex: Number(e.detail.value) }); void this.load();
  },
  metricChange(e: WechatMiniprogram.CustomEvent) {
    if (this.data.loading) return;
    this.setData({ metric: e.currentTarget.dataset.metric }); void this.load();
  },
  retry() { void this.load(); },
});
