// components/slide-to-confirm/slide-to-confirm.ts
// 滑动确认按钮：滑到右端 ≥80% 触发 confirm 事件，物理上消除单击误触
// 用于「关闭订单」「作废」「删除」等高破坏性操作

Component({
  properties: {
    /** 未触发时显示的提示文案 */
    label: {
      type: String,
      value: '向右滑动以确认',
    },
    /** 触发后显示的文案 */
    confirmedLabel: {
      type: String,
      value: '已确认',
    },
    /** 滑块底色（默认品牌红） */
    accentColor: {
      type: String,
      value: '#D94040',
    },
    /** 禁用滑动 */
    disabled: {
      type: Boolean,
      value: false,
    },
    /** 触发阈值（占整条 area 宽度的比例，默认 0.8） */
    threshold: {
      type: Number,
      value: 0.8,
    },
  },

  data: {
    thumbX: 0,
    dragging: false,
    confirmed: false,
    _areaWidth: 0,
    _thumbWidth: 48, // px，与 wxss 96rpx 在 750rpx 设计稿下约 48px
  },

  lifetimes: {
    attached() {
      // 异步获取 area 宽度（用于阈值判定）
      const query = this.createSelectorQuery();
      query.select('.stc-area').boundingClientRect((rect) => {
        if (rect && 'width' in rect) {
          this.setData({ _areaWidth: rect.width });
        }
      }).exec();
    },
  },

  methods: {
    onMove(e: WechatMiniprogram.CustomEvent<{ x: number; y: number; source: string }>) {
      if (this.data.disabled || this.data.confirmed) return;
      const { x, source } = e.detail;
      // 仅在手指拖动时跟踪（source='touch'）；动画回弹时 source='friction' 等
      if (source === 'touch') {
        if (!this.data.dragging) this.setData({ dragging: true });
      }
      // 不在这里判触发——onRelease 才判
      const _ = x; // x 用于调试可选
    },

    onRelease(_e: WechatMiniprogram.TouchEvent) {
      if (this.data.disabled || this.data.confirmed) return;
      // 通过查询当前滑块位置判断是否过阈值
      const query = this.createSelectorQuery().in(this);
      query.select('.stc-thumb').boundingClientRect((rect) => {
        query.select('.stc-area').boundingClientRect((areaRect) => {
          if (!rect || !areaRect || !('left' in rect) || !('left' in areaRect)) {
            this.setData({ thumbX: 0, dragging: false });
            return;
          }
          const traveled = (rect.left as number) - (areaRect.left as number);
          const maxTravel = (areaRect.width as number) - (rect.width as number);
          const ratio = maxTravel > 0 ? traveled / maxTravel : 0;
          if (ratio >= this.data.threshold) {
            // 触发确认：滑到底 + 锁定，触发事件
            this.setData({ confirmed: true, dragging: false, thumbX: maxTravel });
            this.triggerEvent('confirm');
          } else {
            // 未到位：弹回起点
            this.setData({ thumbX: 0, dragging: false });
          }
        }).exec();
      }).exec();
    },

    /** 父组件可调 reset 方法重置滑块（用于操作失败后允许重试） */
    reset() {
      this.setData({ thumbX: 0, dragging: false, confirmed: false });
    },
  },
});
