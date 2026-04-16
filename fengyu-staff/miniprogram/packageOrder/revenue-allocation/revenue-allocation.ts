// packageOrder/revenue-allocation/revenue-allocation.ts — 提成分配（支付后）
import { callStaffApi } from '../../utils/cloud';
import { requireManager } from '../../utils/role';
import { lookupRate as _lookupRate, computeSummary as _computeSummary } from '../utils/allocation-calc';

interface OrderItem {
  sale_item_id: string;
  product_name: string;
  sku_spec_name: string;
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

interface DeptApiResponse {
  departments: Array<{
    departmentName: string;
    members: Array<{ staffWfId: string; name: string; position: string; department: string; skills?: string[] }>;
  }>;
}

interface BeauticianInfo {
  staffWfId: string;
  name: string;
  primaryDept: string;
  secondaryDept: string;
  resolvedDept: string | null;
}

interface StaffInfo {
  staffWfId: string;
  staffName: string;
  department: string;
  skills: string[]; // P2-14：用于推断 roleType
}

/** 每个 item × person 的分配行 */
interface AllocLine {
  saleItemId: string;
  department: string;
  roleType: string; // P2-14 Q5：技能标签，分池校验键
  staffWfId: string;
  staffName: string;
  salesCategory: string;
  commissionRate: number;
  amount: string;
  autoAmount: string;
  autoFilled: boolean;
}

/** 展示用：item + 内嵌分配行 */
interface DisplayItem {
  sale_item_id: string;
  product_name: string;
  sku_spec_name: string;
  received: string;
  sales_category: string | null;
  allocLines: AllocLine[];
}

/** 选人弹窗分组 */
interface PickerGroup {
  department: string;
  members: StaffInfo[];
}

/** 订单摘要（分配页仅用到这几个字段） */
interface OrderSummary {
  saleOrderId: string;
  status: string;
  totalAmount: string;
  allocation_status: string;
}

/** allocation.suggest API 响应（P2-14：ratesByRole 替代 beautyRates） */
interface SuggestResponse {
  items: OrderItem[];
  totalAmount: number;
  rates: RateRow[];
  ratesByRole?: Record<string, Record<string, number>>; // P2-14：以 roleType 为键
  beautyRates?: Record<string, Record<string, number>>; // 向后兼容（cloudfn 老版本）
  isNewCustomer: boolean;
  beauticianInfo: BeauticianInfo | null;
  deptAnomalous: boolean;
  allocLines: AllocLine[];
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
  role_type?: string; // P2-14
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
    // 全量员工（扁平）
    allStaffList: [] as StaffInfo[],
    // 按部门分组（选人弹窗用）
    pickerGroups: [] as PickerGroup[],
    // items + 内嵌 allocLines 的展示数据
    displayItems: [] as DisplayItem[],
    // 选人弹窗
    pickerVisible: false,
    pickerSaleItemId: '',
    // 汇总
    summary: [] as Array<{ staffName: string; department: string; total: string }>,
    grandTotal: '0.00',
    // 已分配状态
    isAllocated: false,
    // suggest 上下文
    isNewCustomer: false,
    beauticianInfo: null as BeauticianInfo | null,
    deptAnomalous: false,
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
      const [suggestData, deptResponse, orderData] = await Promise.all([
        callStaffApi<SuggestResponse>('allocation.suggest', { saleOrderId }),
        callStaffApi<DeptApiResponse>('staff.departments'),
        callStaffApi<OrderDetailResponse>('order.detail', { saleOrderId }),
      ]);

      const order = orderData.order;
      const items: OrderItem[] = suggestData.items || orderData.items || [];
      const totalAmount = suggestData.totalAmount || Number(order.totalAmount) || 0;
      const isAllocated = order.allocation_status === '已分配';
      const rates: RateRow[] = suggestData.rates || [];
      // P2-14：cloudfn 新返回 ratesByRole，老版本可能仍返回 beautyRates
      const beautyRates: Record<string, Record<string, number>> =
        suggestData.ratesByRole || suggestData.beautyRates || {};

      // 构建全量员工列表（扁平化）
      const allStaffList: StaffInfo[] = [];
      const pickerGroups: PickerGroup[] = [];
      for (const d of (deptResponse.departments || [])) {
        const members: StaffInfo[] = (d.members || []).map((s) => ({
          staffWfId: s.staffWfId,
          staffName: s.name || '',
          department: d.departmentName,
          skills: Array.isArray(s.skills) ? s.skills : [], // P2-14
        }));
        allStaffList.push(...members);
        pickerGroups.push({ department: d.departmentName, members });
      }

