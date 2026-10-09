import { identityContext, sessionContext, sessionChanged } from '../../utils/session';
import { showError, Employee, Workspace } from "../../utils/cloud";
import { login, syncTabs, setWorkspace } from "../../utils/workspace";
Page({
  _context: '',
  _loadId: 0,
  data: {
    user: null as Employee | null,
    workspace: "employee" as Workspace,
    loading: false,
    workspaceLabel: "",
    scopeLabel: "",
  },
  onShow() {
    void this.load();
  },
  async load() {
    const identity = identityContext();
    if (this.data.loading && this._context === sessionContext()) return;
    const loadId = ++this._loadId;
    if (this._context !== sessionContext()) this.setData({ user: null, scopeLabel: "" });
    this._context = sessionContext();
    this.setData({ loading: true });
    try {
      const { user, workspace } = await login();
      if (identity !== identityContext() || loadId !== this._loadId) throw sessionChanged();
      this._context = sessionContext();
      const scopeLabels = Array.from(
        new Map(
          (user?.roleBindings || [])
            .filter((role) => role.scopeName)
            .map((role) => [role.scopeId || role.scopeName, role.scopeName] as const),
        ).values(),
      );
      this.setData({
        user,
        workspace,
        workspaceLabel:
          workspace === "management"
            ? "管理层"
            : workspace === "manager"
              ? "店长"
              : "员工",
        scopeLabel: workspace === "employee"
          ? "本人日报"
          : workspace === "manager"
            ? (user?.managerWorkspaceStores || user?.managerStores || []).map((store) => store.store_name).join("、") || "暂无授权门店"
            : scopeLabels.join("、") || "暂无授权范围",
      });
      syncTabs(this, workspace, 2);
    } catch (e) {
      if (loadId === this._loadId) this.setData({ user: null, scopeLabel: "" });
      showError(e);
    } finally {
      if (loadId === this._loadId) this.setData({ loading: false });
    }
  },
  change() {
    const user = this.data.user;
    if (!user) return;
    const labels = {
      employee: "员工工作台",
      manager: "店长工作台",
      management: "管理层工作台",
    };
    wx.showActionSheet({
      itemList: user.availableWorkspaces.map((w) => labels[w]),
      success: (r) => {
        setWorkspace(user, user.availableWorkspaces[r.tapIndex]);
        wx.switchTab({ url: "/pages/home/home" });
      },
    });
  },
});
