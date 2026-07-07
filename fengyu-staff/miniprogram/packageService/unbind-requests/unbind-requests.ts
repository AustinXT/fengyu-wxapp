
import { callStaffApi } from '../../utils/cloud';
import { formatDateTime } from '../../utils/formatters';

interface UnbindRequest {
  requestId: string;
  phoneMasked: string;
  fromStoreName: string;
  toStoreId: string;
  toStoreName: string;
  note: string | null;
  createdAt: string;
}

Page({
  data: {
    loading: false,
    requests: [] as UnbindRequest[],
    
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
      const requests = ((data as any).requests || []).map((r: UnbindRequest) => ({
        ...r,
        createdAt: formatDateTime(r.createdAt),
      }));
      this.setData({ requests });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async onApprove(e: WechatMiniprogram.TouchEvent) {
    const { requestId, fromStore, toStore } = e.currentTarget.dataset as {
      requestId: string; fromStore: string; toStore: string;
    };
    wx.showModal({
      title: '确认通过',
      content: `通过后顾客将从「${fromStore}」转绑到「${toStore}」。`,
      confirmText: '通过',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await callStaffApi('store.approveUnbind', { requestId });
          wx.showToast({ title: '已通过', icon: 'success' });
          this.loadRequests();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '操作失败';
          wx.showToast({ title: msg, icon: 'none' });
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '操作失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

});
