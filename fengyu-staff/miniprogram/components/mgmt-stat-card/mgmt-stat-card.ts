

Component({
  options: {
    multipleSlots: false,
  },
  properties: {
    count: { type: null, value: '' },
    label: { type: String, value: '' },
    size: { type: String, value: 'lg' }, 
    variant: { type: String, value: 'default' }, 
    selected: { type: Boolean, value: false },
    unit: { type: String, value: '' },
    countColor: { type: String, value: '' }, 
  },
  methods: {
    onTap() {
      this.triggerEvent('tap')
    },
  },
})
