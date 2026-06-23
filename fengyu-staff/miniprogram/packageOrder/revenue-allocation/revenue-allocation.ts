// packageOrder/revenue-allocation/revenue-allocation.ts — 提成分配（支付后）
// 交互对齐 admin：每行「先选技能标签 → 选有该技能的员工 → 选分配比例」，
// 自动派生 提成%（只读）/ 分配额(=实收×分配比例) / 提成额(=分配额×提成%)。
import { callStaffApi } from '../../utils/cloud';
import { requireManager } from '../../utils/role';
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

/** 候选员工（订单门店 ∪ 出差员工，供 admin 式按技能筛选） */
interface CandidateEmployee {
  staffWfId: string;
  name: string;
  storeId: string;
  storeName: string;
  skills: string[];
  department: string;
  /** 是否出差支援（跨门店共享）；true 时可跨门店被选中 */
  isOnBusinessTrip?: boolean;
}

/** 每个 item × person 的分配行 */
interface AllocLine {
  saleItemId: string;
  roleType: string;        // 技能标签（''=未选），分池校验键
  staffWfId: string;       // 员工（''=未选）
  staffName: string;
  salesCategory: string;
  ratioPercent: number;    // 分配比例（0=未选，10~100 整十）
  commissionRate: number;  // 提成比例，只读，按 roleType+salesCat 查表
  allocAmount: string;     // 分配额 = 实收 × 分配比例
  commissionAmount: string; // 提成额 = 分配额 × 提成比例
}

/** suggest 预建行（云函数下发） */
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

/** 展示用：item + 内嵌分配行 */
interface DisplayItem {
  sale_item_id: string;
  product_name: string;
  received: string;
  sales_category: string | null;
  allocLines: AllocLine[];
}

/** 订单摘要（分配页仅用到这几个字段） */
interface OrderSummary {
  saleOrderId: string;
  status: string;
  totalAmount: string;
  allocation_status: string;
  customer_name?: string;
  paid_at?: string;
}

/** allocation.suggest API 响应 */
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
  orderStoreId?: string;
  frozen?: boolean; // 支付超 3 天冻结
}

/** order.detail API 响应 */
interface OrderDetailResponse {
  order: OrderSummary;
  items: OrderItem[];
  allocations: AllocationRecord[];
}

