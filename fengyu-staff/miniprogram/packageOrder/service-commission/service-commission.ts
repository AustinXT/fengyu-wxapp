// packageOrder/service-commission/service-commission.ts — 服务提成分配
// 交互对齐 admin / 销售提成：每行「先选技能标签 → 选有该技能的员工 → 选分配比例」，
// 自动派生 提成%（只读）/ 分配额(=consumeBase×比例) / 提成额(=fixedFee+consumeAmount)。
import { callStaffApi } from '../../utils/cloud';
import { requireManager } from '../../utils/role';
import {
  lookupServiceRate, computeServiceLine, computeServiceSummary, effServiceConsumeBase, ServiceRateRow,
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
  unit: string;
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
  // 历史数据可能为 null（建单初值无 DB default）；云函数已 COALESCE 成「待分配」
  commission_status: string | null;
  customer_name: string | null;
  employee_name: string | null;
  frozen?: boolean; // 完成超 3 天冻结
}

/** 候选员工（本店 ∪ 任意市场出差员工，供按技能筛选） */
interface CandidateEmployee {
  staffWfId: string;
  name: string;
  storeId: string;
  storeName: string;
  marketName: string;
  skills: string[];
  department: string;
  assignmentScope: 'local' | 'same_market_trip' | 'cross_market_trip';
  /** 是否出差支援；仅在营业额/服务提成分配中允许跨店 */
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
  roleType: string;        // 技能标签（''=未选）
  staffWfId: string;       // 员工（''=未选）
  staffName: string;
  salesCategory: string;
  ratioPercent: number;    // 分配比例（0=未选，10~100 整十）
  commissionRate: number;  // 提成比例，只读，按 roleType+salesCat+consumeBase 查表
  allocAmount: string;     // 分配额 = consumeBase × 比例
  commissionAmount: string; // 提成额 = fixedFee + consumeAmount
  priceThreshold: number;   // #379 命中矩阵行的划卡单价阈值（0=不启用）
  thresholdApplied: boolean; // 本行提成是否按阈值计（wxml 提示用）
}

interface DisplayItem {
  service_item_id: string;
  product_name: string;
  sales_category: string | null;
  session_used: number;
  unit: string;
  perSession: number;   // 单次实价 unit_real_price（#379 阈值比较用）
  consumeBase: number;  // unit_real_price × session_used（整池基数）
  fixedFeeBase: number; // service_fee × session_used（整池）
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
    frozen: false, // 完成超 3 天冻结，禁止修改分配
    // 汇总
    summary: [] as Array<{ staffName: string; department: string; total: string }>,
    grandTotal: '0.00',
    // ---- 选择器 ----
    pickerItemIdx: -1,
    pickerLineIdx: -1,
    skillSheetVisible: false,
    // 技能标签下拉选项：init 时从 staff.skillTags（skill_tags 字典表）动态拉取
    skillSheetActions: [] as Array<{ name: string }>,
    ratioSheetVisible: false,
    ratioSheetActions: [...RATIO_OPTIONS.map(p => ({ name: `${p}%`, value: p })), { name: '✎ 自定义比例', value: '__custom' }],
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

      this.setData({ rates }); // computeLine 依赖 data.rates

