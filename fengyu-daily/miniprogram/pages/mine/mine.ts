import { showError, Employee, Workspace } from "../../utils/cloud";
import { login, syncTabs, setWorkspace } from "../../utils/workspace";
Page({
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
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const { user, workspace } = await login();
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
        scopeLabel: scopeLabels.join("、") || "本人日报",
      });
      syncTabs(this, workspace, 2);
    } catch (e) {
      showError(e);
    } finally {
      this.setData({ loading: false });
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
  history() {
    wx.navigateTo({ url: "/pages/history/history" });
  },
});
