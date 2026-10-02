import { MetricSnapshot } from '../../utils/cloud';
const amount = (value: number | null | undefined) => value == null ? '未设置' : (value / 100).toFixed(2);
const rate = (done: number | undefined, target: number | null | undefined) => target != null && target > 0 && done != null ? (done / target * 100).toFixed(1) + '%' : '未设置';
Component({
  properties: { snapshot: { type: null, value: null, observer: 'refresh' }, frozen: { type: Boolean, value: false } },
  data: { scopeLabel: '', periodLabel: '', daySales: '', dayConsumption: '', weekSales: '', weekConsumption: '', monthSales: '', monthConsumption: '', savedAt: '' },
  methods: {
    refresh(snapshot: MetricSnapshot | null) {
      if (!snapshot) return;
      this.setData({ scopeLabel: snapshot.scope === 'store' ? '本店' : snapshot.scope === 'market' ? '市场' : '个人',
        periodLabel: snapshot.period ? `${snapshot.period.name}${snapshot.week ? ' · ' + snapshot.week.name : ''}` : '尚未配置经营周期',
        daySales: amount(snapshot.day.sales), dayConsumption: amount(snapshot.day.consumption),
        weekSales: rate(snapshot.week?.sales.done, snapshot.week?.sales.target), weekConsumption: rate(snapshot.week?.consumption.done, snapshot.week?.consumption.target),
        monthSales: `${amount(snapshot.month?.sales.done)} / ${amount(snapshot.month?.sales.target)}`,
        monthConsumption: `${amount(snapshot.month?.consumption.done)} / ${amount(snapshot.month?.consumption.target)}`,
        savedAt: snapshot.savedAt ? new Date(snapshot.savedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '' });
    },
  },
});
