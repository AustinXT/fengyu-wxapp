// pages/appointment/appointment.ts
import Toast from '@vant/weapp/toast/toast';
import Dialog from '@vant/weapp/dialog/dialog';

const STATUS_MAP: Record<string, { label: string; type: string; color: string; textColor: string }> = {
  '待确认': { label: '待确认', type: 'warning',  color: '#FFF7E6', textColor: '#D48806' },
  '已确认': { label: '已确认', type: 'primary',  color: '#F2E8DC', textColor: '#A0785A' },
  '已完成': { label: '已完成', type: 'success',  color: '#F0FAF0', textColor: '#389E0D' },
  '已取消': { label: '已取消', type: 'default',  color: '#F5F5F5', textColor: '#8C8C8C' },
  '已关闭': { label: '已关闭', type: 'default',  color: '#F5F5F5', textColor: '#8C8C8C' },
};

Page({
  data: {
    activeTab: 'all',
    list: [] as any[],
    isLoading: false,
  },

  onLoad() {
    this.loadList();
  },

  onShow() {
    this.loadList();
  },

  onPullDownRefresh() {
    this.loadList().finally(() => wx.stopPullDownRefresh());
  },

  onTabChange(e: WechatMiniprogram.CustomEvent<{ name: string }>) {
    this.setData({ activeTab: e.detail.name });
    this.loadList();
  },

  async loadList() {
    this.setData({ isLoading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'getAppointments',
        data: { status: this.data.activeTab === 'all' ? undefined : this.data.activeTab },
      }) as any;
      const raw: any[] = res.result?.data || [];
      const list = raw.map(item => {
        const meta = STATUS_MAP[item.status] || STATUS_MAP['已关闭'];
        const d = new Date(item.appointment_time);
        return {
          ...item,
          status_label:     meta.label,
          statusType:       meta.type,
          statusColor:      meta.color,
          statusTextColor:  meta.textColor,
          appointment_time_fmt: `${d.getMonth()+1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`,
        };
      });
      this.setData({ list });
    } catch {
      Toast.fail('加载失败');
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onCreateAppointment() {
    wx.navigateTo({ url: '/pages/appointment-create/appointment-create' });
  },

  onCancelAppt(e: WechatMiniprogram.TouchEvent) {
    const { id } = e.currentTarget.dataset as { id: string };
    Dialog.confirm({ title: '取消预约', message: '确定要取消此预约吗？取消后可重新发起。' })
      .then(async () => {
        try {
          await wx.cloud.callFunction({ name: 'cancelAppointment', data: { appointmentId: id } });
          Toast.success('预约已取消');
          this.loadList();
        } catch {
          Toast.fail('操作失败，请稍后重试');
        }
      })
      .catch(() => {});
  },

  onShareAppMessage() {
    return { title: '凤御预约', path: '/pages/appointment/appointment' };
  },
});
