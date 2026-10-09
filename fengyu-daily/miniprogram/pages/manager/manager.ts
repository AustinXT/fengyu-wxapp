import { decodeRouteId } from '../../utils/route';
import { callApi, showError, today, Employee, Management } from "../../utils/cloud";
interface Submission {
  id: string;
  employee_id: string;
  employee_name: string;
  submitted_at: string;
}
Page({
  data: {
    routeInvalid: false,
    date: today(),
    period: "today",
    range: null as Management["range"] | null,
    summary: null as Management["summary"] | null,
    employees: [] as Management["employees"],
    maxDate: today(),
    stores: [] as Employee["managerStores"],
    storeIndex: 0,
    reports: [] as Submission[],
    unsubmitted: [] as { employee_id: string; name: string }[],
    loading: false,
    ready: false,
    selectedStoreId: "",
    title: "门店日报",
    employeeRows: [] as (Management["employees"][number] & { directReportId: string })[],
  },
  onLoad(options: Record<string, string | undefined>) {
    const routeId = decodeRouteId(options.storeId);
    if (routeId === null) { this.setData({ routeInvalid: true }); return; }
    this.setData({ selectedStoreId: routeId, period: ["today", "week", "month"].includes(options.period || "") ? options.period! : "today" });
  },
  onShow() {
    void this.load();
  },
  async load() {
    if (this.data.loading || this.data.routeInvalid) return;
    this.setData({ loading: true, ready: false });
    try {
      const data = await callApi<{
        stores: Employee["managerStores"]; storeId: string;
        reports: Submission[];
        range: Management["range"]; summary: Management["summary"]; employees: Management["employees"];
        unsubmitted: { employee_id: string; name: string }[];
      }>("manager.list", {
        date: this.data.date,
        period: this.data.period,
        storeId: this.data.selectedStoreId || this.data.stores[this.data.storeIndex]?.store_id,
      });
      const { stores, storeId, ...overview } = data;
      const employeeRows = data.employees.map(employee => ({ ...employee,
        directReportId: this.data.period === 'today'
          ? data.reports.find(report => report.employee_id === employee.employee_id)?.id || ''
          : '',
      }));
      this.setData({ ...overview, stores,
        employeeRows,
        title: (stores.find(store => store.store_id === storeId)?.store_name || '门店') + '日报',
        storeIndex: Math.max(0, stores.findIndex((store) => store.store_id === storeId)),
        selectedStoreId: "", ready: true });
    } catch (e) {
      showError(e);
    } finally {
      this.setData({ loading: false });
    }
  },
  periodChange(e: WechatMiniprogram.CustomEvent) {
    if (this.data.loading) return;
    this.setData({ period: e.currentTarget.dataset.period }); void this.load();
  },
  person(e: WechatMiniprogram.CustomEvent) {
    wx.navigateTo({ url: '/pages/history/history?employeeId=' + encodeURIComponent(e.currentTarget.dataset.id) });
  },
  dateChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ date: e.detail.value });
    void this.load();
  },
  storeChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ storeIndex: Number(e.detail.value) });
    void this.load();
  },
  open(e: WechatMiniprogram.CustomEvent) {
    if (!e.currentTarget.dataset.id) return;
    wx.navigateTo({
      url:
        "/pages/detail/detail?id=" +
        encodeURIComponent(e.currentTarget.dataset.id),
    });
  },
  retry() {
    void this.load();
  },
});
