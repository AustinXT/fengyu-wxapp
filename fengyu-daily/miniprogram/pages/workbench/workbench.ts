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
    period: "today",
    summary: null as Management["summary"] | null,
    range: null as Management["range"] | null,
    reports: [] as Report[],
    periods: [] as { id: string; name: string }[], periodIndex: 0,
    personalSummary: null as Management['summary'] | null,
    overview: null as Management | null,
    storeIndex: 0,
    managerStores: [] as Employee["managerWorkspaceStores"],
    search: "",
    peopleStores: [{ store_id: '', store_name: '全部门店' }], peopleStoreIndex: 0,
    peopleMarkets: [{ id: '', name: '全部市场' }], peopleMarketIndex: 0,
    positions: ['全部', '店长', '顾问', '养生师'], position: '全部',
    storePeople: [] as Management['employees'],
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
        if (!this.data.periods.length) {
          const data = await callApi<{ periods: { id: string; name: string }[]; period: { id: string } | null }>('period.list');
          this.setData({ periods: data.periods, periodIndex: Math.max(0, data.periods.findIndex((p) => p.id === data.period?.id)) });
        }
        const { reports, summary } = await callApi<{ reports: Report[]; summary: Management['summary'] | null }>('report.history',
          { periodId: this.data.periods[this.data.periodIndex]?.id });
        this.setData({ reports, personalSummary: summary });
      } else if (workspace === "manager") {
        const managerStores = user.managerWorkspaceStores || user.managerStores;
        if (!managerStores.length) throw new Error("当前授权范围没有可查看的门店");
        const index = Math.min(
          this.data.storeIndex,
          managerStores.length - 1,
        );
        const data = await callApi<{
          employees: Management["employees"];
          reports: { id: string; employee_id: string; employee_name: string }[];
          unsubmitted: { employee_id: string; name: string }[];
          summary: Management["summary"]; range: Management["range"];
        }>("manager.list", {
          date: this.data.date,
          period: this.data.period,
          storeId: managerStores[index].store_id,
        });
        this.setData({
          storeIndex: index,
          managerStores,
          storeReports: data.reports, storePeople: data.employees,
          unsubmitted: data.unsubmitted,
          summary: data.summary, range: data.range,
        });
      } else {
        const overview = await callApi<Management>("management.read", {
          date: this.data.date,
          period: this.data.period,
        });
        this.setData({ overview,
          peopleStores: [{ store_id: '', store_name: '全部门店' }, ...overview.stores],
          peopleMarkets: [{ id: '', name: '全部市场' }, ...overview.nodes.filter((n) => n.type === '市场')],
        });
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
    const marketId = this.data.peopleMarkets[this.data.peopleMarketIndex]?.id || '';
    const peopleIds = new Set(marketId ? [marketId] : overview.nodes.map((n) => n.id));
    let expand = true;
    while (expand) { expand = false; for (const n of overview.nodes) if (peopleIds.has(n.parent_id || '') && !peopleIds.has(n.id)) { peopleIds.add(n.id); expand = true; } }
    const storeIds = new Set(overview.stores.filter((s) => !marketId || peopleIds.has(s.org_node_id || '')).map((s) => s.store_id));
    const storeId = this.data.peopleStores[this.data.peopleStoreIndex]?.store_id || '';
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
        (e) => (!this.data.search || e.name.includes(this.data.search.trim())) && storeIds.has(e.store_id)
          && (!storeId || e.store_id === storeId)
          && (this.data.position === '全部' || (this.data.position === '店长' ? e.is_store_manager : e.position_name?.includes(this.data.position))),
      ),
    });
  },
  periodChange(e: WechatMiniprogram.CustomEvent) {
    if (this.data.loading) return;
    this.setData({ period: e.currentTarget.dataset.period }); void this.load();
  },
  person(e: WechatMiniprogram.CustomEvent) {
    wx.navigateTo({ url: '/pages/history/history?employeeId=' + encodeURIComponent(e.currentTarget.dataset.id) });
  },
  monthChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.loading) return;
    this.setData({ periodIndex: Number(e.detail.value) }); void this.load();
  },
  monthlyHistory() { wx.navigateTo({ url: '/pages/history/history' }); },
  orgChange(e: WechatMiniprogram.CustomEvent) {
    this.setData({ orgView: e.currentTarget.dataset.view });
  },
  search(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ search: e.detail.value });
    this.filter();
  },
  peopleFilter(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ [e.currentTarget.dataset.kind === 'market' ? 'peopleMarketIndex' : 'peopleStoreIndex']: Number(e.detail.value) }); this.filter();
  },
  position(e: WechatMiniprogram.CustomEvent) { this.setData({ position: e.currentTarget.dataset.value }); this.filter(); },
  node(e: WechatMiniprogram.CustomEvent) {
    const node = this.data.overview?.nodes.find((n) => n.id === e.currentTarget.dataset.id);
    if (node?.type === '市场') {
      wx.navigateTo({ url: '/pages/range/range?nodeId=' + encodeURIComponent(node.id) }); return;
    }
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
