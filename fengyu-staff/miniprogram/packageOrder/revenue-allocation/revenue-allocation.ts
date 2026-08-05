// packageOrder/revenue-allocation/revenue-allocation.ts — 提成分配（支付后）
// 交互对齐 admin：每行「先选技能标签 → 选有该技能的员工 → 选分配比例」，
// 自动派生 提成%（只读）/ 分配额(=实收×分配比例) / 提成额(=分配额×提成%)。
import { callStaffApi } from '../../utils/cloud';
import { requireManager } from '../../utils/role';
import { formatDateTime } from '../../utils/formatters';
import { lookupRate as _lookupRate, computeSummary as _computeSummary } from '../utils/allocation-calc';
import {
  calculateGroupedAmounts,
  expandGroupedAllocationLines,
  groupPaymentItems,
  type AllocationSignatureLine,
} from '../utils/allocation-group';

const RATIO_OPTIONS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const MAX_PER_POOL = 3;
let allocationLineSequence = 0;

function nextAllocationLineId(groupId: string): string {
  allocationLineSequence += 1;
  return `${groupId}:line:${allocationLineSequence}`;
}

interface OrderItem {
  sale_item_id: string;
  sku_id: string | null;
  product_name: string | null;
  received: string;
  sales_category: string | null;
  product_type: string | null;
  item_direction: string | null;
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
  lineId: string;
  groupId: string;
  saleItemIds: string[];
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
  groupId: string;
  saleItemIds: string[];
  sourceItems: OrderItem[];
  skuId: string | null;
  sourceCount: number;
  item_direction: string;
  product_name: string;
  product_type: string | null;
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

/** allocation.suggestPayment API 响应（按回款逐笔分配；items[].received 为该笔回款逐项可分配额） */
interface SuggestResponse {
  items: OrderItem[];
  totalAmount: number;       // = 本次回款额（eventAmount）
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
  frozen?: boolean; // 到账超 3 天冻结
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
    // 按回款逐笔分配：本页以一笔回款（sale_payment_id）为单元
    salePaymentId: 0,
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
    ratioSheetActions: [...RATIO_OPTIONS.map(p => ({ name: `${p}%`, value: p })), { name: '✎ 自定义比例', value: '__custom' }],
    // 员工选择 popup
    empPopupVisible: false,
    empPopupList: [] as CandidateEmployee[],
    empPopupTitle: '选择员工',
    // 自定义分配比例输入弹层
    customRatioVisible: false,
    customRatioInput: '',
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

      // suggestPayment 自带订单/回款上下文，合成 order 摘要（不再单独拉 order.detail）
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
        // paidAt 是 timestamp 列(UTC ISO)，格式化为 YYYY-MM-DD HH:mm:ss 再展示（WXML 原裸绑定会显示 ISO）
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

  /** 根据技能标签+销售分类查提成比例（只取 commissionRate） */
  lookupRate(roleType: string, salesCat: string, received: number): number {
    const { commissionRate } = _lookupRate(
      roleType, salesCat, received, this.data.beautyRates, this.data.rates, this.data.totalAmount
    );
    return commissionRate;
  },

  /** 逐 source item 四舍五入后汇总，保持展示结果与逐 receipt 保存一致。 */
  computeLine(line: AllocLine, sourceItems: OrderItem[]): AllocLine {
    const { allocatedAmount, commissionAmount } = calculateGroupedAmounts(
      sourceItems,
      line.ratioPercent / 100,
      line.commissionRate || 0,
    );
    return {
      ...line,
      allocAmount: allocatedAmount,
      commissionAmount,
    };
  },

