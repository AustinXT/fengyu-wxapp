import { callApi, showError, today, Editor, Business } from "../../utils/cloud";
Page({
  data: {
    date: today(),
    maxDate: today(),
    entries: [] as Business[],
    action: "",
    growth: "",
    plan: "",
    version: 0,
    status: "draft",
    readOnly: false,
    loading: false,
    submitting: false,
    dirty: false,
    ready: false,
  },
  onLoad(options: Record<string, string | undefined>) {
    this.setData({ date: options.date || today() });
    void this.load();
  },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true, ready: false });
    try {
      const data = await callApi<Editor>("report.read", {
        date: this.data.date,
      });
      const r = data.report;
      this.setData({
        entries: data.entries,
        action: r?.action || "",
        growth: r?.growth || "",
        plan: r?.plan || "",
        version: r?.version || 0,
        status: r?.status || "draft",
        readOnly: data.readOnly,
        dirty: false,
        ready: true,
      });
      wx.disableAlertBeforeUnload();
    } catch (e) {
      showError(e);
    } finally {
      this.setData({ loading: false });
    }
  },
  markDirty() {
    this.setData({ dirty: true });
    wx.enableAlertBeforeUnload({ message: "日报尚未保存，确定离开吗？" });
  },
  input(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.readOnly || this.data.submitting) return;
    const field = e.currentTarget.dataset.field as string;
    if (["action", "growth", "plan"].includes(field)) {
      this.setData({ [field]: e.detail.value });
      this.markDirty();
      return;
    }
    const index = Number(e.currentTarget.dataset.index);
    if (
      Number.isInteger(index) &&
      this.data.entries[index] &&
      ["feedback", "followUp"].includes(field)
    ) {
      this.setData({ ["entries[" + index + "]." + field]: e.detail.value });
      this.markDirty();
    }
  },
  changeDate(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const change = () => {
      this.setData({ date: e.detail.value });
      void this.load();
    };
    if (this.data.dirty)
      wx.showModal({
        title: "切换日期",
        content: "当前填写内容尚未保存，确认放弃并切换？",
        success: (r) => {
          if (r.confirm) change();
        },
      });
    else change();
  },
  async write(submit: boolean) {
    if (this.data.submitting || this.data.readOnly || !this.data.ready) return;
    this.setData({ submitting: true });
    try {
      const { report } = await callApi<{
        report: { version: number; status: string };
      }>(submit ? "report.submit" : "report.save", {
        date: this.data.date,
        version: this.data.version,
        entries: this.data.entries.map((e) => ({
          businessType: e.businessType,
          businessId: e.businessId,
          feedback: e.feedback,
          followUp: e.followUp,
        })),
        action: this.data.action,
        growth: this.data.growth,
        plan: this.data.plan,
      });
      this.setData({
        version: report.version,
        status: report.status,
        dirty: false,
      });
      wx.disableAlertBeforeUnload();
      wx.showToast({
        title: submit ? "日报已提交" : "草稿已保存",
        icon: "success",
      });
      if (submit)
        wx.redirectTo({ url: "/pages/report/report?date=" + this.data.date });
    } catch (e) {
      showError(e);
    } finally {
      this.setData({ submitting: false });
    }
  },
  save() {
    void this.write(false);
  },
  submit() {
    if (this.data.submitting || !this.data.ready) return;
    wx.showModal({
      title: "提交日报",
      content: "提交后店长可查看。今日可再次提交修改，历史提交后只可查看。",
      success: (r) => {
        if (r.confirm) void this.write(true);
      },
    });
  },
  retry() {
    void this.load();
  },
});
