import {
  callApi,
  showError,
  today,
  Employee,
  Editor,
  Report,
  Workspace,
  Management,
} from "../../utils/cloud";
import { login, syncTabs } from "../../utils/workspace";
Page({
  data: {
    user: null as Employee | null,
    loading: false,
    binding: false,
    testBinding: false,
    testCode: "",
    workspace: "employee" as Workspace,
    recent: [] as Report[],
    overview: null as Management | null,
    date: today(),
    status: "未填写",
    button: "填写日报",
    error: false,
  },
  onShow() {
    this.setData({
      testBinding: wx.getAccountInfoSync().miniProgram.envVersion === "develop",
    });
    void this.load();
  },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: false, date: today() });
    try {
      const { user, workspace } = await login();
      this.setData({ user, workspace });
      syncTabs(this, workspace, 0);
      if (user) {
        if (workspace === "management") {
          const overview = await callApi<Management>("management.read", {
            date: this.data.date,
          });
          this.setData({ overview });
          return;
        }
        const { report } = await callApi<Editor>("report.read", {
          date: this.data.date,
        });
        this.setData({
          status:
            report?.status === "submitted"
              ? "已提交"
              : report
                ? "草稿"
                : "未填写",
          button:
            report?.status === "submitted"
              ? "查看今日日总结"
              : report
                ? "继续填写"
                : "填写今日日总结",
        });
        const { reports } = await callApi<{ reports: Report[] }>(
          "report.history",
        );
        this.setData({ recent: reports.slice(0, 2) });
      }
    } catch (e) {
      this.setData({ error: true });
      showError(e);
    } finally {
      this.setData({ loading: false });
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
    wx.navigateTo({ url: "/pages/report/report?date=" + this.data.date });
  },
  inputTestCode(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ testCode: e.detail.value.trim().toLowerCase() });
  },
  async bindTestCode() {
    if (!this.data.testBinding || this.data.binding) return;
    this.setData({ binding: true });
    try {
      await callApi("auth.bindTestCode", { code: this.data.testCode });
      this.setData({ testCode: "" });
      await this.load();
    } catch (e) {
      showError(e);
    } finally {
      this.setData({ binding: false });
    }
  },
  history() {
    if (this.data.workspace === "employee")
      wx.switchTab({ url: "/pages/workbench/workbench" });
    else wx.navigateTo({ url: "/pages/history/history" });
  },
  manager() {
    wx.switchTab({ url: "/pages/workbench/workbench" });
  },
  openRecent(e: WechatMiniprogram.CustomEvent) {
    wx.navigateTo({
      url: "/pages/report/report?date=" + e.currentTarget.dataset.date,
    });
  },
  openStore(e: WechatMiniprogram.CustomEvent) {
    wx.navigateTo({
      url:
        "/pages/manager/manager?storeId=" +
        encodeURIComponent(e.currentTarget.dataset.id),
    });
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
