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

// 调用 clientApi 云函数
async function callClientApi(action: string, payload: Record<string, any> = {}) {
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: { action, payload }
  }) as any;
  if (res.result?.code !== 0) {
    const err: any = new Error(res.result?.message || '请求失败');
    err.code = res.result?.code;
    throw err;
  }
  return res.result.data;
}

// Tab name → 数据库 status 映射
const TAB_STATUS_MAP: Record<string, string> = {
  'pending':   '待确认',
  'confirmed': '已确认',
  'cancelled': '已取消',
};

Page({
  data: {
    activeTab: 'all',
    list: [] as any[],
    isLoading: false,
    loadError: false,
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
    this.setData({ isLoading: true, loadError: false });
    try {
      const dbStatus = TAB_STATUS_MAP[this.data.activeTab];
      const payload = dbStatus ? { status: dbStatus } : {};
      const data = await callClientApi('appointment.list', payload);
      const raw: any[] = data?.appointments || [];
      const list = raw.map(item => {
        const meta = STATUS_MAP[item.status] || STATUS_MAP['已关闭'];
        const rawTime = String(item.appointment_time);
        const d = new Date(rawTime.includes('T') ? rawTime : rawTime.replace(/-/g, '/'));
        return {
          ...item,
          status_label:     meta.label,
          statusType:       meta.type,
          statusColor:      meta.color,
          statusTextColor:  meta.textColor,
          appointment_time_fmt: `${d.getMonth()+1}月${d.getDate()}日 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}-${String(d.getHours() + 2).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`,
        };
      });
      this.setData({ list });
    } catch (err) {
      console.error('[appointment.loadList] error:', err);
      this.setData({ loadError: true });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onCreateAppointment() {
    wx.navigateTo({ url: '/pagesAppointment/appointment-create/appointment-create' });
  },

  onCancelAppt(e: WechatMiniprogram.TouchEvent) {
    const { id } = e.currentTarget.dataset as { id: string };
    Dialog.confirm({ title: '取消预约', message: '确定要取消此预约吗？取消后可重新发起。' })
      .then(async () => {
        try {
          await callClientApi('appointment.cancel', { appointmentId: id });
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
