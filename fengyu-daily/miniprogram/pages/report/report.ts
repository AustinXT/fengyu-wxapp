import { callApi, showError, today, Editor, Business, MetricSnapshot } from "../../utils/cloud";
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
    copying: false,
    dirty: false,
    ready: false,
    metrics: null as MetricSnapshot | null,
    contacts: [] as { employee_id: string; name: string; position_name?: string | null }[],
    mentorIndex: 0,
    peerIndex: 0,
    mentorId: '',
    peerId: '',
    mentorName: '请选择指导员',
    peerName: '请选择同事',
    candidates: [] as Business[],
    sourceDate: today(),
    selectingBusiness: false,
    candidateLoading: false,
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
        workspace: wx.getStorageSync('dailyWorkspace'),
      });
      const r = data.report;
      const choices = data.readOnly ? [] : (await callApi<{ contacts: { employee_id: string; name: string }[] }>('contacts.list')).contacts;
      const contacts = [{ employee_id: '', name: '不选择' }, ...choices];
      const mentorId = r?.mentor_employee_id || '', peerId = r?.peer_employee_id || '';
      const mentorIndex = Math.max(0, contacts.findIndex((p) => p.employee_id === mentorId));
      const peerIndex = Math.max(0, contacts.findIndex((p) => p.employee_id === peerId));
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
        sourceDate: this.data.date,
        selectingBusiness: false,
        metrics: data.metrics || null,
        contacts, mentorId, peerId, mentorIndex, peerIndex,
        mentorName: data.metrics?.guidance?.mentor?.name || (mentorIndex ? contacts[mentorIndex].name : '请选择指导员'),
        peerName: data.metrics?.guidance?.peer?.name || (peerIndex ? contacts[peerIndex].name : '请选择同事'),
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
  chooseContact(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.readOnly || this.data.submitting || this.data.copying) return;
    const index = Number(e.detail.value), contact = this.data.contacts[index];
    if (!contact) return;
    if (e.currentTarget.dataset.kind === 'mentor') this.setData({ mentorIndex: index, mentorId: contact.employee_id, mentorName: index ? contact.name : '请选择指导员' });
    else this.setData({ peerIndex: index, peerId: contact.employee_id, peerName: index ? contact.name : '请选择同事' });
    this.markDirty();
  },
  async supplement() {
    if (!this.data.ready || this.data.readOnly || this.data.submitting || this.data.copying) return;
    this.setData({ selectingBusiness: true });
    await this.loadCandidates();
  },
  async loadCandidates() {
    if (this.data.candidateLoading) return;
    this.setData({ candidateLoading: true });
    try {
      const { entries } = await callApi<{ entries: Business[] }>('business.list', { date: this.data.date, sourceDate: this.data.sourceDate });
      this.setData({ candidates: entries.filter((b) => !this.data.entries.some((e) => e.businessId === b.businessId && e.businessType === b.businessType)) });
    } catch (e) { showError(e); } finally { this.setData({ candidateLoading: false }); }
  },
  sourceDateChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.candidateLoading) return;
    this.setData({ sourceDate: e.detail.value }); void this.loadCandidates();
  },
  closeCandidates() { this.setData({ selectingBusiness: false }); },
  addBusiness(e: WechatMiniprogram.CustomEvent) {
    if (this.data.readOnly || this.data.submitting || this.data.candidateLoading) return;
    const candidate = this.data.candidates[Number(e.currentTarget.dataset.index)];
    if (!candidate || this.data.entries.some((b) => b.businessId === candidate.businessId && b.businessType === candidate.businessType)) return;
    this.setData({ entries: [...this.data.entries, candidate], selectingBusiness: false }); this.markDirty();
  },
  removeBusiness(e: WechatMiniprogram.CustomEvent) {
    if (this.data.readOnly || this.data.submitting || this.data.copying) return;
    const index = Number(e.currentTarget.dataset.index);
    if (this.data.entries[index]?.auto !== false) return;
    this.setData({ entries: this.data.entries.filter((_, i) => i !== index) }); this.markDirty();
  },
  async copyLast() {
    if (!this.data.ready || this.data.readOnly || this.data.loading ||
        this.data.submitting || this.data.copying) return;
    this.setData({ copying: true });
    try {
      const { report } = await callApi<{
        report: { report_date: string; action: string; growth: string; plan: string } | null;
      }>("report.previous", { date: this.data.date });
      if (!report) {
        wx.showToast({ title: "暂无可复制的已提交记录", icon: "none" });
        return;
      }
      if (this.data.action || this.data.growth || this.data.plan) {
        const result = await wx.showModal({
          title: "覆盖当前补充内容？",
          content: "仅复制上次的整日补充，不覆盖本日关联业务。",
        });
        if (!result.confirm) return;
      }
      this.setData({ action: report.action, growth: report.growth, plan: report.plan });
      this.markDirty();
      wx.showToast({ title: "已复制上次整日补充", icon: "none" });
    } catch (e) {
      showError(e);
    } finally {
      this.setData({ copying: false });
    }
  },
  input(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.readOnly || this.data.submitting || this.data.copying) return;
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
    if (this.data.copying || this.data.submitting || this.data.loading || this.data.candidateLoading || this.data.selectingBusiness) return;
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
    if (this.data.submitting || this.data.copying || this.data.readOnly || !this.data.ready || this.data.candidateLoading || this.data.selectingBusiness) return;
    this.setData({ submitting: true });
    try {
      const { report } = await callApi<{
        report: { version: number; status: string };
      }>(submit ? "report.submit" : "report.save", {
        date: this.data.date,
        workspace: wx.getStorageSync('dailyWorkspace'),
        version: this.data.version,
        entries: this.data.entries.map((e) => ({
          businessType: e.businessType,
          businessId: e.businessId,
          businessDate: e.businessDate || this.data.date,
          feedback: e.feedback,
          followUp: e.followUp,
        })),
        action: this.data.action,
        growth: this.data.growth,
        plan: this.data.plan,
        mentorEmployeeId: this.data.mentorId || null,
        peerEmployeeId: this.data.peerId || null,
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
    if (this.data.submitting || this.data.copying || !this.data.ready) return;
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