      // suggest 上下文
      const isNewCustomer = suggestData.isNewCustomer || false;
      const beauticianInfo = suggestData.beauticianInfo || null;
      const deptAnomalous = suggestData.deptAnomalous || false;

      const suggestLines: AllocLine[] = suggestData.allocLines || [];

      // 构建 displayItems
      const displayItems: DisplayItem[] = items.map(item => ({
        sale_item_id: item.sale_item_id,
        product_name: item.product_name,
        sku_spec_name: item.sku_spec_name,
        received: item.received,
        sales_category: item.sales_category,
        allocLines: suggestLines.filter(l => l.saleItemId === item.sale_item_id),
      }));

      this.setData({
        order,
        items,
        totalAmount,
        allStaffList,
        pickerGroups,
        beautyRates,
        rates,
        isAllocated,
        isNewCustomer,
        beauticianInfo,
        deptAnomalous,
        displayItems,
        loading: false,
      });

      if (isAllocated && orderData.allocations && orderData.allocations.length > 0) {
        this.restoreAllocations(orderData.allocations, items);
      } else {
        this.computeSummary();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
      this.setData({ loading: false });
    }
  },

  /** 根据部门+销售分类查提成比例并计算金额 */
  lookupRate(dept: string, salesCat: string, received: number): { commissionRate: number; amount: string } {
    return _lookupRate(dept, salesCat, received, this.data.beautyRates, this.data.rates, this.data.totalAmount);
  },

  /** 打开选人弹窗 */
  onAddPerson(e: WechatMiniprogram.TouchEvent) {
    const saleItemId = e.currentTarget.dataset.saleItemId as string;
    this.setData({ pickerVisible: true, pickerSaleItemId: saleItemId });
  },

  /** 选中员工（P2-14 Q5：按 skills 推断 roleType） */
  async onStaffSelected(e: WechatMiniprogram.TouchEvent) {
    const staffWfId = e.currentTarget.dataset.staffWfId as string;
    const department = e.currentTarget.dataset.department as string;
    const { pickerSaleItemId, displayItems, allStaffList } = this.data;

    // 查找 displayItem
    const diIdx = displayItems.findIndex(d => d.sale_item_id === pickerSaleItemId);
    if (diIdx < 0) return;

    const di = displayItems[diIdx];

    // 防重复：同一 item 不添加同一人
    if (di.allocLines.some(l => l.staffWfId === staffWfId)) {
      wx.showToast({ title: '该员工已添加', icon: 'none' });
      return;
    }

    // 查员工信息
    const staff = allStaffList.find(s => s.staffWfId === staffWfId && s.department === department);
    if (!staff) return;

    // 查找对应 item
    const item = this.data.items.find(i => i.sale_item_id === pickerSaleItemId);
    if (!item) return;

    // P2-14 Q5：从员工 skills 推断 roleType
    // - 0 个 skill：提示管理员补资料后退出
    // - 1 个 skill：自动填
    // - 多个 skill：弹 actionSheet 让用户选
    let roleType = ''
    if (!staff.skills || staff.skills.length === 0) {
      wx.showToast({ title: `${staff.staffName} 暂无技能标签，请联系管理员补录`, icon: 'none', duration: 2500 });
      return;
    } else if (staff.skills.length === 1) {
      roleType = staff.skills[0];
    } else {
      try {
        const sheetRes = await wx.showActionSheet({ itemList: staff.skills });
        roleType = staff.skills[sheetRes.tapIndex];
      } catch (_e) {
        // 用户取消选择
        return;
      }
    }

    const salesCat = item.sales_category || '自采自销';
    const received = Number(item.received) || 0;
    // P2-14：传 roleType 给 lookupRate（cloudfn ratesByRole 以 roleType 为键）
    const { commissionRate, amount } = this.lookupRate(roleType, salesCat, received);

    const newLine: AllocLine = {
      saleItemId: pickerSaleItemId,
      department,
      roleType, // P2-14：必填
      staffWfId: staff.staffWfId,
      staffName: staff.staffName,
      salesCategory: salesCat,
      commissionRate,
      amount,
      autoAmount: amount,
      autoFilled: false,
    };

    // 更新 displayItems
    const path = `displayItems[${diIdx}].allocLines`;
    const updatedLines = [...di.allocLines, newLine];
    this.setData({
      [path]: updatedLines,
      pickerVisible: false,
      pickerSaleItemId: '',
    });
    this.computeSummary();
  },

