


import { callStaffApi } from '../../utils/cloud';
import { requireManager } from '../../utils/role';
import {
  lookupServiceRate, computeServiceLine, computeServiceSummary, ServiceRateRow,
} from '../utils/service-commission-calc';

const RATIO_OPTIONS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const MAX_PER_POOL = 3;
const round2 = (n: number) => Math.round(n * 100) / 100;

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
  frozen?: boolean; 
}


interface CandidateEmployee {
  staffWfId: string;
  name: string;
  storeId: string;
  storeName: string;
  skills: string[];
  department: string;
  
  isOnBusinessTrip?: boolean;
}

interface DetailResponse {
  order: OrderInfo;
  items: ServiceItem[];
  commissions: ExistingCommission[];
  rates: ServiceRateRow[];
  candidateEmployees?: CandidateEmployee[];
  orderStoreId?: string;
}

interface CommLine {
  serviceItemId: string;
  roleType: string;        
  staffWfId: string;       
  staffName: string;
  salesCategory: string;
  ratioPercent: number;    
  commissionRate: number;  
  allocAmount: string;     
  commissionAmount: string; 
}

interface DisplayItem {
  service_item_id: string;
  product_name: string;
  sales_category: string | null;
  session_used: number;
  consumeBase: number;  
  fixedFeeBase: number; 
  allocLines: CommLine[];
}

