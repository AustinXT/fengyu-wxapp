// pages/revenue-allocation/revenue-allocation.ts
import { callStaffApi } from '../../utils/cloud';
import { requireManager } from '../../utils/role';

interface AllocationRow {
  staffWfId: string;
  staffName: string;
  department: string;
  amount: string;
}

Page({
  data: {
    loading: false,
    submitting: false,
    orderId: '',
    orderNo: '',
    totalAmount: 0,
    totalAmountStr: '0.00',
    orderStatus: '',
    staffList: [] as any[],
    staffColumns: [] as string[],
    rows: [] as AllocationRow[],
    showPicker: false,
    editingRowIndex: -1,
    totalAllocated: '0.00',
    isOverBudget: false,
    isLocked: false,   // 顾客扫码后锁定
  },

  onLoad(options: Record<string, string>) {
    if (!requireManager()) {
      wx.navigateBack();
      return;
    }
    if (options.orderId) {
      this.setData({ orderId: options.orderId });
      this.init(options.orderId);
    }
  },

  async init(orderId: string) {
    this.setData({ loading: true });
    try {
      const [order, staffList] = await Promise.all([
        callStaffApi<any>('order.detail', { orderId }),
        callStaffApi<any[]>('staff.list', { isAllocatable: true }),
      ]);
      const totalAmount = parseFloat(order.totalAmount) || 0;
      // 扫码后（非待支付、非待确认收款）锁定分配
      const isLocked = !['待支付', '待确认收款'].includes(order.status);
      // 从已有分配初始化行
      const rows: AllocationRow[] = (order.allocation || []).map((a: any) => ({
        staffWfId: a.staffWfId || '',
        staffName: a.staffName,
        department: a.department,
        amount: a.amount,
      }));
      this.setData({
        orderNo: order.orderNo,
        totalAmount,
        totalAmountStr: order.totalAmount,
        orderStatus: order.status,
        staffList: staffList || [],
        staffColumns: (staffList || []).map((s: any) => `${s.staffName}（${s.department}）`),
        rows: rows.length > 0 ? rows : [{ staffWfId: '', staffName: '', department: '', amount: '' }],
        isLocked,
        loading: false,
      });
      this.computeTotals();
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  computeTotals() {
    const rows = this.data.rows;
    let total = 0;
    rows.forEach(r => { total += parseFloat(r.amount) || 0; });
    this.setData({
      totalAllocated: total.toFixed(2),
      isOverBudget: total > this.data.totalAmount + 0.01, // 允许0.01分误差
    });
  },

  onAddRow() {
    if (this.data.isLocked) return;
    if (this.data.rows.length >= 4) {
      wx.showToast({ title: '最多添加4位员工', icon: 'none' });
      return;
    }
    const rows = [...this.data.rows, { staffWfId: '', staffName: '', department: '', amount: '' }];
    this.setData({ rows });
  },

  onRemoveRow(e: WechatMiniprogram.TouchEvent) {
    const index = e.currentTarget.dataset.index as number;
    const rows = this.data.rows.filter((_, i) => i !== index);
    this.setData({ rows: rows.length > 0 ? rows : [{ staffWfId: '', staffName: '', department: '', amount: '' }] });
    this.computeTotals();
  },

  onTapStaff(e: WechatMiniprogram.TouchEvent) {
    if (this.data.isLocked) return;
    const index = e.currentTarget.dataset.index as number;
    this.setData({ showPicker: true, editingRowIndex: index });
  },

  onPickerConfirm(e: WechatMiniprogram.CustomEvent) {
    const pickerIndex = e.detail.index as number;
    const staff = this.data.staffList[pickerIndex];
    if (!staff) return;
    const rows = [...this.data.rows];
    rows[this.data.editingRowIndex] = {
      ...rows[this.data.editingRowIndex],
      staffWfId: staff.staffWfId,
      staffName: staff.staffName,
      department: staff.department,
    };
    this.setData({ rows, showPicker: false, editingRowIndex: -1 });
  },

  onPickerCancel() {
    this.setData({ showPicker: false, editingRowIndex: -1 });
  },

  onAmountChange(e: WechatMiniprogram.CustomEvent) {
    const index = e.currentTarget.dataset.index as number;
    const rows = [...this.data.rows];
    rows[index] = { ...rows[index], amount: e.detail.value };
    this.setData({ rows });
    this.computeTotals();
  },

  onPresetRatio(e: WechatMiniprogram.TouchEvent) {
    const { ratio } = e.currentTarget.dataset as { ratio: string };
    const rows = this.data.rows;
    if (rows.length < 2) {
      wx.showToast({ title: '请先添加两位员工', icon: 'none' });
      return;
    }
    const parts = ratio.split(':').map(Number);
    const sum = parts.reduce((a, b) => a + b, 0);
    const total = this.data.totalAmount;
    const newRows = [...rows];
    let remaining = total;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) {
        newRows[i] = { ...newRows[i], amount: remaining.toFixed(2) };
      } else {
        const amt = parseFloat((total * p / sum).toFixed(2));
        remaining -= amt;
        newRows[i] = { ...newRows[i], amount: amt.toFixed(2) };
      }
    });
    this.setData({ rows: newRows });
    this.computeTotals();
  },

  async onSave() {
    const { rows, orderId, isOverBudget, totalAmount } = this.data;
    const hasEmpty = rows.some(r => !r.staffWfId || !r.amount);
    if (hasEmpty) {
      wx.showToast({ title: '请完整填写员工和金额', icon: 'none' });
      return;
    }
    if (isOverBudget) {
      wx.showToast({ title: `分配总额不能超过实收 ¥${totalAmount.toFixed(2)}`, icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await callStaffApi('allocation.save', {
        orderId,
        items: rows.map(r => ({
          staffWfId: r.staffWfId,
          staffName: r.staffName,
          department: r.department,
          amount: parseFloat(r.amount),
        })),
      });
      wx.showToast({ title: '分配已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (err: any) {
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
