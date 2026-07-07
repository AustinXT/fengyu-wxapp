



Component({
  properties: {
    
    label: {
      type: String,
      value: '向右滑动以确认',
    },
    
    confirmedLabel: {
      type: String,
      value: '已确认',
    },
    
    accentColor: {
      type: String,
      value: '#D94040',
    },
    
    disabled: {
      type: Boolean,
      value: false,
    },
    
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
    _thumbWidth: 48, 
  },

  lifetimes: {
    attached() {
      
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
      
      if (source === 'touch') {
        if (!this.data.dragging) this.setData({ dragging: true });
      }
      
      const _ = x; 
    },

    onRelease(_e: WechatMiniprogram.TouchEvent) {
      if (this.data.disabled || this.data.confirmed) return;
      
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
            
            this.setData({ confirmed: true, dragging: false, thumbX: maxTravel });
            this.triggerEvent('confirm');
          } else {
            
            this.setData({ thumbX: 0, dragging: false });
          }
        }).exec();
      }).exec();
    },

    
    reset() {
      this.setData({ thumbX: 0, dragging: false, confirmed: false });
    },
  },
});