Page({
  data: {
    loading: false,
    submitting: false,
    serviceOrderId: '',
    order: null as OrderInfo | null,
    rates: [] as ServiceRateRow[],
    candidateEmployees: [] as CandidateEmployee[],
    orderStoreId: '',
    displayItems: [] as DisplayItem[],
    isAllocated: false,
    frozen: false, 
    
    summary: [] as Array<{ staffName: string; department: string; total: string }>,
    grandTotal: '0.00',
    
    pickerItemIdx: -1,
    pickerLineIdx: -1,
    skillSheetVisible: false,
    
    skillSheetActions: [] as Array<{ name: string }>,
    ratioSheetVisible: false,
    ratioSheetActions: RATIO_OPTIONS.map(p => ({ name: `${p}%`, value: p })),
    empPopupVisible: false,
    empPopupList: [] as CandidateEmployee[],
    empPopupTitle: '选择员工',
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
      const [detailData, skillTagData] = await Promise.all([
        callStaffApi<DetailResponse>('serviceCommission.detail', { serviceOrderId }),
        callStaffApi<{ skillTags: string[] }>('staff.skillTags', {}).catch(() => ({ skillTags: [] })),
      ]);
      this.setData({ skillSheetActions: (skillTagData.skillTags || []).map(name => ({ name })) });

      const order = detailData.order;
      const rates = detailData.rates || [];
      const isAllocated = order.commission_status === '已分配';
      const candidateEmployees = detailData.candidateEmployees || [];
      const orderStoreId = detailData.orderStoreId || '';

      const staffNameMap = new Map<string, string>();
      candidateEmployees.forEach(e => staffNameMap.set(e.staffWfId, e.name));

      const existingByItem = new Map<string, ExistingCommission[]>();
      for (const c of (detailData.commissions || [])) {
        if (!existingByItem.has(c.service_item_id)) existingByItem.set(c.service_item_id, []);
        existingByItem.get(c.service_item_id)!.push(c);
      }

      this.setData({ rates }); 

      const displayItems: DisplayItem[] = (detailData.items || []).map(item => {
        const sessionUsed = Number(item.session_used) || 0;
        const consumeBase = round2(Number(item.unit_real_price || 0) * sessionUsed);
        const fixedFeeBase = round2(Number(item.service_fee || 0) * sessionUsed);
        const salesCat = item.sales_category || '自销自耗';

        
        const lines: CommLine[] = (existingByItem.get(item.service_item_id) || []).map(c => {
          const ratioPercent = Math.round((Number(c.allocation_ratio) || 0) * 100);
          const roleType = c.role_type || '';
          const commissionRate = roleType ? lookupServiceRate(roleType, salesCat, consumeBase, rates) : 0;
          const { allocAmount, commissionAmount } = computeServiceLine(
            consumeBase, fixedFeeBase, ratioPercent / 100, commissionRate
          );
          return {
            serviceItemId: item.service_item_id,
            roleType,
            staffWfId: c.employee_id,
            staffName: staffNameMap.get(c.employee_id) || c.employee_name || c.employee_id,
            salesCategory: salesCat,
            ratioPercent,
            commissionRate,
            allocAmount,
            commissionAmount,
          };
        });

        return {
          service_item_id: item.service_item_id,
          product_name: item.product_name,
          sales_category: item.sales_category,
          session_used: sessionUsed,
          consumeBase,
          fixedFeeBase,
          allocLines: lines,
        };
      });

      this.setData({
        order,
        candidateEmployees,
        orderStoreId,
        displayItems,
        isAllocated,
        frozen: !!order.frozen,
        loading: false,
      });
      this.computeSummary();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
      this.setData({ loading: false });
    }
  },

  
  computeLine(line: CommLine, consumeBase: number, fixedFeeBase: number): CommLine {
    const { allocAmount, commissionAmount } = computeServiceLine(
      consumeBase, fixedFeeBase, line.ratioPercent / 100, line.commissionRate || 0
    );
    return { ...line, allocAmount, commissionAmount };
  },

  
  getFilteredEmployees(skillTag: string): CandidateEmployee[] {
    const { candidateEmployees, orderStoreId } = this.data;
    return candidateEmployees.filter(e => {
      if (!e.skills || !e.skills.includes(skillTag)) return false;
      return e.storeId === orderStoreId || !!e.isOnBusinessTrip;
    });
  },

  
  onAddLine(e: WechatMiniprogram.TouchEvent) {
    const itemIdx = e.currentTarget.dataset.itemIdx as number;
    const di = this.data.displayItems[itemIdx];
    if (!di) return;
    const newLine: CommLine = {
      serviceItemId: di.service_item_id,
      roleType: '',
      staffWfId: '',
      staffName: '',
      salesCategory: di.sales_category || '自销自耗',
      ratioPercent: 0,
      commissionRate: 0,
      allocAmount: '0.00',
      commissionAmount: '0.00',
    };
    this.setData({ [`displayItems[${itemIdx}].allocLines`]: [...di.allocLines, newLine] });
  },

  onRemoveLine(e: WechatMiniprogram.TouchEvent) {
    const itemIdx = e.currentTarget.dataset.itemIdx as number;
    const lineIdx = e.currentTarget.dataset.lineIdx as number;
    const di = this.data.displayItems[itemIdx];
    if (!di) return;
    const updated = di.allocLines.filter((_: CommLine, i: number) => i !== lineIdx);
    this.setData({ [`displayItems[${itemIdx}].allocLines`]: updated });
    this.computeSummary();
  },

  
  openSkillPicker(e: WechatMiniprogram.TouchEvent) {
    const itemIdx = e.currentTarget.dataset.itemIdx as number;
    const lineIdx = e.currentTarget.dataset.lineIdx as number;
    this.setData({ pickerItemIdx: itemIdx, pickerLineIdx: lineIdx, skillSheetVisible: true });
  },

  onSkillSelect(e: WechatMiniprogram.CustomEvent) {
    const roleType = e.detail.name as string;
    const { pickerItemIdx: itemIdx, pickerLineIdx: lineIdx, displayItems } = this.data;
    const di = displayItems[itemIdx];
    if (!di) { this.closeSkillSheet(); return; }
    const line = di.allocLines[lineIdx];
    
    const commissionRate = lookupServiceRate(roleType, line.salesCategory, di.consumeBase, this.data.rates);
    const updated = this.computeLine(
      { ...line, roleType, staffWfId: '', staffName: '', commissionRate },
      di.consumeBase, di.fixedFeeBase
    );
    this.setData({
      [`displayItems[${itemIdx}].allocLines[${lineIdx}]`]: updated,
      skillSheetVisible: false,
    });
    this.computeSummary();
  },

  closeSkillSheet() {
    this.setData({ skillSheetVisible: false });
  },

  
  openEmployeePicker(e: WechatMiniprogram.TouchEvent) {
    const itemIdx = e.currentTarget.dataset.itemIdx as number;
    const lineIdx = e.currentTarget.dataset.lineIdx as number;
    const di = this.data.displayItems[itemIdx];
    if (!di) return;
    const line = di.allocLines[lineIdx];
    if (!line.roleType) {
      wx.showToast({ title: '请先选择技能标签', icon: 'none' });
      return;
    }
    const list = this.getFilteredEmployees(line.roleType);
    this.setData({
      pickerItemIdx: itemIdx,
      pickerLineIdx: lineIdx,
      empPopupList: list,
      empPopupTitle: `选择员工（${list.length}人）`,
      empPopupVisible: true,
    });
  },

  onEmployeeSelect(e: WechatMiniprogram.TouchEvent) {
    const staffWfId = e.currentTarget.dataset.staffWfId as string;
    const staffName = e.currentTarget.dataset.name as string;
    const { pickerItemIdx: itemIdx, pickerLineIdx: lineIdx, displayItems } = this.data;
    const di = displayItems[itemIdx];
    if (!di) { this.closeEmpPopup(); return; }
    const line = di.allocLines[lineIdx];
    
    const dup = di.allocLines.some((l: CommLine, i: number) =>
      i !== lineIdx && l.roleType === line.roleType && l.staffWfId === staffWfId
    );
    if (dup) {
      wx.showToast({ title: '该员工已在同技能标签下分配', icon: 'none' });
      return;
    }
    this.setData({
      [`displayItems[${itemIdx}].allocLines[${lineIdx}]`]: { ...line, staffWfId, staffName },
      empPopupVisible: false,
    });
  },

  closeEmpPopup() {
    this.setData({ empPopupVisible: false });
  },

  
  openRatioPicker(e: WechatMiniprogram.TouchEvent) {
    const itemIdx = e.currentTarget.dataset.itemIdx as number;
    const lineIdx = e.currentTarget.dataset.lineIdx as number;
    this.setData({ pickerItemIdx: itemIdx, pickerLineIdx: lineIdx, ratioSheetVisible: true });
  },

  onRatioSelect(e: WechatMiniprogram.CustomEvent) {
    const percent = e.detail.value as number;
    const { pickerItemIdx: itemIdx, pickerLineIdx: lineIdx, displayItems } = this.data;
    const di = displayItems[itemIdx];
    if (!di) { this.closeRatioSheet(); return; }
    const updated = this.computeLine(
      { ...di.allocLines[lineIdx], ratioPercent: percent },
      di.consumeBase, di.fixedFeeBase
    );
    this.setData({
      [`displayItems[${itemIdx}].allocLines[${lineIdx}]`]: updated,
      ratioSheetVisible: false,
    });
    this.computeSummary();
  },

  closeRatioSheet() {
    this.setData({ ratioSheetVisible: false });
  },

  computeSummary() {
    const { summary, grandTotal } = computeServiceSummary(this.data.displayItems);
    this.setData({ summary, grandTotal });
  },

  async onSave() {
    if (this.data.submitting) return;
    if (this.data.frozen) {
      wx.showToast({ title: '分配结果已冻结，如需修改请联系管理后台', icon: 'none' });
      return;
    }
    const { displayItems, serviceOrderId } = this.data;

    
    const commissions: Array<{ serviceItemId: string; employeeId: string; roleType: string; allocationRatio: number }> = [];
    let hasPartial = false;
    for (const di of displayItems) {
      for (const l of di.allocLines) {
        const filled = l.roleType && l.staffWfId && l.ratioPercent > 0;
        if (filled) {
          commissions.push({
            serviceItemId: l.serviceItemId,
            employeeId: l.staffWfId,
            roleType: l.roleType,
            allocationRatio: l.ratioPercent / 100,
          });
        } else if (l.roleType || l.staffWfId || l.ratioPercent > 0) {
          hasPartial = true;
        }
      }
    }

    if (hasPartial) {
      wx.showToast({ title: '请填写完整的分配信息（技能标签、员工、分配比例）', icon: 'none' });
      return;
    }

    if (commissions.length === 0) {
      const res = await new Promise<WechatMiniprogram.ShowModalSuccessCallbackResult>(resolve => {
        wx.showModal({ title: '确认', content: '未添加任何分配，确定清空该服务单提成吗？', success: resolve });
      });
      if (!res.confirm) return;
    }

    
    const pools = new Map<string, Array<{ employeeId: string; allocationRatio: number }>>();
    for (const c of commissions) {
      const key = `${c.serviceItemId}|${c.roleType}`;
      if (!pools.has(key)) pools.set(key, []);
      pools.get(key)!.push(c);
    }
    for (const [, pool] of pools) {
      if (pool.length > MAX_PER_POOL) {
        wx.showToast({ title: `每个服务明细每个技能标签最多分配 ${MAX_PER_POOL} 人`, icon: 'none' });
        return;
      }
      const pct = pool.reduce((s, c) => s + Math.round(c.allocationRatio * 100), 0);
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
