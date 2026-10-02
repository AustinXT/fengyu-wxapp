import { callApi, showError, today, Employee } from "../../utils/cloud";
interface Submission {
  id: string;
  employee_id: string;
  employee_name: string;
  submitted_at: string;
}
Page({
  data: {
    date: today(),
    maxDate: today(),
    stores: [] as Employee["managerStores"],
    storeIndex: 0,
    reports: [] as Submission[],
    unsubmitted: [] as { employee_id: string; name: string }[],
    loading: false,
    ready: false,
    selectedStoreId: "",
  },
  onLoad(options: Record<string, string | undefined>) {
    this.setData({ selectedStoreId: options.storeId || "" });
  },
  onShow() {
    void this.load();
  },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true, ready: false });
    try {
      const { user } = await callApi<{ user: Employee | null }>("auth.login");
      const stores = user?.availableWorkspaces.includes("management")
        ? user.scopedStores
        : user?.managerStores || [];
      if (!stores.length) throw new Error("您没有门店日报查看权限");
      this.setData({
        stores,
        storeIndex: this.data.selectedStoreId
          ? Math.max(
              0,
              stores.findIndex((s) => s.store_id === this.data.selectedStoreId),
            )
          : Math.min(this.data.storeIndex, stores.length - 1),
        selectedStoreId: "",
      });
      const data = await callApi<{
        reports: Submission[];
        unsubmitted: { employee_id: string; name: string }[];
      }>("manager.list", {
        date: this.data.date,
        storeId: stores[this.data.storeIndex].store_id,
      });
      this.setData({ ...data, ready: true });
    } catch (e) {
      showError(e);
    } finally {
      this.setData({ loading: false });
    }
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
