// packageOrder/service-commission/service-commission.ts — 服务提成分配
import { callStaffApi } from '../../utils/cloud';
import { requireManager } from '../../utils/role';
import { lookupServiceRate, computeServiceLine, ServiceRateRow } from '../utils/service-commission-calc';

interface ServiceItem {
  service_item_id: string;
  sale_item_id: string;
  session_used: number;
  unit_real_price: string;
  sales_category: string | null;
  employee_id: string | null;
  service_fee: string | null;
  session_count: number | null;
  quantity: number | null;
  product_name: string;
  sku_spec_name: string;
}

interface ExistingCommission {
  service_item_id: string;
  employee_id: string;
  role_type: string;
  allocation_ratio: string;
  commission_rate: string;
  commission_amount: string;
  employee_name: string | null;
}

interface OrderInfo {
  service_order_id: string;
  status: string;
  service_date: string;
  market_name: string;
  commission_status: string;
  customer_name: string | null;
  employee_name: string | null;
}

interface DetailResponse {
  order: OrderInfo;
  items: ServiceItem[];
  commissions: ExistingCommission[];
  rates: ServiceRateRow[];
}

interface DeptApiResponse {
  departments: Array<{
    departmentName: string;
    members: Array<{ staffWfId: string; name: string; position: string; skills?: string[] }>;
  }>;
}

interface StaffInfo {
  staffWfId: string;
  staffName: string;
  department: string;
  skills: string[];
}

interface CommLine {
  serviceItemId: string;
  roleType: string;
  staffWfId: string;
  staffName: string;
  salesCategory: string;
  commissionRate: number; // display-only, from matrix
  allocationRatio: number; // 0.10~1.00
  ratioPercent: number; // 10~100, 用于 picker 显示
  allocAmount: string;
  commissionAmount: string;
}

interface DisplayItem {
  service_item_id: string;
  product_name: string;
  sku_spec_name: string;
  sales_category: string | null;
  session_used: number;
  consumeBase: number; // unit_real_price × session_used（整池基数）
  fixedFeeBase: number; // service_fee × session_used（整池）
  allocLines: CommLine[];
  poolSummary: Array<{ role: string; percent: number }>; // 每技能池累计%
}

interface PickerGroup {
  department: string;
  members: StaffInfo[];
}

const RATIO_OPTIONS = ['10%', '20%', '30%', '40%', '50%', '60%', '70%', '80%', '90%', '100%'];

const round2 = (n: number) => Math.round(n * 100) / 100;

