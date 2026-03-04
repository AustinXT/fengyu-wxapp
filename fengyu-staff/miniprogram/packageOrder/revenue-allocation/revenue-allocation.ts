// packageOrder/revenue-allocation/revenue-allocation.ts — 提成分配（支付后）
import { callStaffApi } from '../../utils/cloud';
import { requireManager } from '../../utils/role';

interface OrderItem {
  item_flow_no: string;
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
  serviceRates: Record<string, number>;
}

interface DeptStaff {
  department: string;
  staffList: Array<{ staffWfId: string; staffName: string; }>;
}

interface DeptApiResponse {
  departments: Array<{
    departmentName: string;
    members: Array<{ staffWfId: string; name: string; position: string; department: string }>;
  }>;
}

/** 每个 item × department 的分配行 */
interface AllocLine {
  itemFlowNo: string;
  department: string;
  staffWfId: string;
  staffName: string;
  salesCategory: string;
  commissionRate: number;
  amount: string; // 可手动覆盖
  autoAmount: string; // 自动计算值
}

Page({
  data: {
    loading: false,
    submitting: false,
    orderNo: '',
    order: null as any,
    items: [] as OrderItem[],
    totalAmount: 0,
    deptStaffList: [] as DeptStaff[],
    rates: [] as RateRow[],
    allocLines: [] as AllocLine[],
    // 汇总
    summary: [] as Array<{ staffName: string; department: string; total: string }>,
    grandTotal: '0.00',
    // 已分配状态
    isAllocated: false,
    // 员工选择器
    showPicker: false,
    pickerLineIndex: -1,
    pickerColumns: [] as string[],
    pickerStaffList: [] as Array<{ staffWfId: string; staffName: string }>,
  },

  onLoad(options: Record<string, string>) {
    if (!requireManager()) {
      wx.navigateBack();
      return;
    }
    const orderNo = options.orderNo || options.orderId;
    if (orderNo) {
      this.setData({ orderNo });
      this.init(orderNo);
    }
  },

  async init(orderNo: string) {
    this.setData({ loading: true });
    try {
      const [orderData, deptResponse] = await Promise.all([
        callStaffApi<any>('order.detail', { orderNo }),
        callStaffApi<DeptApiResponse>('staff.departments'),
      ]);

      const order = orderData.order;
      const items: OrderItem[] = orderData.items || [];
      const totalAmount = Number(order.totalAmount) || 0;
      const isAllocated = order.allocation_status === 'allocated';

      // 按部门分组员工
      const deptStaffList: DeptStaff[] = (deptResponse.departments || []).map((d: any) => ({
        department: d.departmentName,
        staffList: (d.members || []).map((s: any) => ({
          staffWfId: s.staffWfId,
          staffName: s.name || '',
        })),
      }));

      // 尝试获取提成比例
      let rates: RateRow[] = [];
      try {
        const rateData = await callStaffApi<{ rates: RateRow[] }>('allocation.rates', {
          marketName: order.market_name,
        });
        rates = rateData.rates || [];
      } catch (_) {
        console.warn('[allocation] 获取提成比例失败，使用手动模式');
      }

      this.setData({
        order,
        items,
        totalAmount,
        deptStaffList,
        rates,
        isAllocated,
        loading: false,
      });

      // 如果已有分配记录，恢复
      if (isAllocated && orderData.allocations && orderData.allocations.length > 0) {
        this.restoreAllocations(orderData.allocations, items);
      } else {
        // 自动生成分配行
        this.generateAllocLines(items, rates, totalAmount);
      }
    } catch (err: any) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  /** 从已有分配记录恢复 */
  restoreAllocations(allocations: any[], items: OrderItem[]) {
    const lines: AllocLine[] = [];
    for (const alloc of allocations) {
      if (alloc.isVoid) continue;
      for (const ai of (alloc.items || [])) {
        lines.push({
          itemFlowNo: ai.itemFlowNo || '',
          department: alloc.department || '',
          staffWfId: alloc.employeeId || '',
          staffName: '', // 会在下面补充
          salesCategory: ai.category || '',
          commissionRate: Number(ai.commissionRate) || 0,
          amount: String(Number(ai.amount).toFixed(2)),
          autoAmount: String(Number(ai.amount).toFixed(2)),
        });
      }
    }
    // 补充员工姓名
    const staffMap = new Map<string, string>();
    this.data.deptStaffList.forEach(d => {
      d.staffList.forEach(s => staffMap.set(s.staffWfId, s.staffName));
    });
    lines.forEach(l => {
      l.staffName = staffMap.get(l.staffWfId) || l.staffWfId;
    });
    this.setData({ allocLines: lines });
    this.computeSummary();
  },

  /** 根据 items × rates 自动生成分配行 */
  generateAllocLines(items: OrderItem[], rates: RateRow[], totalAmount: number) {
    const lines: AllocLine[] = [];

    for (const item of items) {
      const salesCat = item.sales_category || '自采自销';
      const receivable = Number(item.receivable) || 0;

      // 每个部门查找对应的提成比例
      const seenDepts = new Set<string>();
      for (const rate of rates) {
        const dept = rate.department;
        // 推广部有梯度：按订单总金额匹配区间
        if (dept === '推广部') {
          if (totalAmount < rate.amountMin || totalAmount > rate.amountMax) continue;
        }
        if (seenDepts.has(dept)) continue;

        const commRate = rate.orderRates[salesCat] || 0;
        if (commRate <= 0) continue; // 提成为0的不显示

        seenDepts.add(dept);
        const amount = (receivable * commRate).toFixed(2);

        lines.push({
          itemFlowNo: item.item_flow_no,
          department: dept,
          staffWfId: '',
          staffName: '',
          salesCategory: salesCat,
          commissionRate: commRate,
          amount,
          autoAmount: amount,
        });
      }
    }

    this.setData({ allocLines: lines });
    this.computeSummary();
  },

  computeSummary() {
    const lines = this.data.allocLines;
    // 按 staffWfId+department 聚合
    const map = new Map<string, { staffName: string; department: string; total: number }>();
    let grand = 0;
    for (const l of lines) {
      const amt = parseFloat(l.amount) || 0;
      grand += amt;
      if (l.staffWfId) {
        const key = `${l.staffWfId}_${l.department}`;
        const existing = map.get(key);
        if (existing) {
          existing.total += amt;
        } else {
          map.set(key, { staffName: l.staffName, department: l.department, total: amt });
        }
      }
    }
    const summary = Array.from(map.values()).map(s => ({
      staffName: s.staffName,
      department: s.department,
      total: s.total.toFixed(2),
    }));
    this.setData({
      summary,
      grandTotal: grand.toFixed(2),
    });
  },

  /** 获取某行对应的 item 显示名 */
  getItemName(itemFlowNo: string): string {
    const item = this.data.items.find(i => i.item_flow_no === itemFlowNo);
    return item ? (item.spu_name || item.sku_display_name || itemFlowNo) : itemFlowNo;
  },

  onTapStaff(e: WechatMiniprogram.TouchEvent) {
    const index = e.currentTarget.dataset.index as number;
    const line = this.data.allocLines[index];
    if (!line) return;

    // 找到该部门的员工列表
    const dept = this.data.deptStaffList.find(d => d.department === line.department);
    const staffList = dept ? dept.staffList : [];

    this.setData({
      showPicker: true,
      pickerLineIndex: index,
      pickerColumns: staffList.map(s => s.staffName),
      pickerStaffList: staffList,
    });
  },

  onPickerConfirm(e: WechatMiniprogram.CustomEvent) {
    const pickerIndex = e.detail.index as number;
    const staff = this.data.pickerStaffList[pickerIndex];
    if (!staff) return;
    const lines = [...this.data.allocLines];
    lines[this.data.pickerLineIndex] = {
      ...lines[this.data.pickerLineIndex],
      staffWfId: staff.staffWfId,
      staffName: staff.staffName,
    };
    this.setData({ allocLines: lines, showPicker: false, pickerLineIndex: -1 });
    this.computeSummary();
  },

  onPickerCancel() {
    this.setData({ showPicker: false, pickerLineIndex: -1 });
  },

  onAmountChange(e: WechatMiniprogram.CustomEvent) {
    const index = e.currentTarget.dataset.index as number;
    const lines = [...this.data.allocLines];
    lines[index] = { ...lines[index], amount: e.detail.value };
    this.setData({ allocLines: lines });
    this.computeSummary();
  },

  async onSave() {
    const { allocLines, orderNo } = this.data;

    // 校验：每行都要选员工
    const incomplete = allocLines.some(l => !l.staffWfId);
    if (incomplete) {
      wx.showToast({ title: '请为每一项选择员工', icon: 'none' });
      return;
    }

    // 组装 payload：按 employeeId + department 聚合
    const allocMap = new Map<string, {
      employeeId: string;
      department: string;
      items: Array<{
        itemFlowNo: string;
        salesCategory: string;
        commissionRate: number;
        amount: number;
      }>;
    }>();

    for (const line of allocLines) {
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
        itemFlowNo: line.itemFlowNo,
        salesCategory: line.salesCategory,
        commissionRate: line.commissionRate,
        amount: parseFloat(line.amount) || 0,
      });
    }

    const allocations = Array.from(allocMap.values());

    this.setData({ submitting: true });
    try {
      await callStaffApi('allocation.save', { orderNo, allocations });
      wx.showToast({ title: '分配已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (err: any) {
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
