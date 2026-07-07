
import { callStaffApi } from '../../utils/cloud'

type ScopeType = 'all' | 'market' | 'store'

interface Scope {
  scopeType: ScopeType
  scopeId: string | null
  scopeName: string
  marketId?: string
}

interface MarketMini {
  id: string
  name: string
}

interface StoreMini {
  storeId: string
  storeName: string
}

interface ScopeOptionsResp {
  staffLevel: 'headquarters' | 'market'
  markets: Array<{ id: string; name: string; stores: StoreMini[] }>
}

const DEFAULT_ALL: Scope = { scopeType: 'all', scopeId: null, scopeName: '全部市场' }

Component({
  properties: {
    staffLevel: { type: String, value: '' },
    defaultScope: {
      type: Object,
      value: { scopeType: 'all', scopeId: null, scopeName: '全部市场' } as Scope,
    },
  },

  data: {
    showPopup: false,
    marketList: [] as MarketMini[],
    storeListByMarket: {} as Record<string, StoreMini[]>,
    current: { ...DEFAULT_ALL } as Scope,
    applied: { ...DEFAULT_ALL } as Scope,
  },

  lifetimes: {
    attached() {
      const def = (this.properties.defaultScope as Scope) || DEFAULT_ALL
      this.setData({ applied: def, current: def })
      this.loadOptions()
    },
  },

  methods: {
    async loadOptions() {
      try {
        const res = await callStaffApi<ScopeOptionsResp>('mgmtDashboard.scopeOptions', {})
        const marketList: MarketMini[] = (res.markets || []).map(m => ({ id: m.id, name: m.name }))
        const storeListByMarket: Record<string, StoreMini[]> = {}
        ;(res.markets || []).forEach(m => {
          storeListByMarket[m.id] = m.stores || []
        })

        
        
        const applied = this.data.applied as Scope
        let nextApplied = applied
        if (applied.scopeType === 'market' && !applied.scopeName && applied.scopeId) {
          const m = marketList.find(x => x.id === applied.scopeId)
          if (m) nextApplied = { ...applied, marketId: m.id, scopeName: m.name }
        }

        this.setData({
          marketList,
          storeListByMarket,
          applied: nextApplied,
          current: nextApplied,
        })

        if (nextApplied !== applied) {
          this.triggerEvent('change', {
            scopeType: nextApplied.scopeType,
            scopeId: nextApplied.scopeId,
            scopeName: nextApplied.scopeName,
          })
        }
      } catch (err) {
        wx.showToast({ title: '加载范围失败', icon: 'none' })
      }
    },

    onOpen() {
      this.setData({ showPopup: true, current: this.data.applied })
    },

    onCancel() {
      this.setData({ showPopup: false, current: this.data.applied })
    },

    onPickAll() {
      const next: Scope = { scopeType: 'all', scopeId: null, scopeName: '全部市场' }
      this.setData({ current: next })
      this._confirmAndEmit(next)
    },

    onPickMarket(e: WechatMiniprogram.TouchEvent) {
      const marketId = e.currentTarget.dataset.marketId as string
      const market = (this.data.marketList as MarketMini[]).find(m => m.id === marketId)
      if (!market) return
      const next: Scope = {
        scopeType: 'market',
        marketId,
        scopeId: marketId,
        scopeName: market.name,
      }
      this.setData({ current: next })
    },

    onPickStore(e: WechatMiniprogram.TouchEvent) {
      const storeId = (e.currentTarget.dataset.storeId as string) || ''
      const cur = this.data.current as Scope
      if (!cur.marketId) return
      const market = (this.data.marketList as MarketMini[]).find(m => m.id === cur.marketId)
      if (!market) return

      
      if (storeId === '') {
        const next: Scope = {
          scopeType: 'market',
          marketId: cur.marketId,
          scopeId: cur.marketId,
          scopeName: market.name,
        }
        this._confirmAndEmit(next)
        return
      }

      const stores = (this.data.storeListByMarket as Record<string, StoreMini[]>)[cur.marketId] || []
      const store = stores.find(s => s.storeId === storeId)
      if (!store) return
      
      const next: Scope = {
        scopeType: 'store',
        marketId: cur.marketId,
        scopeId: storeId,
        scopeName: `${market.name} · ${store.storeName}`,
      }
      this._confirmAndEmit(next)
    },

    onConfirm() {
      this._confirmAndEmit(this.data.current as Scope)
    },

    
    _confirmAndEmit(scope: Scope) {
      this.setData({ applied: scope, current: scope, showPopup: false })
      this.triggerEvent('change', {
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        scopeName: scope.scopeName,
      })
    },
  },
})