  /** 用 suggest 预建行初始化（按 roleType+员工 预填，比例默认 100%） */
  buildSuggestedItems(suggestLines: SuggestLine[], items: OrderItem[]) {
    const suggestionLinesByItem = new Map<string, SuggestLine[]>();
    const signaturesByItem = new Map<string, AllocationSignatureLine[]>();
    for (const line of suggestLines) {
      const lines = suggestionLinesByItem.get(line.saleItemId) || [];
      lines.push(line);
      suggestionLinesByItem.set(line.saleItemId, lines);

      const signatures = signaturesByItem.get(line.saleItemId) || [];
      signatures.push({
        employeeId: line.staffWfId,
        roleType: line.roleType,
        allocationRatio: line.allocationRatio,
      });
      signaturesByItem.set(line.saleItemId, signatures);
    }

    const displayItems: DisplayItem[] = groupPaymentItems(items, signaturesByItem).map(group => {
      const lines: AllocLine[] = (suggestionLinesByItem.get(group.saleItemIds[0]) || []).map((line) =>
        this.computeLine({
          lineId: nextAllocationLineId(group.groupId),
          groupId: group.groupId,
          saleItemIds: group.saleItemIds,
          roleType: line.roleType || '',
          staffWfId: line.staffWfId || '',
          staffName: line.staffName || '',
          salesCategory: group.salesCategory,
          ratioPercent: Number(((line.allocationRatio || 0) * 100).toFixed(1)),
          commissionRate: line.commissionRate || 0,
          allocAmount: '0.00',
          commissionAmount: '0.00',
        }, group.sourceItems)
      );
      return {
        groupId: group.groupId,
        saleItemIds: group.saleItemIds,
        sourceItems: group.sourceItems,
        skuId: group.skuId,
        sourceCount: group.sourceCount,
        item_direction: group.itemDirection,
        product_name: group.productName,
        product_type: group.productType,
        received: group.received.toFixed(2),
        sales_category: group.salesCategory,
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

    const allocationsByItem = new Map<string, AllocationRecord[]>();
    const signaturesByItem = new Map<string, AllocationSignatureLine[]>();
    for (const alloc of allocations) {
      if (alloc.is_void) continue;
      const saleItemId = alloc.sale_item_id || '';
      if (!saleItemId) continue;
      const itemAllocations = allocationsByItem.get(saleItemId) || [];
      itemAllocations.push(alloc);
      allocationsByItem.set(saleItemId, itemAllocations);

      const signatures = signaturesByItem.get(saleItemId) || [];
      signatures.push({
        employeeId: alloc.employee_id,
        roleType: alloc.role_type,
        allocationRatio: alloc.allocation_ratio,
      });
      signaturesByItem.set(saleItemId, signatures);
    }

    const displayItems: DisplayItem[] = groupPaymentItems(items, signaturesByItem).map(group => {
      const groupAllocations = allocationsByItem.get(group.saleItemIds[0]) || [];
      const lines = groupAllocations.map((alloc) => {
        const roleType = alloc.role_type || '';
        const employeeId = alloc.employee_id || '';
        const ratioPercent = Number(((Number(alloc.allocation_ratio) || 0) * 100).toFixed(1));
        const commissionRate = roleType
          ? this.lookupRate(roleType, group.salesCategory, group.received)
          : 0;
        return this.computeLine({
          lineId: nextAllocationLineId(group.groupId),
          groupId: group.groupId,
          saleItemIds: group.saleItemIds,
          roleType,
          staffWfId: employeeId,
          staffName: nameMap.get(employeeId) || alloc.employee_name || employeeId,
          salesCategory: group.salesCategory,
          ratioPercent,
          commissionRate,
          allocAmount: '0.00',
          commissionAmount: '0.00',
        }, group.sourceItems);
      });
      return {
        groupId: group.groupId,
        saleItemIds: group.saleItemIds,
        sourceItems: group.sourceItems,
        skuId: group.skuId,
        sourceCount: group.sourceCount,
        item_direction: group.itemDirection,
        product_name: group.productName,
        product_type: group.productType,
        received: group.received.toFixed(2),
        sales_category: group.salesCategory,
        allocLines: lines,
      };
    });

    this.setData({ displayItems });
    this.computeSummary();
  },

  /** 添加一条空分配行 */
  onAddLine(e: WechatMiniprogram.TouchEvent) {
    const itemIdx = e.currentTarget.dataset.itemIdx as number;
    const di = this.data.displayItems[itemIdx];
    if (!di) return;
    const newLine: AllocLine = {
      lineId: nextAllocationLineId(di.groupId),
      groupId: di.groupId,
      saleItemIds: di.saleItemIds,
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
    const line = di.allocLines[lineIdx];
    if (!line) { this.closeSkillSheet(); return; }
    // 切换技能：清空已选员工 + 重查提成比例
    const commissionRate = this.lookupRate(roleType, line.salesCategory, Number(di.received) || 0);
    const updated = this.computeLine(
      { ...line, roleType, staffWfId: '', staffName: '', commissionRate },
      di.sourceItems
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
    if (!line) { this.closeEmpPopup(); return; }
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
    this.computeSummary();
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
    const detail = e.detail as { value: number | string };
    // 「自定义比例」→ 关闭档位面板，打开数字输入弹层（保留 pickerItemIdx/LineIdx）
    if (detail.value === '__custom') {
      this.setData({ ratioSheetVisible: false, customRatioVisible: true, customRatioInput: '' });
      return;
    }
    const percent = detail.value as number;
    const { pickerItemIdx: itemIdx, pickerLineIdx: lineIdx, displayItems } = this.data;
    const di = displayItems[itemIdx];
    if (!di) { this.closeRatioSheet(); return; }
    const line = di.allocLines[lineIdx];
    if (!line) { this.closeRatioSheet(); return; }
    const updated = this.computeLine({ ...line, ratioPercent: percent }, di.sourceItems);
    this.setData({
      [`displayItems[${itemIdx}].allocLines[${lineIdx}]`]: updated,
      ratioSheetVisible: false,
    });
    this.computeSummary();
  },

  onCustomRatioInput(e: WechatMiniprogram.CustomEvent) {
    this.setData({ customRatioInput: String(e.detail ?? '') });
  },

  /** 自定义比例确认：校验 0 < x ≤ 100，精度对齐 DB scale 3（0.1% 粒度，保留 1 位小数） */
  onConfirmCustomRatio() {
    const raw = String(this.data.customRatioInput ?? '').trim();
    const val = Number(raw);
    if (!raw || isNaN(val) || val <= 0 || val > 100) {
      wx.showToast({ title: '请输入 0~100 之间的比例', icon: 'none' });
      return;
    }
    const { pickerItemIdx: itemIdx, pickerLineIdx: lineIdx, displayItems } = this.data;
    const di = displayItems[itemIdx];
    if (!di) { this.setData({ customRatioVisible: false, customRatioInput: '' }); return; }
    const line = di.allocLines[lineIdx];
    if (!line) { this.setData({ customRatioVisible: false, customRatioInput: '' }); return; }
    const percent = Number(val.toFixed(1));
    const updated = this.computeLine({ ...line, ratioPercent: percent }, di.sourceItems);
    this.setData({
      [`displayItems[${itemIdx}].allocLines[${lineIdx}]`]: updated,
      customRatioVisible: false,
      customRatioInput: '',
    });
    this.computeSummary();
  },

  closeCustomRatio() {
    this.setData({ customRatioVisible: false, customRatioInput: '' });
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
    if (this.data.submitting) return;
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

    // 前端轻量预校验：同 SKU 组的技能标签池 ≤3 人 / 比例合计 ≤100%
    const pools = new Map<string, AllocLine[]>();
    for (const l of effectiveLines) {
      const key = `${l.groupId}|${l.roleType}`;
      if (!pools.has(key)) pools.set(key, []);
      pools.get(key)!.push(l);
    }
    for (const [, pool] of pools) {
      if (pool.length > MAX_PER_POOL) {
        wx.showToast({ title: `每个商品每个技能标签最多分配 ${MAX_PER_POOL} 人`, icon: 'none' });
        return;
      }
      // 容差 0.01%：仅吸收浮点漂移，不放过 ≥0.1% 真实超额（与后端 ratioSum>1.0001 同口径）
      const sum = pool.reduce((s, l) => s + l.ratioPercent, 0);
      if (sum > 100.01) {
        wx.showToast({ title: '同技能标签分配比例合计超过 100%', icon: 'none' });
        return;
      }
    }

    // 展示层按 SKU 组编辑；提交前展开到每个独立 saleItemId，保持疗程卡实例独立。
    const allocations = expandGroupedAllocationLines(effectiveLines).map(line => ({
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