/** 云函数返回的分配记录（snake_case） */
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
    saleOrderId: '',
    order: null as OrderSummary | null,
    items: [] as OrderItem[],
    totalAmount: 0,
    rates: [] as RateRow[],
    beautyRates: {} as Record<string, Record<string, number>>,
    // 候选员工（市场内）+ 订单门店（按技能筛选用）
    candidateEmployees: [] as CandidateEmployee[],
    orderStoreId: '',
    // items + 内嵌 allocLines 的展示数据
    displayItems: [] as DisplayItem[],
    // 汇总
    summary: [] as Array<{ staffName: string; department: string; total: string }>,
    grandTotal: '0.00',
    // 存在「填了技能标签/比例但未选员工」的行 → 提成额未计入汇总，提示店长补全
    hasUnassigned: false,
    // 已分配状态
    isAllocated: false,
    // 支付超 3 天冻结，禁止修改分配
    frozen: false,
    // suggest 上下文
    isNewCustomer: false,
    beauticianInfo: null as BeauticianInfo | null,
    deptAnomalous: false,
    // ---- 选择器 ----
    pickerItemIdx: -1,
    pickerLineIdx: -1,
    // 技能标签 action-sheet
    skillSheetVisible: false,
    // 技能标签下拉选项：init 时从 staff.skillTags（skill_tags 字典表）动态拉取
    skillSheetActions: [] as Array<{ name: string }>,
    // 分配比例 action-sheet
    ratioSheetVisible: false,
    ratioSheetActions: RATIO_OPTIONS.map(p => ({ name: `${p}%`, value: p })),
    // 员工选择 popup
    empPopupVisible: false,
    empPopupList: [] as CandidateEmployee[],
    empPopupTitle: '选择员工',
  },

  onLoad(options: Record<string, string>) {
    if (!requireManager()) {
      wx.navigateBack();
      return;
    }
    const saleOrderId = options.saleOrderId;
    if (saleOrderId) {
      this.setData({ saleOrderId });
      this.init(saleOrderId);
    }
  },

  async init(saleOrderId: string) {
    this.setData({ loading: true });
    try {
      const [suggestData, orderData, skillTagData] = await Promise.all([
        callStaffApi<SuggestResponse>('allocation.suggest', { saleOrderId }),
        callStaffApi<OrderDetailResponse>('order.detail', { saleOrderId }),
        callStaffApi<{ skillTags: string[] }>('staff.skillTags', {}).catch(() => ({ skillTags: [] })),
      ]);

      const skillSheetActions = (skillTagData.skillTags || []).map(name => ({ name }));

      const order = orderData.order;
      const items: OrderItem[] = suggestData.items || orderData.items || [];
      const totalAmount = suggestData.totalAmount || Number(order.totalAmount) || 0;
      const isAllocated = order.allocation_status === '已分配';
      const rates: RateRow[] = suggestData.rates || [];
      const beautyRates: Record<string, Record<string, number>> =
        suggestData.ratesByRole || suggestData.beautyRates || {};
      const candidateEmployees = suggestData.candidateEmployees || [];
      const orderStoreId = suggestData.orderStoreId || '';

      // suggest 上下文
      const isNewCustomer = suggestData.isNewCustomer || false;
      const beauticianInfo = suggestData.beauticianInfo || null;
      const deptAnomalous = suggestData.deptAnomalous || false;

      this.setData({
        order,
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

      if (isAllocated && orderData.allocations && orderData.allocations.length > 0) {
        this.restoreAllocations(orderData.allocations, items);
      } else {
        this.buildSuggestedItems(suggestData.allocLines || [], items);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
      this.setData({ loading: false });
    }
  },

  /** 根据技能标签+销售分类查提成比例（只取 commissionRate） */
  lookupRate(roleType: string, salesCat: string, received: number): number {
    const { commissionRate } = _lookupRate(
      roleType, salesCat, received, this.data.beautyRates, this.data.rates, this.data.totalAmount
    );
    return commissionRate;
  },

  /** 计算单行的分配额/提成额（实收 × 分配比例，再 × 提成比例） */
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

  /** 用 suggest 预建行初始化（按 roleType+员工 预填，比例默认 100%） */
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

  /** 从已有分配记录恢复（补算 commissionRate / 金额） */
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

  /** 添加一条空分配行 */
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

  /** 移除分配行 */
  onRemoveLine(e: WechatMiniprogram.TouchEvent) {
    const itemIdx = e.currentTarget.dataset.itemIdx as number;
    const lineIdx = e.currentTarget.dataset.lineIdx as number;
    const di = this.data.displayItems[itemIdx];
    if (!di) return;
    const updated = di.allocLines.filter((_: AllocLine, i: number) => i !== lineIdx);
    this.setData({ [`displayItems[${itemIdx}].allocLines`]: updated });
    this.computeSummary();
  },

  // ---------- 技能标签 ----------
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
    // 切换技能：清空已选员工 + 重查提成比例
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

  // ---------- 员工 ----------
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

  /** 按技能筛选候选员工（跨门店共享 2026-06-24）：统一「订单门店 ∪ 出差员工」+ 技能匹配（取消市场级与品项老师特例） */
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
    // 防重复：同 item 同技能标签池内不重复员工
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

  // ---------- 分配比例 ----------
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

  /** 标记为无需分配 */
  async onSkipAllocation() {
    if (this.data.frozen) {
      wx.showToast({ title: '分配结果已冻结，如需修改请联系管理后台', icon: 'none' });
      return;
    }
    const res = await new Promise<WechatMiniprogram.ShowModalSuccessCallbackResult>(resolve => {
      wx.showModal({
        title: '确认',
        content: '确定标记该订单为无需分配吗？',
        success: resolve,
      });
    });
    if (!res.confirm) return;

    this.setData({ submitting: true });
    try {
      await callStaffApi('allocation.save', {
        saleOrderId: this.data.saleOrderId,
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
    const { displayItems, saleOrderId } = this.data;

    // 收集完整行（技能标签 + 员工 + 分配比例 三者齐全）
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

    // 前端轻量预校验：同 (saleItemId, roleType) 池 ≤3 人 / 比例合计 ≤100%
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
      await callStaffApi('allocation.save', { saleOrderId, allocations });
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
