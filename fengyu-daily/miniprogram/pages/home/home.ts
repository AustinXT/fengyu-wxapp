import {
  callApi,
  showError,
  today,
  Employee,
  Report,
  Workspace,
  Management,
} from "../../utils/cloud";
import { login, syncTabs } from "../../utils/workspace";
Page({
  data: {
    user: null as Employee | null,
    loading: false,
    refreshing: false,
    goalLoading: false,
    historyLoading: false,
    statusLoading: false,
    goalError: false,
    showGoalEntry: true,
    historyError: false,
    statusError: false,
    binding: false,
    testBinding: false,
    testCode: "",
    workspace: "employee" as Workspace,
    recent: [] as Report[],
    overview: null as Management | null,
    date: today(),
    period: "today",
    scopes: [{ id: "", name: "全部授权范围" }],
    scopeIndex: 0,
    status: "未填写",
    button: "填写日报",
    error: false,
    goalTitle: '经营目标',
    goalLabel: '设置月目标',
    goalPeriod: '尚未配置经营周期',
  },
  onShow() {
    this.setData({
      testBinding: wx.getAccountInfoSync().miniProgram.envVersion === "develop",
    });
    void this.load();
  },
  async load() {
    if (this.data.refreshing) return;
    this.setData({ loading: !this.data.user, refreshing: true, error: false, date: today() });
    try {
      const { user, workspace } = await login();
      const isStoreManager = (user?.managerStores || []).length > 0;
      this.setData({ user, workspace,
        showGoalEntry: (workspace === 'manager' && isStoreManager) ||
          (workspace === 'employee' && !isStoreManager),
      });
      syncTabs(this, workspace, 0);
      if (user) {
        if (workspace === "management") {
          const overview = await callApi<Management>("management.read", {
            date: this.data.date,
            period: this.data.period,
            nodeId: this.data.scopes[this.data.scopeIndex]?.id || undefined,
          });
          const scopes = [{ id: '', name: '全部授权范围' }, ...overview.nodes.filter((n) => n.type === '市场').map((n) => ({ id: n.id, name: n.name }))];
          this.setData({ overview, scopes });
          return;
        }
        this.setData({ loading: false, goalLoading: true, historyLoading: true, statusLoading: true,
          goalError: false, historyError: false, statusError: false });
        const goalTask = workspace === 'employee' && isStoreManager ? Promise.resolve() : (async () => {

          const scope = workspace === 'manager' ? 'store' : 'personal';
          const scopeId = scope === 'store' ? user.managerStores[0]?.store_id : user.employeeId;
          const goal = await callApi<{ period: { name: string } | null; week: { id: string; name: string; start: string; end: string } | null;
            target: { month_confirmed: boolean; counts_month_confirmed?: boolean; weeks: Record<string, { sales: number | null; consumption: number | null }> } | null }>('target.read', { scope, scopeId });
          this.setData({ goalTitle: scope === 'store' ? '本店经营目标' : '经营目标',
            goalPeriod: goal.week ? `${goal.week.name}（${goal.week.start.slice(5)} 至 ${goal.week.end.slice(5)}）` : goal.period?.name || '尚未配置经营周期',
            goalLabel: !goal.target?.month_confirmed ? '设置月目标' : !goal.target.counts_month_confirmed ? '补充月目标' : goal.week && goal.target.weeks[goal.week.id]?.sales == null ? '设置本周目标' : '查看经营目标' });

        })().catch(() => this.setData({ goalError: true }))
          .finally(() => this.setData({ goalLoading: false }));
        const statusTask = callApi<{ status: 'submitted' | 'draft' | null }>('report.status', { date: this.data.date })
          .then(({ status }) => this.setData({
            status: status === 'submitted' ? '已提交' : status ? '草稿' : '未填写',
            button: status === 'submitted' ? '查看今日日报' : status ? '继续填写' : '填写今日日报',
          }))
          .catch(() => this.setData({ statusError: true }))
          .finally(() => this.setData({ statusLoading: false }));
        const historyTask = callApi<{ reports: Report[] }>('report.history')
          .then(({ reports }) => this.setData({ recent: reports.slice(0, 2) }))
          .catch(() => this.setData({ historyError: true }))
          .finally(() => this.setData({ historyLoading: false }));
        await Promise.all([goalTask, statusTask, historyTask]);
      }
    } catch (e) {
      this.setData({ error: true });
      showError(e);
    } finally {
      this.setData({ loading: false, refreshing: false });
    }
  },
  async bindPhone(
    e: WechatMiniprogram.CustomEvent<{
      code?: string;
      cloudID?: string;
      errMsg: string;
    }>,
  ) {
    if (this.data.binding) return;
    if (e.detail.errMsg?.includes("fail")) {
      wx.showModal({
        title: "手机号授权未完成",
        content: e.detail.errMsg.includes("no permission")
          ? "日报小程序暂未开通手机号权限，请联系管理员。"
          : "请同意微信手机号授权后，再绑定员工身份。",
        showCancel: false,
      });
      return;
    }
    if (!e.detail.code && !e.detail.cloudID) {
      wx.showModal({
        title: "未取得手机号授权",
        content:
          "请使用微信真机预览完成授权；若仍失败，请联系管理员检查手机号权限。",
        showCancel: false,
      });
      return;
    }
    this.setData({ binding: true });
    try {
      await callApi(
        "auth.bindPhone",
        e.detail.code ? { code: e.detail.code } : { cloudID: e.detail.cloudID },
      );
      await this.load();
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ binding: false });
    }
  },
  report() {
    if (this.data.statusLoading || this.data.statusError) return;
    wx.navigateTo({ url: (this.data.status === "已提交" ? "/pages/detail/detail?date=" : "/pages/report/report?date=") + this.data.date });
  },
  inputTestCode(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ testCode: e.detail.value.trim().toLowerCase() });
  },
  async bindTestCode() {
    if (!this.data.testBinding || this.data.binding) return;
    this.setData({ binding: true });
    try {
      await callApi("auth.bindTestCode", { code: this.data.testCode });
      wx.setStorageSync("dailyTestBindingCode", this.data.testCode);
      this.setData({ testCode: "" });
      await this.load();
    } catch (e) {
      showError(e);
    } finally {
      this.setData({ binding: false });
    }
  },
  exitTestIdentity() {
    if (!this.data.testBinding) return;
    wx.removeStorageSync("dailyTestBindingCode");
    wx.removeStorageSync("dailyWorkspace");
    void this.load();
  },
  history() {
    if (this.data.workspace === "employee")
      wx.switchTab({ url: "/pages/workbench/workbench" });
    else wx.navigateTo({ url: "/pages/history/history" });
  },
  scopeChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.refreshing) return;
    this.setData({ scopeIndex: Number(e.detail.value) }); void this.load();
  },
  periodChange(e: WechatMiniprogram.CustomEvent) {
    if (this.data.refreshing) return;
    this.setData({ period: e.currentTarget.dataset.period }); void this.load();
  },
  pk() { wx.navigateTo({ url: '/pages/pk/pk' }); },
  goal() {
    if (this.data.goalError) { void this.load(); return; }
    if (this.data.workspace === 'employee' && (this.data.user?.managerStores || []).length > 0) return;
    const scope = this.data.workspace === 'management' ? 'market' : this.data.workspace === 'manager' ? 'store' : 'personal';
    wx.navigateTo({ url: '/pages/goal/goal?scope=' + scope });
  },
  manager() {
    wx.switchTab({ url: "/pages/workbench/workbench" });
  },
  openRecent(e: WechatMiniprogram.CustomEvent) {
    wx.navigateTo({
      url: e.currentTarget.dataset.status === "submitted"
        ? "/pages/detail/detail?id=" + encodeURIComponent(e.currentTarget.dataset.id)
        : "/pages/report/report?date=" + e.currentTarget.dataset.date,
    });
  },
  openMarket(e: WechatMiniprogram.CustomEvent) {
    wx.navigateTo({ url: '/pages/range/range?nodeId=' + encodeURIComponent(e.currentTarget.dataset.id) + '&period=' + this.data.period });
  },
  openStore(e: WechatMiniprogram.CustomEvent) {
    wx.navigateTo({
      url:
        "/pages/manager/manager?storeId=" +
        encodeURIComponent(e.currentTarget.dataset.id),
    });
  },
  person(e: WechatMiniprogram.CustomEvent) {
    wx.navigateTo({ url: '/pages/history/history?employeeId=' + encodeURIComponent(e.currentTarget.dataset.id) });
  },
  openDetail(e: WechatMiniprogram.CustomEvent) {
    if (e.currentTarget.dataset.id)
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
