import { expireLogin, identityContext, sessionContext, sessionChanged } from '../../utils/session';
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
// 组织页的市场只是授权门店分组，不等同于整市场访问权限。
interface OrganizationMarket { id: string; name: string; storeIds: string[] }
Page({
  _context: '',
  _loadId: 0,
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
    organizationMarkets: [] as OrganizationMarket[],
    organizationCompatibility: false,
    organizationMarketIndex: 0,
    organizationMarketId: "",
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
  async onPullDownRefresh() {
    expireLogin();
    try { await this.load(true); }
    finally { wx.stopPullDownRefresh(); }
  },
  async load(refreshPeriods = false) {
    const identity = identityContext();
    if (this.data.loading && this._context === sessionContext()) return;
    const loadId = ++this._loadId;
    if (this._context !== sessionContext()) this.setData({ ready: false, overview: null,
      periods: [], periodIndex: 0, reports: [], visibleStores: [], visibleEmployees: [],
      search: "", position: "全部", peopleStoreIndex: 0, storeIndex: 0,
      storePeople: [], storeReports: [], summary: null });
    this._context = sessionContext();
    this.setData({ loading: true });
    try {
      const { user, workspace } = await login();
      if (identity !== identityContext() || loadId !== this._loadId) throw sessionChanged();
      this._context = sessionContext();
      if (user?.employeeId !== this.data.user?.employeeId)
        this.setData({ organizationMarketId: "", organizationMarketIndex: 0 });
      this.setData({ user, workspace });
      syncTabs(this, workspace, 1);
      if (!user) {
        wx.switchTab({ url: "/pages/home/home" });
        return;
      }
      if (workspace === "employee") {
        const { reports, summary, periods, period } = await callApi<{ reports: Report[]; summary: Management['summary'] | null;
          periods?: { id: string; name: string }[]; period: { id: string } | null }>('report.history',
          { periodId: this.data.periods[this.data.periodIndex]?.id, includePeriods: refreshPeriods || !this.data.periods.length });
        if (identity !== identityContext() || loadId !== this._loadId) return;
        this.setData({ reports, personalSummary: summary, ...(periods ? {
          periods, periodIndex: Math.max(0, periods.findIndex(p => p.id === period?.id)),
        } : {}) });
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
        if (identity !== identityContext() || loadId !== this._loadId) return;
        this.setData({
          storeIndex: index,
          managerStores,
          storeReports: data.reports, storePeople: data.employees,
          unsubmitted: data.unsubmitted,
          summary: data.summary, range: data.range,
        });
      } else {
        this.setData({ period: "today" });
        const overview = await callApi<Management & { organizationMarkets?: OrganizationMarket[] }>("management.read", {
          date: this.data.date,
          period: this.data.period,
          includeOrganization: true,
        });
        if (identity !== identityContext() || loadId !== this._loadId) return;
        const organizationCompatibility = !Array.isArray(overview.organizationMarkets);
        this.setData({ overview,
          organizationCompatibility,
          organizationMarkets: organizationCompatibility
            ? [{ id: '__legacy_authorized__', name: '全部授权门店', storeIds: overview.stores.map(store => store.store_id) }]
            : overview.organizationMarkets!,
        });
        this.filter();
      }
      if (loadId === this._loadId) this.setData({ ready: true });
    } catch (e) {
      if (loadId === this._loadId) {
        this.setData({ ready: false, overview: null, reports: [], visibleStores: [], visibleEmployees: [],
          storePeople: [], storeReports: [], summary: null });
        showError(e);
      }
    } finally {
      if (loadId === this._loadId) this.setData({ loading: false });
    }
  },
  filter() {
    const overview = this.data.overview;
    if (!overview) return;
    const savedIndex = this.data.organizationMarkets.findIndex(market => market.id === this.data.organizationMarketId);
    const organizationMarketIndex = savedIndex >= 0 ? savedIndex : Math.max(0,
      this.data.organizationMarkets.findIndex(market => market.storeIds.length > 0),
    );
    const organizationMarket = this.data.organizationMarkets[organizationMarketIndex];
    const organizationStoreIds = new Set(organizationMarket?.storeIds || []);
    const visibleStores = overview.stores.filter(s => organizationStoreIds.has(s.store_id));
    const previousStoreId = this.data.peopleStores[this.data.peopleStoreIndex]?.store_id || '';
    const peopleStores = [{ store_id: '', store_name: '全部门店' }, ...visibleStores];
    const peopleStoreIndex = Math.max(0, peopleStores.findIndex(s => s.store_id === previousStoreId));
    const storeId = peopleStores[peopleStoreIndex].store_id;
    this.setData({
      organizationMarketIndex,
      organizationMarketId: organizationMarket?.id || "",
      visibleStores,
      peopleMarkets: this.data.organizationMarkets,
      peopleMarketIndex: organizationMarketIndex,
      peopleStores,
      peopleStoreIndex,
      visibleEmployees: overview.employees.filter(
        (e) => (!this.data.search || e.name.includes(this.data.search.trim())) && organizationStoreIds.has(e.store_id)
          && (!storeId || e.store_id === storeId)
          && (this.data.position === '全部' || (this.data.position === '店长' ? e.is_store_manager : e.position_name?.includes(this.data.position))),
      ),
    });
  },
  periodChange(e: WechatMiniprogram.CustomEvent) {
    if (this.data.loading) return;
    this.setData({ period: e.currentTarget.dataset.period, ready: false }); void this.load();
  },
  person(e: WechatMiniprogram.CustomEvent) {
    wx.navigateTo({ url: '/pages/history/history?employeeId=' + encodeURIComponent(e.currentTarget.dataset.id) });
  },
  monthChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.loading) return;
    this.setData({ periodIndex: Number(e.detail.value), ready: false }); void this.load();
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
    if (e.currentTarget.dataset.kind === 'market') { this.organizationMarketChange(e); return; }
    if (this.data.loading || !this.data.peopleStores[Number(e.detail.value)]) return;
    this.setData({ peopleStoreIndex: Number(e.detail.value) }); this.filter();
  },
  position(e: WechatMiniprogram.CustomEvent) { this.setData({ position: e.currentTarget.dataset.value }); this.filter(); },
  organizationMarketChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.loading) return;
    const market = this.data.organizationMarkets[Number(e.detail.value)];
    if (!market) return;
    this.setData({ organizationMarketId: market.id, peopleStoreIndex: 0 });
    this.filter();
  },
  storeChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ storeIndex: Number(e.detail.value), ready: false });
    void this.load();
  },
  open(e: WechatMiniprogram.CustomEvent) {
    if (e.currentTarget.dataset.date && e.currentTarget.dataset.status !== "submitted")
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
