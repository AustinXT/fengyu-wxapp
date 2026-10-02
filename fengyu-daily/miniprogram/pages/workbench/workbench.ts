import {
  callApi,
  showError,
  today,
  Employee,
  Workspace,
  Report,
  Management,
} from "../../utils/cloud";
import { login, syncTabs } from "../../utils/workspace";
Page({
  data: {
    user: null as Employee | null,
    workspace: "employee" as Workspace,
    loading: false,
    ready: false,
    date: today(),
    reports: [] as Report[],
    overview: null as Management | null,
    storeIndex: 0,
    search: "",
    orgView: "tree",
    selectedNodeId: "",
    visibleNodes: [] as Management["nodes"],
    visibleStores: [] as Management["stores"],
    visibleEmployees: [] as Management["employees"],
    storeReports: [] as {
      id: string;
      employee_id: string;
      employee_name: string;
    }[],
    unsubmitted: [] as { employee_id: string; name: string }[],
  },
  onShow() {
    void this.load();
  },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true, ready: false });
    try {
      const { user, workspace } = await login();
      this.setData({ user, workspace });
      syncTabs(this, workspace, 1);
      if (!user) {
        wx.switchTab({ url: "/pages/home/home" });
        return;
      }
      if (workspace === "employee") {
        const { reports } = await callApi<{ reports: Report[] }>(
          "report.history",
        );
        this.setData({ reports });
      } else if (workspace === "manager") {
        const index = Math.min(
          this.data.storeIndex,
          user.managerStores.length - 1,
        );
        const data = await callApi<{
          reports: { id: string; employee_id: string; employee_name: string }[];
          unsubmitted: { employee_id: string; name: string }[];
        }>("manager.list", {
          date: this.data.date,
          storeId: user.managerStores[index].store_id,
        });
        this.setData({
          storeIndex: index,
          storeReports: data.reports,
          unsubmitted: data.unsubmitted,
        });
      } else {
        const overview = await callApi<Management>("management.read", {
          date: this.data.date,
        });
        this.setData({ overview });
        this.filter();
      }
      this.setData({ ready: true });
    } catch (e) {
      showError(e);
    } finally {
      this.setData({ loading: false });
    }
  },
  filter() {
    const overview = this.data.overview;
    if (!overview) return;
    const ids = new Set(overview.nodes.map((n) => n.id));
    const selectedNodeId = ids.has(this.data.selectedNodeId)
      ? this.data.selectedNodeId
      : "";
    const descendants = new Set<string>(
      selectedNodeId ? [selectedNodeId] : overview.nodes.map((n) => n.id),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of overview.nodes) {
        if (
          node.parent_id &&
          descendants.has(node.parent_id) &&
          !descendants.has(node.id)
        ) {
          descendants.add(node.id);
          changed = true;
        }
      }
    }
    this.setData({
      selectedNodeId,
      visibleStores: overview.stores.filter(
        (s) =>
          !selectedNodeId ||
          (!!s.org_node_id && descendants.has(s.org_node_id)),
      ),
      visibleNodes: overview.nodes.filter((n) =>
        selectedNodeId
          ? n.parent_id === selectedNodeId
          : !n.parent_id || !ids.has(n.parent_id),
      ),
      visibleEmployees: overview.employees.filter(
        (e) => !this.data.search || e.name.includes(this.data.search),
      ),
    });
  },
  orgChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ orgView: e.currentTarget.dataset.view });
  },
  search(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ search: e.detail.value });
    this.filter();
  },
  node(e: WechatMiniprogram.CustomEvent) {
    this.setData({ selectedNodeId: e.currentTarget.dataset.id });
    this.filter();
  },
  root() {
    this.setData({ selectedNodeId: "" });
    this.filter();
  },
  storeChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ storeIndex: Number(e.detail.value) });
    void this.load();
  },
  open(e: WechatMiniprogram.CustomEvent) {
    if (e.currentTarget.dataset.date)
      wx.navigateTo({
        url: "/pages/report/report?date=" + e.currentTarget.dataset.date,
      });
    else if (e.currentTarget.dataset.id)
      wx.navigateTo({
        url:
          "/pages/detail/detail?id=" +
          encodeURIComponent(e.currentTarget.dataset.id),
      });
  },
  store(e: WechatMiniprogram.CustomEvent) {
    wx.navigateTo({
      url:
        "/pages/manager/manager?storeId=" +
        encodeURIComponent(e.currentTarget.dataset.id),
    });
  },
  retry() {
    void this.load();
  },
});