      const displayItems: DisplayItem[] = (detailData.items || []).map(item => {
        const sessionUsed = Number(item.session_used) || 0;
        const perSession = Number(item.unit_real_price || 0);
        const consumeBase = round2(perSession * sessionUsed);
        const fixedFeeBase = round2(Number(item.service_fee || 0) * sessionUsed);
        const salesCat = item.sales_category || '自销自耗';

        // 已分配回填：commissionRate 用 lookupServiceRate 重算（与销售页恢复口径一致）
        const lines: CommLine[] = (existingByItem.get(item.service_item_id) || []).map(c => {
          const ratioPercent = Number(((Number(c.allocation_ratio) || 0) * 100).toFixed(1));
          const roleType = c.role_type || '';
          const hit = roleType ? lookupServiceRate(roleType, salesCat, consumeBase, rates) : { rate: 0, priceThreshold: 0 };
          return this.computeLine({
            serviceItemId: item.service_item_id,
            roleType,
            staffWfId: c.employee_id,
            staffName: staffNameMap.get(c.employee_id) || c.employee_name || c.employee_id,
            salesCategory: salesCat,
            ratioPercent,
            commissionRate: hit.rate,
            priceThreshold: hit.priceThreshold,
            allocAmount: '0.00',
            commissionAmount: '0.00',
            thresholdApplied: false,
          }, { perSession, session_used: sessionUsed, consumeBase, fixedFeeBase });
        });

        return {
          service_item_id: item.service_item_id,
          product_name: item.product_name,
          sales_category: item.sales_category,
          session_used: sessionUsed,
          unit: item.unit || '次',
          perSession,
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

  /** 重算单行：分配额 = consumeBase×比例；提成额 = fixedFee + consumeAmount（#379 消耗部分按 max(单价, 阈值) 计） */
  computeLine(
    line: CommLine,
    di: Pick<DisplayItem, 'perSession' | 'session_used' | 'consumeBase' | 'fixedFeeBase'>
  ): CommLine {
    const rate = line.commissionRate || 0;
    const effConsumeBase = effServiceConsumeBase(di.perSession, di.session_used, line.priceThreshold);
    const { allocAmount, commissionAmount } = computeServiceLine(
      di.consumeBase, di.fixedFeeBase, line.ratioPercent / 100, rate, effConsumeBase
    );
    const thresholdApplied = rate > 0 && line.priceThreshold > di.perSession;
    return { ...line, allocAmount, commissionAmount, thresholdApplied };
  },

  /** 按技能过滤后保持「本店 → 本市场出差 → 跨市场出差」顺序。 */
  getFilteredEmployees(skillTag: string): CandidateEmployee[] {
    const rank = { local: 0, same_market_trip: 1, cross_market_trip: 2 };
    return this.data.candidateEmployees
      .filter(e => e.skills?.includes(skillTag))
      .sort((a, b) => rank[a.assignmentScope] - rank[b.assignmentScope]);
  },

  /** 添加一条空分配行 */
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
      priceThreshold: 0,
      allocAmount: '0.00',
      commissionAmount: '0.00',
      thresholdApplied: false,
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
    // 切换技能：清空已选员工 + 重查提成比例
    const hit = lookupServiceRate(roleType, line.salesCategory, di.consumeBase, this.data.rates);
    const updated = this.computeLine(
      { ...line, roleType, staffWfId: '', staffName: '', commissionRate: hit.rate, priceThreshold: hit.priceThreshold },
      di
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

  onEmployeeSelect(e: WechatMiniprogram.TouchEvent) {
    const staffWfId = e.currentTarget.dataset.staffWfId as string;
    const staffName = e.currentTarget.dataset.name as string;
    const { pickerItemIdx: itemIdx, pickerLineIdx: lineIdx, displayItems } = this.data;
    const di = displayItems[itemIdx];
    if (!di) { this.closeEmpPopup(); return; }
    const line = di.allocLines[lineIdx];
    // 防重复：同 item 同技能标签池内不重复员工
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
    const updated = this.computeLine(
      { ...di.allocLines[lineIdx], ratioPercent: percent },
      di
    );
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
    const percent = Number(val.toFixed(1));
    const updated = this.computeLine(
      { ...di.allocLines[lineIdx], ratioPercent: percent },
      di
    );
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

    // 收集完整行（技能标签 + 员工 + 分配比例 三者齐全）
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

    // 前端轻量预校验：同 (serviceItemId, roleType) 池 ≤3 人 / 比例合计 ≤100%
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
      // 容差 0.01%：仅吸收浮点漂移，不放过 ≥0.1% 真实超额（与后端 ratioSum>1.0001 同口径）
      const pct = pool.reduce((s, c) => s + c.allocationRatio * 100, 0);
      if (pct > 100.01) {
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
