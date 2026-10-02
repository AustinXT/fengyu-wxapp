import { callApi, showError, Report, Business } from "../../utils/cloud";
Page({
  data: {
    id: "",
    report: null as Report | null,
    entries: [] as Business[],
    loading: false,
  },
  onLoad(options: Record<string, string | undefined>) {
    this.setData({ id: options.id || "" });
    void this.load();
  },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const data = await callApi<{ report: Report; entries: Business[] }>(
        "manager.detail",
        { id: this.data.id },
      );
      this.setData(data);
    } catch (e) {
      showError(e);
    } finally {
      this.setData({ loading: false });
    }
  },
  retry() {
    void this.load();
  },
});
