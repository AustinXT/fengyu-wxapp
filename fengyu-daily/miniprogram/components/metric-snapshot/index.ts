import { MetricActuals, MetricSnapshot } from '../../utils/cloud';

type DisplayRow = { key: string; label: string; day: string; week: string; month: string };
const amount = (value: number | null | undefined) =>
  value == null ? '—' : (value / 100).toFixed(2);
const count = (value: number | null | undefined) =>
  value == null ? '—' : String(value);

function legacyActuals(snapshot: MetricSnapshot) {
  const readLegacy = (period: 'week' | 'month'): MetricActuals | null => {
    const values = snapshot[period];
    if (!values) return null;
    return {
      sales: values.sales?.done ?? 0,
      consumption: values.consumption?.done ?? 0,
    };
  };
  return snapshot.actuals || {
    day: snapshot.day,
    week: readLegacy('week'),
    month: readLegacy('month'),
  };
}

Component({
  properties: {
    snapshot: { type: null, value: null, observer: 'refresh' },
    frozen: { type: Boolean, value: false },
    compact: { type: Boolean, value: false },
  },
  data: {
    scopeLabel: '',
    periodLabel: '',
    rows: [] as DisplayRow[],
    savedAt: '',
  },
  methods: {
    refresh(snapshot: MetricSnapshot | null) {
      if (!snapshot) {
        this.setData({ rows: [] });
        return;
      }
      const actuals = legacyActuals(snapshot);
      const definitions: { key: keyof MetricActuals; label: string; money?: boolean }[] = [
        { key: 'sales', label: '业绩（元）', money: true },
        { key: 'consumption', label: '消耗（元）', money: true },
        { key: 'visits', label: '客量（单）' },
        { key: 'newCustomers', label: '新客（人）' },
        { key: 'projects', label: '项目数（次）' },
      ];
      const rows = definitions.map(({ key, label, money }) => {
        const format = money ? amount : count;
        return {
          key,
          label,
          day: format(actuals.day?.[key]),
          week: format(actuals.week?.[key]),
          month: format(actuals.month?.[key]),
        };
      });
      this.setData({
        scopeLabel: snapshot.scope === 'store' ? '本店实际' : snapshot.scope === 'market' ? '市场实际' : '个人实际',
        periodLabel: snapshot.period
          ? snapshot.period.name + (snapshot.week ? ' · ' + snapshot.week.name : '')
          : '未配置经营周期，仅显示当日实际',
        rows,
        savedAt: snapshot.savedAt
          ? new Date(snapshot.savedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          : '',
      });
    },
  },
});
