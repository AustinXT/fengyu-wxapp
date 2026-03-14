// packageOrder/revenue-allocation/revenue-allocation.ts — 提成分配（支付后）
import { callStaffApi } from '../../utils/cloud';
import { requireManager } from '../../utils/role';
import { lookupRate as _lookupRate, computeSummary as _computeSummary } from '../../utils/allocation-calc';

interface OrderItem {
  sale_item_id: string;
  spu_name: string;
  sku_display_name: string;
  receivable: string;
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
    members: Array<{ staffWfId: string; name: string; position: string; department: string }>;
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
}

/** 每个 item × person 的分配行 */
interface AllocLine {
  saleItemId: string;
  department: string;
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
  spu_name: string;
  sku_display_name: string;
  receivable: string;
  sales_category: string | null;
  allocLines: AllocLine[];
}

/** 选人弹窗分组 */
interface PickerGroup {
  department: string;
  members: StaffInfo[];
}

Page({
  data: {
    loading: false,
    submitting: false,
    saleOrderId: '',
    order: null as any,
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
    orderSource: '' as string,
  },

  onLoad(options: Record<string, string>) {
    if (!requireManager()) {
      wx.navigateBack();
      return;
    }
    const saleOrderId = options.orderNo || options.orderId;
    if (saleOrderId) {
      this.setData({ saleOrderId });
      this.init(saleOrderId);
    }
  },

  async init(saleOrderId: string) {
    this.setData({ loading: true });
    try {
      const [suggestData, deptResponse, orderData] = await Promise.all([
        callStaffApi<any>('allocation.suggest', { orderNo: saleOrderId }),
        callStaffApi<DeptApiResponse>('staff.departments'),
        callStaffApi<any>('order.detail', { orderNo: saleOrderId }),
      ]);

      const order = orderData.order;
      const items: OrderItem[] = suggestData.items || orderData.items || [];
      const totalAmount = suggestData.totalAmount || Number(order.totalAmount) || 0;
      const isAllocated = order.allocation_status === 'allocated';
      const rates: RateRow[] = suggestData.rates || [];
      const beautyRates: Record<string, Record<string, number>> = suggestData.beautyRates || {};

      // 构建全量员工列表（扁平化）
      const allStaffList: StaffInfo[] = [];
      const pickerGroups: PickerGroup[] = [];
      for (const d of (deptResponse.departments || [])) {
        const members: StaffInfo[] = (d.members || []).map((s: any) => ({
          staffWfId: s.staffWfId,
          staffName: s.name || '',
          department: d.departmentName,
        }));
        allStaffList.push(...members);
        pickerGroups.push({ department: d.departmentName, members });
      }

      // suggest 上下文
      const isNewCustomer = suggestData.isNewCustomer || false;
      const beauticianInfo = suggestData.beauticianInfo || null;
      const deptAnomalous = suggestData.deptAnomalous || false;
      const orderSource = suggestData.orderSource || '';

      const suggestLines: AllocLine[] = suggestData.allocLines || [];

      // 构建 displayItems
      const displayItems: DisplayItem[] = items.map(item => ({
        sale_item_id: item.sale_item_id,
        spu_name: item.spu_name,
        sku_display_name: item.sku_display_name,
        receivable: item.receivable,
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
        orderSource,
        displayItems,
        loading: false,
      });

      if (isAllocated && orderData.allocations && orderData.allocations.length > 0) {
        this.restoreAllocations(orderData.allocations, items);
      } else {
        this.computeSummary();
      }
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  /** 根据部门+销售分类查提成比例并计算金额 */
  lookupRate(dept: string, salesCat: string, receivable: number): { commissionRate: number; amount: string } {
    return _lookupRate(dept, salesCat, receivable, this.data.beautyRates, this.data.rates, this.data.totalAmount);
  },

  /** 打开选人弹窗 */
  onAddPerson(e: WechatMiniprogram.TouchEvent) {
    const saleItemId = e.currentTarget.dataset.saleItemId as string;
    this.setData({ pickerVisible: true, pickerSaleItemId: saleItemId });
  },

  /** 选中员工 */
  onStaffSelected(e: WechatMiniprogram.TouchEvent) {
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

    const salesCat = item.sales_category || '自采自销';
    const receivable = Number(item.receivable) || 0;
    const { commissionRate, amount } = this.lookupRate(department, salesCat, receivable);

    const newLine: AllocLine = {
      saleItemId: pickerSaleItemId,
      department,
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

  /** 从已有分配记录恢复到 displayItems */
  restoreAllocations(allocations: any[], items: OrderItem[]) {
    // 构建员工名映射
    const staffMap = new Map<string, string>();
    this.data.allStaffList.forEach(s => staffMap.set(s.staffWfId, s.staffName));

    // 按 saleItemId 收集分配行
    const linesMap = new Map<string, AllocLine[]>();
    for (const alloc of allocations) {
      if (alloc.isVoid) continue;
      for (const ai of (alloc.items || [])) {
        const saleItemId = ai.saleItemId || '';
        const line: AllocLine = {
          saleItemId,
          department: alloc.department || '',
          staffWfId: alloc.employeeId || '',
          staffName: staffMap.get(alloc.employeeId) || alloc.employeeId || '',
          salesCategory: ai.category || '',
          commissionRate: Number(ai.commissionRate) || 0,
          amount: String(Number(ai.amount).toFixed(2)),
          autoAmount: String(Number(ai.amount).toFixed(2)),
          autoFilled: false,
        };
        if (!linesMap.has(saleItemId)) linesMap.set(saleItemId, []);
        linesMap.get(saleItemId)!.push(line);
      }
    }

    // 重建 displayItems
    const displayItems: DisplayItem[] = items.map(item => ({
      sale_item_id: item.sale_item_id,
      spu_name: item.spu_name,
      sku_display_name: item.sku_display_name,
      receivable: item.receivable,
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
        orderNo: this.data.saleOrderId,
        allocations: [],
      });
      wx.showToast({ title: '已标记为无需分配', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (err: any) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  async onSave() {
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

    // 按 employeeId + department 聚合（payload 格式不变）
    const allocMap = new Map<string, {
      employeeId: string;
      department: string;
      items: Array<{
        saleItemId: string;
        salesCategory: string;
        commissionRate: number;
        amount: number;
      }>;
    }>();

    for (const line of effectiveLines) {
      const key = `${line.staffWfId}_${line.department}`;
      let entry = allocMap.get(key);
      if (!entry) {
        entry = {
          employeeId: line.staffWfId,
          department: line.department,
          items: [],
        };
        allocMap.set(key, entry);
      }
      entry.items.push({
        saleItemId: line.saleItemId,
        salesCategory: line.salesCategory,
        commissionRate: line.commissionRate,
        amount: parseFloat(line.amount) || 0,
      });
    }

    const allocations = Array.from(allocMap.values());

    this.setData({ submitting: true });
    try {
      await callStaffApi('allocation.save', { orderNo: saleOrderId, allocations });
      wx.showToast({ title: '分配已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (err: any) {
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
