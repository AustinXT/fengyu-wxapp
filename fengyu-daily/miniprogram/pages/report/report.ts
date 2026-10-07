import { callApi, showError, today, Editor, Business, MetricSnapshot } from "../../utils/cloud";
Page({
  _loadGeneration: 0,
  _contactsRequest: 0,
  data: {
    editing: false,
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
    contactsLoading: false,
    contactsError: false,
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
    candidateSearch: "",
    visibleCandidates: [] as (Business & { sourceIndex: number })[],
  },
  onLoad(options: Record<string, string | undefined>) {
    this.setData({ date: options.date || today(), editing: options.edit === "1" });
    wx.setNavigationBarTitle({ title: options.edit === "1" ? "修改今日日报" : "填写日报" });
    void this.load();
  },
  async load() {
    if (this.data.loading) return;
    const generation = ++this._loadGeneration;
    const request = ++this._contactsRequest;
    this.setData({ loading: true, ready: false, contactsLoading: true, contactsError: false, contacts: [] });
    const contactsTask = this.fetchContacts();
    try {
      const data = await callApi<Editor>("report.read", {
        date: this.data.date,
        workspace: wx.getStorageSync('dailyWorkspace'),
      });
      if (generation !== this._loadGeneration) return;
      const r = data.report;
      if (r?.status === 'submitted' && (!this.data.editing || data.readOnly)) {
        ++this._contactsRequest;
        this.setData({ contactsLoading: false });
        wx.redirectTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(r.id) }); return;
      }
      const mentorId = r?.mentor_employee_id || '', peerId = r?.peer_employee_id || '';
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
        mentorId, peerId, mentorIndex: 0, peerIndex: 0,
        mentorName: data.metrics?.guidance?.mentor?.name || r?.metric_snapshot?.guidance?.mentor?.name ||
          (mentorId ? (mentorId === this.data.mentorId ? this.data.mentorName : '已选择指导员') : '请选择指导员'),
        peerName: data.metrics?.guidance?.peer?.name || r?.metric_snapshot?.guidance?.peer?.name ||
          (peerId ? (peerId === this.data.peerId ? this.data.peerName : '已选择同事') : '请选择同事'),
      });
      void contactsTask.then((result) => {
        if (generation !== this._loadGeneration || request !== this._contactsRequest) return;
        this.setContactChoices(result.contacts, result.error);
      });
      wx.disableAlertBeforeUnload();
    } catch (e) {
      if (generation === this._loadGeneration) {
        ++this._contactsRequest;
        this.setData({ contactsLoading: false });
        showError(e);
      }
    } finally {
      if (generation === this._loadGeneration) this.setData({ loading: false });
    }
  },
  onUnload() {
    ++this._loadGeneration;
    ++this._contactsRequest;
  },
  async fetchContacts() {
    try {
      const data = await callApi<{ contacts: { employee_id: string; name: string }[] }>('contacts.list');
      return { contacts: data.contacts, error: false };
    } catch (_) {
      return { contacts: [], error: true };
    }
  },
  setContactChoices(choices: { employee_id: string; name: string }[], error: boolean) {
    if (error) { this.setData({ contactsLoading: false, contactsError: true }); return; }
    const contacts = [{ employee_id: '', name: '不选择' }, ...choices];
    const mentorIndex = Math.max(0, contacts.findIndex((p) => p.employee_id === this.data.mentorId));
    const peerIndex = Math.max(0, contacts.findIndex((p) => p.employee_id === this.data.peerId));
    this.setData({ contacts, mentorIndex, peerIndex, contactsLoading: false, contactsError: false,
      mentorName: mentorIndex ? contacts[mentorIndex].name : this.data.mentorName,
      peerName: peerIndex ? contacts[peerIndex].name : this.data.peerName });
  },
  async retryContacts() {
    if (!this.data.ready || this.data.contactsLoading || this.data.readOnly) return;
    const generation = this._loadGeneration, request = ++this._contactsRequest;
    this.setData({ contactsLoading: true, contactsError: false });
    const result = await this.fetchContacts();
    if (generation !== this._loadGeneration || request !== this._contactsRequest) return;
    this.setContactChoices(result.contacts, result.error);
  },
  markDirty() {
    this.setData({ dirty: true });
    wx.enableAlertBeforeUnload({ message: "日报尚未保存，确定离开吗？" });
  },
  chooseContact(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.readOnly || this.data.submitting || this.data.copying || this.data.contactsLoading || this.data.contactsError) return;
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
      this.setData({ candidates: entries.filter((b) => !this.data.entries.some((e) => e.businessId === b.businessId && e.businessType === b.businessType)) }); this.filterCandidates();
    } catch (e) { showError(e); } finally { this.setData({ candidateLoading: false }); }
  },
  candidateSearch(e: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ candidateSearch: e.detail.value }); this.filterCandidates(); },
  filterCandidates() {
    const term = this.data.candidateSearch.trim();
    this.setData({ visibleCandidates: this.data.candidates.map((b, sourceIndex) => ({ ...b, sourceIndex }))
      .filter((b) => !term || [b.title, b.customer, b.businessId].some((text) => text?.includes(term))) });
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
        this.data.submitting || this.data.copying || this.data.selectingBusiness || this.data.candidateLoading) return;
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
          auto: e.auto,
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
      if (submit) {
        ++this._contactsRequest;
        wx.redirectTo({ url: "/pages/detail/detail?date=" + this.data.date });
      }
    } catch (e) {
      showError(e);
    } finally {
      this.setData({ submitting: false });
    }
  },
  cancelEdit() {
    const leave = () => { ++this._contactsRequest; wx.disableAlertBeforeUnload(); wx.redirectTo({ url: '/pages/detail/detail?date=' + this.data.date }); };
    if (this.data.dirty) wx.showModal({ title: '取消修改', content: '放弃本次未提交的修改？', success: (r) => { if (r.confirm) leave(); } });
    else leave();
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
