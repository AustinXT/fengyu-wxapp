Component({
  data: { selected: 0, workspace: "employee" },
  methods: {
    change(e: WechatMiniprogram.CustomEvent) {
      const index = Number(e.currentTarget.dataset.index);
      const paths = [
        "/pages/home/home",
        "/pages/workbench/workbench",
        "/pages/mine/mine",
      ];
      if (index !== this.data.selected && paths[index])
        wx.switchTab({ url: paths[index] });
    },
  },
});
