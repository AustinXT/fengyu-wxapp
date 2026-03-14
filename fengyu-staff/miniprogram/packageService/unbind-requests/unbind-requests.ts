// pages/unbind-requests/unbind-requests.ts — 顾客解绑申请审批
import { callStaffApi } from '../../utils/cloud';

interface UnbindRequest {
  requestId: string;
  phoneMasked: string;
  fromStoreName: string;
  note: string | null;
  createdAt: string;
}

Page({
  data: {
    loading: false,
    requests: [] as UnbindRequest[],
    // 拒绝弹窗
    showRejectDialog: false,
    rejectRequestId: '',
    rejectReason: '',
    submitting: false,
  },

  onShow() {
    this.loadRequests();
  },

  async loadRequests() {
    this.setData({ loading: true });
    try {
      const data = await callStaffApi<{ requests: UnbindRequest[] }>('store.unbindRequests');
      this.setData({ requests: (data as any).requests || [] });
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async onApprove(e: WechatMiniprogram.TouchEvent) {
    const { requestId } = e.currentTarget.dataset as { requestId: string };
    wx.showModal({
      title: '确认通过',
      content: '通过后顾客门店绑定将被解除，顾客可重新选择门店。',
      confirmText: '通过',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('store.approveUnbind', { requestId });
          wx.showToast({ title: '已通过', icon: 'success' });
          this.loadRequests();
        } catch (err: any) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      }
    });
  },

  onReject(e: WechatMiniprogram.TouchEvent) {
    const { requestId } = e.currentTarget.dataset as { requestId: string };
    this.setData({ showRejectDialog: true, rejectRequestId: requestId, rejectReason: '' });
  },

  onRejectReasonInput(e: WechatMiniprogram.CustomEvent) {
    this.setData({ rejectReason: e.detail as unknown as string });
  },

  onRejectDialogCancel() {
    this.setData({ showRejectDialog: false });
  },

  async onRejectDialogConfirm() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await callStaffApi('store.rejectUnbind', {
        requestId: this.data.rejectRequestId,
        rejectReason: this.data.rejectReason || undefined,
      });
      this.setData({ showRejectDialog: false });
      wx.showToast({ title: '已拒绝', icon: 'success' });
      this.loadRequests();
    } catch (err: any) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  formatDate(dateStr: string): string {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  },
});