Page({
  data: {
    loading: false,
    submitting: false,
    serviceOrderId: '',
    order: null as OrderInfo | null,
    rates: [] as ServiceRateRow[],
    allStaffList: [] as StaffInfo[],
    pickerGroups: [] as PickerGroup[],
    displayItems: [] as DisplayItem[],
    isAllocated: false,
    ratioOptions: RATIO_OPTIONS,
    // 选人弹窗
    pickerVisible: false,
    pickerServiceItemId: '',
  },

  onLoad(options: Record<string, string>) {
    if (!requireManager()) {
      wx.navigateBack();
      return;
    }
    const serviceOrderId = options.serviceOrderId;
    if (serviceOrderId) {
      this.setData({ serviceOrderId });
      this.init(serviceOrderId);
    }
  },

  async init(serviceOrderId: string) {
    this.setData({ loading: true });
    try {
      const [detailData, deptResponse] = await Promise.all([
        callStaffApi<DetailResponse>('serviceCommission.detail', { serviceOrderId }),
        callStaffApi<DeptApiResponse>('staff.departments'),
      ]);

      const order = detailData.order;
      const rates = detailData.rates || [];
      const isAllocated = order.commission_status === '已分配';

      // 员工列表（扁平 + 分组）
      const allStaffList: StaffInfo[] = [];
      const pickerGroups: PickerGroup[] = [];
      for (const d of (deptResponse.departments || [])) {
        const members: StaffInfo[] = (d.members || []).map((s) => ({
          staffWfId: s.staffWfId,
          staffName: s.name || '',
          department: d.departmentName,
          skills: Array.isArray(s.skills) ? s.skills : [],
        }));
        allStaffList.push(...members);
        pickerGroups.push({ department: d.departmentName, members });
      }

      // displayItems：计算每项基数
      const existingByItem = new Map<string, ExistingCommission[]>();
      for (const c of (detailData.commissions || [])) {
        if (!existingByItem.has(c.service_item_id)) existingByItem.set(c.service_item_id, []);
        existingByItem.get(c.service_item_id)!.push(c);
      }
      const staffNameMap = new Map<string, string>();
      allStaffList.forEach(s => staffNameMap.set(s.staffWfId, s.staffName));

      const displayItems: DisplayItem[] = (detailData.items || []).map(item => {
        const sessionUsed = Number(item.session_used) || 0;
        const consumeBase = round2(Number(item.unit_real_price || 0) * sessionUsed);
        const fixedFeeBase = round2(Number(item.service_fee || 0) * sessionUsed);
        const salesCat = item.sales_category || '自销自耗';

        const lines: CommLine[] = (existingByItem.get(item.service_item_id) || []).map(c => {
          const ratio = Number(c.allocation_ratio) || 1.0;
          const rate = Number(c.commission_rate) || 0;
          const allocAmount = round2(consumeBase * ratio).toFixed(2);
          return {
            serviceItemId: item.service_item_id,
            roleType: c.role_type || '',
            staffWfId: c.employee_id,
            staffName: staffNameMap.get(c.employee_id) || c.employee_name || c.employee_id,
            salesCategory: salesCat,
            commissionRate: rate,
            allocationRatio: ratio,
            ratioPercent: Math.round(ratio * 100),
            allocAmount,
            commissionAmount: Number(c.commission_amount || 0).toFixed(2),
          };
        });

        return {
          service_item_id: item.service_item_id,
          product_name: item.product_name,
          sku_spec_name: item.sku_spec_name,
          sales_category: item.sales_category,
          session_used: sessionUsed,
          consumeBase,
          fixedFeeBase,
          allocLines: lines,
          poolSummary: this.calcPoolSummary(lines),
        };
      });

      this.setData({
        order,
        rates,
        allStaffList,
        pickerGroups,
        displayItems,
        isAllocated,
        loading: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
      this.setData({ loading: false });
    }
  },

  /** 计算每技能池累计分配比例（百分比） */
  calcPoolSummary(lines: CommLine[]): Array<{ role: string; percent: number }> {
    const map = new Map<string, number>();
    for (const l of lines) {
      if (!l.roleType) continue;
      map.set(l.roleType, (map.get(l.roleType) || 0) + l.ratioPercent);
    }
    return [...map.entries()].map(([role, percent]) => ({ role, percent }));
  },

  /** 打开选人弹窗 */
  onAddPerson(e: WechatMiniprogram.TouchEvent) {
    const serviceItemId = e.currentTarget.dataset.serviceItemId as string;
    this.setData({ pickerVisible: true, pickerServiceItemId: serviceItemId });
  },

  onPickerClose() {
    this.setData({ pickerVisible: false, pickerServiceItemId: '' });
  },

  /** 选中员工（按 skills 推断 roleType） */
  async onStaffSelected(e: WechatMiniprogram.TouchEvent) {
    const staffWfId = e.currentTarget.dataset.staffWfId as string;
    const department = e.currentTarget.dataset.department as string;
    const { pickerServiceItemId, displayItems, allStaffList } = this.data;

    const diIdx = displayItems.findIndex(d => d.service_item_id === pickerServiceItemId);
    if (diIdx < 0) return;
    const di = displayItems[diIdx];

    const staff = allStaffList.find(s => s.staffWfId === staffWfId && s.department === department);
    if (!staff) return;

    if (!staff.skills || staff.skills.length === 0) {
      wx.showToast({ title: `${staff.staffName} 暂无技能标签，请联系管理员补录`, icon: 'none', duration: 2500 });
      return;
    }
    let roleType = '';
    if (staff.skills.length === 1) {
      roleType = staff.skills[0];
    } else {
      try {
        const sheetRes = await wx.showActionSheet({ itemList: staff.skills });
        roleType = staff.skills[sheetRes.tapIndex];
      } catch (_e) {
        return;
      }
    }

    // 防重复：同一 item 同一 roleType 不添加同一人
    if (di.allocLines.some(l => l.staffWfId === staffWfId && l.roleType === roleType)) {
      wx.showToast({ title: '该员工已在此技能下添加', icon: 'none' });
      return;
    }

    const salesCat = di.sales_category || '自销自耗';
    const ratio = 1.0;
    const rate = lookupServiceRate(roleType, salesCat, di.consumeBase, this.data.rates);
    const { allocAmount, commissionAmount } = computeServiceLine(di.consumeBase, di.fixedFeeBase, ratio, rate);

    const newLine: CommLine = {
      serviceItemId: pickerServiceItemId,
      roleType,
      staffWfId: staff.staffWfId,
      staffName: staff.staffName,
      salesCategory: salesCat,
      commissionRate: rate,
      allocationRatio: ratio,
      ratioPercent: 100,
      allocAmount,
      commissionAmount,
    };

    const lines = [...di.allocLines, newLine];
    this.setData({
      [`displayItems[${diIdx}].allocLines`]: lines,
      [`displayItems[${diIdx}].poolSummary`]: this.calcPoolSummary(lines),
      pickerVisible: false,
      pickerServiceItemId: '',
    });
  },

  /** 修改分配比例 */
  onRatioChange(e: WechatMiniprogram.CustomEvent) {
    const itemIdx = Number(e.currentTarget.dataset.itemIdx);
    const lineIdx = Number(e.currentTarget.dataset.lineIdx);
    const optIdx = Number(e.detail.value);
    const ratioPercent = (optIdx + 1) * 10;
    const ratio = ratioPercent / 100;
    const di = this.data.displayItems[itemIdx];
    if (!di) return;
    const line = di.allocLines[lineIdx];
    if (!line) return;
    const { allocAmount, commissionAmount } = computeServiceLine(di.consumeBase, di.fixedFeeBase, ratio, line.commissionRate);
    const lines = di.allocLines.map((l, i) => i === lineIdx
      ? { ...l, allocationRatio: ratio, ratioPercent, allocAmount, commissionAmount }
      : l);
    this.setData({
      [`displayItems[${itemIdx}].allocLines`]: lines,
      [`displayItems[${itemIdx}].poolSummary`]: this.calcPoolSummary(lines),
    });
  },

  /** 移除人员 */
  onRemovePerson(e: WechatMiniprogram.TouchEvent) {
    const itemIdx = Number(e.currentTarget.dataset.itemIdx);
    const lineIdx = Number(e.currentTarget.dataset.lineIdx);
    const di = this.data.displayItems[itemIdx];
    if (!di) return;
    const lines = di.allocLines.filter((_, i) => i !== lineIdx);
    this.setData({
      [`displayItems[${itemIdx}].allocLines`]: lines,
      [`displayItems[${itemIdx}].poolSummary`]: this.calcPoolSummary(lines),
    });
  },

  async onSave() {
    if (this.data.submitting) return;
    const { displayItems, serviceOrderId } = this.data;

    const commissions: Array<{ serviceItemId: string; employeeId: string; roleType: string; allocationRatio: number }> = [];
    for (const di of displayItems) {
      for (const l of di.allocLines) {
        if (l.staffWfId && l.roleType) {
          commissions.push({
            serviceItemId: l.serviceItemId,
            employeeId: l.staffWfId,
            roleType: l.roleType,
            allocationRatio: l.allocationRatio,
          });
        }
      }
    }

    if (commissions.length === 0) {
      const res = await new Promise<WechatMiniprogram.ShowModalSuccessCallbackResult>(resolve => {
        wx.showModal({ title: '确认', content: '未添加任何分配，确定清空该服务单提成吗？', success: resolve });
      });
      if (!res.confirm) return;
    }

    // 客户端分池预校验（合计 ≤ 100%）
    const poolPct = new Map<string, number>();
    for (const c of commissions) {
      const key = `${c.serviceItemId}|${c.roleType}`;
      poolPct.set(key, (poolPct.get(key) || 0) + Math.round(c.allocationRatio * 100));
    }
    for (const [, pct] of poolPct) {
      if (pct > 100) {
        wx.showToast({ title: '同技能标签分配比例合计不能超过 100%', icon: 'none' });
        return;
      }
    }

    this.setData({ submitting: true });
    try {
      await callStaffApi('serviceCommission.save', { serviceOrderId, commissions });
      wx.showToast({ title: commissions.length === 0 ? '已清空' : '提成已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '保存失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