  /** 移除已添加人员 */
  onRemovePerson(e: WechatMiniprogram.TouchEvent) {
    const itemIdx = e.currentTarget.dataset.itemIdx as number;
    const lineIdx = e.currentTarget.dataset.lineIdx as number;
    const di = this.data.displayItems[itemIdx];
    if (!di) return;

    const updatedLines = di.allocLines.filter((_: AllocLine, i: number) => i !== lineIdx);
    this.setData({ [`displayItems[${itemIdx}].allocLines`]: updatedLines });
    this.computeSummary();
  },

  /** 关闭选人弹窗 */
  onPickerClose() {
    this.setData({ pickerVisible: false, pickerSaleItemId: '' });
  },

  onAmountChange(e: WechatMiniprogram.CustomEvent) {
    const itemIdx = e.currentTarget.dataset.itemIdx as number;
    const lineIdx = e.currentTarget.dataset.lineIdx as number;
    const path = `displayItems[${itemIdx}].allocLines[${lineIdx}].amount`;
    this.setData({ [path]: e.detail.value });
    this.computeSummary();
  },

  /** 从已有分配记录恢复到 displayItems（云函数返回扁平结构） */
  restoreAllocations(allocations: AllocationRecord[], items: OrderItem[]) {
    // 构建员工名映射
    const staffMap = new Map<string, string>();
    this.data.allStaffList.forEach(s => staffMap.set(s.staffWfId, s.staffName));

    // 云函数返回扁平结构：每行 = { sale_item_id, employee_id, department_name, allocation_ratio, total_amount, is_void }
    const linesMap = new Map<string, AllocLine[]>();
    for (const alloc of allocations) {
      if (alloc.is_void) continue;
      const saleItemId = alloc.sale_item_id || '';
      const employeeId = alloc.employee_id || '';
      const dept = alloc.department_name || '';
      const amount = Number(alloc.total_amount || 0).toFixed(2);
      const line: AllocLine = {
        saleItemId,
        department: dept,
        roleType: alloc.role_type || '', // P2-14（历史记录可能为空字符串）
        staffWfId: employeeId,
        staffName: staffMap.get(employeeId) || alloc.employee_name || employeeId || '',
        salesCategory: alloc.sales_category || '',
        commissionRate: Number(alloc.allocation_ratio) || 0,
        amount,
        autoAmount: amount,
        autoFilled: false,
      };
      if (!linesMap.has(saleItemId)) linesMap.set(saleItemId, []);
      linesMap.get(saleItemId)!.push(line);
    }

    // 重建 displayItems
    const displayItems: DisplayItem[] = items.map(item => ({
      sale_item_id: item.sale_item_id,
      product_name: item.product_name,
      sku_spec_name: item.sku_spec_name,
      received: item.received,
      sales_category: item.sales_category,
      allocLines: linesMap.get(item.sale_item_id) || [],
    }));

    this.setData({ displayItems });
    this.computeSummary();
  },

  computeSummary() {
    const { summary, grandTotal } = _computeSummary(this.data.displayItems);
    this.setData({ summary, grandTotal });
  },

  /** 标记为无需分配 */
  async onSkipAllocation() {
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
    const { displayItems, saleOrderId } = this.data;

    // 从 displayItems 扁平化收集所有有效行
    const effectiveLines: AllocLine[] = [];
    for (const di of displayItems) {
      for (const l of di.allocLines) {
        if (l.staffWfId && l.department) {
          effectiveLines.push(l);
        }
      }
    }

    if (effectiveLines.length === 0) {
      await this.onSkipAllocation();
      return;
    }

    // 扁平化为云函数期望的格式：每行 = 一条 sale_item + 一个员工
    // P2-14 Q5：payload 必须携带 roleType；若某行 roleType 缺失（历史记录）则提示补录
    for (const line of effectiveLines) {
      if (!line.roleType) {
        wx.showToast({ title: `${line.staffName} 缺少技能标签，请删除后重选`, icon: 'none', duration: 2500 });
        return;
      }
    }
    const allocations = effectiveLines.map(line => ({
      saleItemId: line.saleItemId,
      employeeId: line.staffWfId,
      roleType: line.roleType, // P2-14：必填
      departmentName: line.department,
      allocationRatio: line.commissionRate,
      totalAmount: parseFloat(line.amount) || 0,
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
