


import { callStaffApi } from '../../utils/cloud';
import { requireManager } from '../../utils/role';
import { formatDateTime } from '../../utils/formatters';
import { lookupRate as _lookupRate, computeSummary as _computeSummary } from '../utils/allocation-calc';

const RATIO_OPTIONS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const MAX_PER_POOL = 3;

interface OrderItem {
  sale_item_id: string;
  product_name: string;
  received: string;
  sales_category: string | null;
  product_type: string;
}

interface RateRow {
  department: string;
  amountMin: number;
  amountMax: number;
  orderRates: Record<string, number>;
}

interface BeauticianInfo {
  staffWfId: string;
  name: string;
  primaryDept: string;
  secondaryDept: string;
  resolvedDept: string | null;
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


interface AllocLine {
  saleItemId: string;
  roleType: string;        
  staffWfId: string;       
  staffName: string;
  salesCategory: string;
  ratioPercent: number;    
  commissionRate: number;  
  allocAmount: string;     
  commissionAmount: string; 
}


interface SuggestLine {
  saleItemId: string;
  roleType: string;
  staffWfId: string;
  staffName: string;
  salesCategory: string;
  commissionRate: number;
  allocationRatio: number;
  autoFilled?: boolean;
}


interface DisplayItem {
  sale_item_id: string;
  product_name: string;
  received: string;
  sales_category: string | null;
  allocLines: AllocLine[];
}


interface OrderSummary {
  saleOrderId: string;
  status: string;
  totalAmount: string;
  allocation_status: string;
  customer_name?: string;
  paid_at?: string;
}


interface SuggestResponse {
  items: OrderItem[];
  totalAmount: number;       
  rates: RateRow[];
  ratesByRole?: Record<string, Record<string, number>>;
  beautyRates?: Record<string, Record<string, number>>;
  isNewCustomer: boolean;
  beauticianInfo: BeauticianInfo | null;
  deptAnomalous: boolean;
  allocLines: SuggestLine[];
  candidateEmployees?: CandidateEmployee[];
  existingAllocations?: AllocationRecord[];
  orderStoreId?: string;
  saleOrderId?: string;
  allocationStatus?: string;
  customerName?: string;
  paidAt?: string;
  frozen?: boolean; 
}


interface OrderDetailResponse {
  order: OrderSummary;
  items: OrderItem[];
  allocations: AllocationRecord[];
}


interface AllocationRecord {
  sale_item_id?: string;
  employee_id?: string;
  role_type?: string;
  department_name?: string;
  allocation_ratio?: number;
  total_amount?: string;
  is_void?: boolean;
  employee_name?: string;
  sales_category?: string;
}

Page({
  data: {
    loading: false,
    submitting: false,
    
    salePaymentId: 0,
    saleOrderId: '',
    order: null as OrderSummary | null,
    items: [] as OrderItem[],
    totalAmount: 0,
    rates: [] as RateRow[],
    beautyRates: {} as Record<string, Record<string, number>>,
    
    candidateEmployees: [] as CandidateEmployee[],
    orderStoreId: '',
    
    displayItems: [] as DisplayItem[],
    
    summary: [] as Array<{ staffName: string; department: string; total: string }>,
    grandTotal: '0.00',
    
    hasUnassigned: false,
    
    isAllocated: false,
    
    frozen: false,
    
    isNewCustomer: false,
    beauticianInfo: null as BeauticianInfo | null,
    deptAnomalous: false,
    
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
    const salePaymentId = Number(options.salePaymentId);
    if (salePaymentId) {
      this.setData({ salePaymentId });
      this.init(salePaymentId);
    }
  },

  async init(salePaymentId: number) {
    this.setData({ loading: true });
    try {
      const [suggestData, skillTagData] = await Promise.all([
        callStaffApi<SuggestResponse>('allocation.suggestPayment', { salePaymentId }),
        callStaffApi<{ skillTags: string[] }>('staff.skillTags', {}).catch(() => ({ skillTags: [] })),
      ]);

      const skillSheetActions = (skillTagData.skillTags || []).map(name => ({ name }));

      
      const items: OrderItem[] = suggestData.items || [];
      const totalAmount = suggestData.totalAmount || 0;
      const allocationStatus = suggestData.allocationStatus || '待分配';
      const isAllocated = allocationStatus === '已分配';
      const order: OrderSummary = {
        saleOrderId: suggestData.saleOrderId || '',
        status: '已支付',
        totalAmount: String(totalAmount),
        allocation_status: allocationStatus,
        customer_name: suggestData.customerName,
        
        paid_at: suggestData.paidAt ? formatDateTime(suggestData.paidAt) : '',
      };
      const rates: RateRow[] = suggestData.rates || [];
      const beautyRates: Record<string, Record<string, number>> =
        suggestData.ratesByRole || suggestData.beautyRates || {};
      const candidateEmployees = suggestData.candidateEmployees || [];
      const orderStoreId = suggestData.orderStoreId || '';

      const isNewCustomer = suggestData.isNewCustomer || false;
      const beauticianInfo = suggestData.beauticianInfo || null;
      const deptAnomalous = suggestData.deptAnomalous || false;

      this.setData({
        order,
        saleOrderId: order.saleOrderId,
        items,
        totalAmount,
        candidateEmployees,
        orderStoreId,
        beautyRates,
        rates,
        isAllocated,
        frozen: !!suggestData.frozen,
        isNewCustomer,
        beauticianInfo,
        deptAnomalous,
        skillSheetActions,
        loading: false,
      });

      const existing = suggestData.existingAllocations || [];
      if (isAllocated && existing.length > 0) {
        this.restoreAllocations(existing, items);
      } else {
        this.buildSuggestedItems(suggestData.allocLines || [], items);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
      this.setData({ loading: false });
    }
  },

  
  lookupRate(roleType: string, salesCat: string, received: number): number {
    const { commissionRate } = _lookupRate(
      roleType, salesCat, received, this.data.beautyRates, this.data.rates, this.data.totalAmount
    );
    return commissionRate;
  },

  
  computeLine(line: AllocLine, received: number): AllocLine {
    const ratio = line.ratioPercent / 100;
    const allocAmount = received * ratio;
    const commissionAmount = allocAmount * (line.commissionRate || 0);
    return {
      ...line,
      allocAmount: allocAmount.toFixed(2),
      commissionAmount: commissionAmount.toFixed(2),
    };
  },

  
  buildSuggestedItems(suggestLines: SuggestLine[], items: OrderItem[]) {
    const displayItems: DisplayItem[] = items.map(item => {
      const received = Number(item.received) || 0;
      const salesCat = item.sales_category || '自销自耗';
      const lines: AllocLine[] = suggestLines
        .filter(l => l.saleItemId === item.sale_item_id)
        .map(l => this.computeLine({
          saleItemId: item.sale_item_id,
          roleType: l.roleType || '',
          staffWfId: l.staffWfId || '',
          staffName: l.staffName || '',
          salesCategory: salesCat,
          ratioPercent: Math.round((l.allocationRatio || 0) * 100),
          commissionRate: l.commissionRate || 0,
          allocAmount: '0.00',
          commissionAmount: '0.00',
        }, received));
      return {
        sale_item_id: item.sale_item_id,
        product_name: item.product_name,
        received: item.received,
        sales_category: item.sales_category,
        allocLines: lines,
      };
    });
    this.setData({ displayItems });
    this.computeSummary();
  },

  
  restoreAllocations(allocations: AllocationRecord[], items: OrderItem[]) {
    const nameMap = new Map<string, string>();
    this.data.candidateEmployees.forEach(e => nameMap.set(e.staffWfId, e.name));

    const linesMap = new Map<string, AllocLine[]>();
    for (const alloc of allocations) {
      if (alloc.is_void) continue;
      const saleItemId = alloc.sale_item_id || '';
      const item = items.find(i => i.sale_item_id === saleItemId);
      const received = item ? Number(item.received) || 0 : 0;
      const salesCat = alloc.sales_category || item?.sales_category || '自销自耗';
      const roleType = alloc.role_type || '';
      const ratioPercent = Math.round((Number(alloc.allocation_ratio) || 0) * 100);
      const commissionRate = roleType ? this.lookupRate(roleType, salesCat, received) : 0;
      const employeeId = alloc.employee_id || '';
      const line = this.computeLine({
        saleItemId,
        roleType,
        staffWfId: employeeId,
        staffName: nameMap.get(employeeId) || alloc.employee_name || employeeId,
        salesCategory: salesCat,
        ratioPercent,
        commissionRate,
        allocAmount: '0.00',
        commissionAmount: '0.00',
      }, received);
      if (!linesMap.has(saleItemId)) linesMap.set(saleItemId, []);
      linesMap.get(saleItemId)!.push(line);
    }

    const displayItems: DisplayItem[] = items.map(item => ({
      sale_item_id: item.sale_item_id,
      product_name: item.product_name,
      received: item.received,
      sales_category: item.sales_category,
      allocLines: linesMap.get(item.sale_item_id) || [],
    }));

    this.setData({ displayItems });
    this.computeSummary();
  },

  
  onAddLine(e: WechatMiniprogram.TouchEvent) {
    const itemIdx = e.currentTarget.dataset.itemIdx as number;
    const di = this.data.displayItems[itemIdx];
    if (!di) return;
    const newLine: AllocLine = {
      saleItemId: di.sale_item_id,
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
    const updated = di.allocLines.filter((_: AllocLine, i: number) => i !== lineIdx);
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
    const received = Number(di.received) || 0;
    const line = di.allocLines[lineIdx];
    
    const commissionRate = this.lookupRate(roleType, line.salesCategory, received);
    const updated = this.computeLine(
      { ...line, roleType, staffWfId: '', staffName: '', commissionRate },
      received
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

  
  getFilteredEmployees(skillTag: string): CandidateEmployee[] {
    const { candidateEmployees, orderStoreId } = this.data;
    return candidateEmployees.filter(e => {
      if (!e.skills || !e.skills.includes(skillTag)) return false;
      return e.storeId === orderStoreId || !!e.isOnBusinessTrip;
    });
  },

  onEmployeeSelect(e: WechatMiniprogram.TouchEvent) {
    const staffWfId = e.currentTarget.dataset.staffWfId as string;
    const staffName = e.currentTarget.dataset.name as string;
    const { pickerItemIdx: itemIdx, pickerLineIdx: lineIdx, displayItems } = this.data;
    const di = displayItems[itemIdx];
    if (!di) { this.closeEmpPopup(); return; }
    const line = di.allocLines[lineIdx];
    
    const dup = di.allocLines.some((l: AllocLine, i: number) =>
      i !== lineIdx && l.roleType === line.roleType && l.staffWfId === staffWfId
    );
    if (dup) {
      wx.showToast({ title: '该员工已在同技能标签下分配', icon: 'none' });
      return;
    }
    const updated = { ...line, staffWfId, staffName };
    this.setData({
      [`displayItems[${itemIdx}].allocLines[${lineIdx}]`]: updated,
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
    const received = Number(di.received) || 0;
    const updated = this.computeLine({ ...di.allocLines[lineIdx], ratioPercent: percent }, received);
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
    const { summary, grandTotal, hasUnassigned } = _computeSummary(this.data.displayItems);
    this.setData({ summary, grandTotal, hasUnassigned });
  },

  
  async onSkipAllocation() {
    if (this.data.frozen) {
      wx.showToast({ title: '分配结果已冻结，如需修改请联系管理后台', icon: 'none' });
      return;
    }
    const res = await new Promise<WechatMiniprogram.ShowModalSuccessCallbackResult>(resolve => {
      wx.showModal({
        title: '确认',
        content: '确定标记该笔回款为无需分配吗？',
        success: resolve,
      });
    });
    if (!res.confirm) return;

    this.setData({ submitting: true });
    try {
      await callStaffApi('allocation.savePayment', {
        salePaymentId: this.data.salePaymentId,
        allocations: [],
      });
      wx.showToast({ title: '已标记为无需分配', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '操作失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  async onSave() {
    if (this.data.submitting) return;
    if (this.data.frozen) {
      wx.showToast({ title: '分配结果已冻结，如需修改请联系管理后台', icon: 'none' });
      return;
    }
    const { displayItems, salePaymentId } = this.data;

    
    const effectiveLines: AllocLine[] = [];
    let hasPartial = false;
    for (const di of displayItems) {
      for (const l of di.allocLines) {
        const filled = l.roleType && l.staffWfId && l.ratioPercent > 0;
        if (filled) {
          effectiveLines.push(l);
        } else if (l.roleType || l.staffWfId || l.ratioPercent > 0) {
          hasPartial = true;
        }
      }
    }

    if (hasPartial) {
      wx.showToast({ title: '请填写完整的分配信息（技能标签、员工、分配比例）', icon: 'none' });
      return;
    }

    if (effectiveLines.length === 0) {
      await this.onSkipAllocation();
      return;
    }

    
    const pools = new Map<string, AllocLine[]>();
    for (const l of effectiveLines) {
      const key = `${l.saleItemId}|${l.roleType}`;
      if (!pools.has(key)) pools.set(key, []);
      pools.get(key)!.push(l);
    }
    for (const [, pool] of pools) {
      if (pool.length > MAX_PER_POOL) {
        wx.showToast({ title: `每个商品每个技能标签最多分配 ${MAX_PER_POOL} 人`, icon: 'none' });
        return;
      }
      const sum = pool.reduce((s, l) => s + l.ratioPercent, 0);
      if (sum > 100) {
        wx.showToast({ title: '同技能标签分配比例合计超过 100%', icon: 'none' });
        return;
      }
    }

    const allocations = effectiveLines.map(line => ({
      saleItemId: line.saleItemId,
      employeeId: line.staffWfId,
      roleType: line.roleType,
      allocationRatio: line.ratioPercent / 100,
      totalAmount: parseFloat(line.allocAmount) || 0,
    }));

    this.setData({ submitting: true });
    try {
      await callStaffApi('allocation.savePayment', { salePaymentId, allocations });
      wx.showToast({ title: '分配已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '保存失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
