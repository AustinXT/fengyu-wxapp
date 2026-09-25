// components/mgmt-scope-picker — scope 驱动的市场/门店二级筛选器
import { callStaffApi } from '../../utils/cloud'

type ScopeType = 'all' | 'market' | 'store'

interface Scope {
  scopeType: ScopeType
  scopeId: string | null
  scopeName: string
  marketId?: string
  /** 门店组织节点已停用（#400）：触发器标「（已停用）」，页面出空态 */
  inactive?: boolean
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
  staffLevel: string | null
  allowAll: boolean
  allowedMarketIds: string[]
  markets: Array<{ id: string; name: string; stores: StoreMini[] }>
  /** 权限内门店组织节点已停用的门店（不进下拉） */
  inactiveStores?: StoreMini[]
}

const DEFAULT_ALL: Scope = { scopeType: 'all', scopeId: null, scopeName: '全部市场' }

Component({
  properties: {
    defaultScope: {
      type: Object,
      value: { scopeType: 'all', scopeId: null, scopeName: '全部市场' } as Scope,
    },
  },

  data: {
    showPopup: false,
    allowAll: false,
    allowedMarketIds: [] as string[],
    currentAllowsMarket: false,
    marketList: [] as MarketMini[],
    storeListByMarket: {} as Record<string, StoreMini[]>,
    current: { ...DEFAULT_ALL } as Scope,
    applied: { ...DEFAULT_ALL } as Scope,
    inactiveStoreIds: [] as string[],
    optionsLoaded: false,
    userPicked: false,
  },

  lifetimes: {
    attached() {
      const def = (this.properties.defaultScope as Scope) || DEFAULT_ALL
      this.setData({ applied: def, current: def })
      this.loadOptions()
    },
  },

  observers: {
    // 组件 attached 早于页面 onLoad/onShow：页面在 onShow 里算出的默认范围只能靠 observer 接住，
    // 否则 applied 停在 attached 时的初值（全部市场），纠正 / 回填全都不生效（#400 评审发现）。
    // 用户显式选过后不再被默认值覆盖。
    defaultScope(def: Scope) {
      if (!def || this.data.userPicked) return
      const applied = this.data.applied as Scope
      if (def.scopeType === applied.scopeType && def.scopeId === applied.scopeId && !!def.inactive === !!applied.inactive) return
      this.setData({ applied: def, current: def })
      if (this.data.optionsLoaded) this._normalizeApplied()
    },
  },

  methods: {
    async loadOptions() {
      try {
        const res = await callStaffApi<ScopeOptionsResp>('mgmtDashboard.scopeOptions', {})
        const allowAll = !!res.allowAll
        const allowedMarketIds = res.allowedMarketIds || []
        const marketList: MarketMini[] = (res.markets || []).map(m => ({ id: m.id, name: m.name }))
        const storeListByMarket: Record<string, StoreMini[]> = {}
        ;(res.markets || []).forEach(m => {
          storeListByMarket[m.id] = m.stores || []
        })
        this.setData({
          allowAll,
          allowedMarketIds,
          marketList,
          storeListByMarket,
          inactiveStoreIds: (res.inactiveStores || []).map((store) => store.storeId),
          optionsLoaded: true,
        })
        this._normalizeApplied()
      } catch (err) {
        wx.showToast({ title: '加载范围失败', icon: 'none' })
      }
    },

    /** 按已加载的范围数据校正 applied（回填名称 / 纠正停用门店），有变化才广播 change */
    _normalizeApplied() {
      const marketList = this.data.marketList as MarketMini[]
      const storeListByMarket = this.data.storeListByMarket as Record<string, StoreMini[]>
      const allowedMarketIds = this.data.allowedMarketIds as string[]

      // 若调用方传入的 defaultScope 是 market 维度但 scopeName 缺失（页面层占位），
      // 按返回数据回填真实市场名，并广播一次 change 同步页面显示。
      const applied = this.data.applied as Scope
      let nextApplied = applied
      if (applied.scopeType === 'market' && !applied.scopeName && applied.scopeId) {
        const m = marketList.find(x => x.id === applied.scopeId)
        if (m) nextApplied = { ...applied, marketId: m.id, scopeName: m.name }
      }
      if (nextApplied.scopeType === 'store' && !nextApplied.marketId && nextApplied.scopeId) {
        const market = marketList.find((m) =>
          (storeListByMarket[m.id] || []).some((store) => store.storeId === nextApplied.scopeId),
        )
        if (market) {
          const store = (storeListByMarket[market.id] || []).find((item) => item.storeId === nextApplied.scopeId)
          nextApplied = {
            ...nextApplied,
            marketId: market.id,
            scopeName: nextApplied.scopeName || `${market.name} · ${store?.storeName || ''}`,
          }
        }
      }
      // 默认门店落在已停用门店（#400）：取数会滤掉它的全部数据（满屏 0）。
      // 有在营门店可选就纠正到第一家在营门店；没有就保留，标「已停用」由页面出空态。
      // 只纠正停用门店 —— 只关店、节点仍在营的门店不在下拉里但照样有历史数据，不动它。
      const inactiveIds = new Set(this.data.inactiveStoreIds as string[])
      if (nextApplied.scopeType === 'store' && nextApplied.scopeId && inactiveIds.has(nextApplied.scopeId)) {
        const market = marketList.find((m) => (storeListByMarket[m.id] || []).length > 0)
        const firstActive = market ? storeListByMarket[market.id][0] : undefined
        nextApplied = market && firstActive
          ? {
            scopeType: 'store',
            marketId: market.id,
            scopeId: firstActive.storeId,
            scopeName: `${market.name} · ${firstActive.storeName}`,
          }
          : nextApplied.inactive ? nextApplied : { ...nextApplied, inactive: true }
      } else if (nextApplied.inactive) {
        // 页面初判停用（旧缓存 / 期间已启用），服务端说在营 → 撤掉标记
        nextApplied = { ...nextApplied, inactive: false }
      }

      this.setData({
        currentAllowsMarket: !!nextApplied.marketId && allowedMarketIds.includes(nextApplied.marketId),
        applied: nextApplied,
        current: nextApplied,
      })

      if (nextApplied !== applied) {
        this.triggerEvent('change', {
          scopeType: nextApplied.scopeType,
          scopeId: nextApplied.scopeId,
          scopeName: nextApplied.scopeName,
          inactive: nextApplied.inactive === true,
        })
      }
    },

    onOpen() {
      const applied = this.data.applied as Scope
      this.setData({
        showPopup: true,
        current: applied,
        currentAllowsMarket: this._allowsMarket(applied.marketId),
      })
    },

    onCancel() {
      const applied = this.data.applied as Scope
      this.setData({
        showPopup: false,
        current: applied,
        currentAllowsMarket: this._allowsMarket(applied.marketId),
      })
    },

    onPickAll() {
      if (!this.data.allowAll) return
      const next: Scope = { scopeType: 'all', scopeId: null, scopeName: '全部市场' }
      this._confirmAndEmit(next)
    },

    onPickMarket(e: WechatMiniprogram.TouchEvent) {
      const marketId = e.currentTarget.dataset.marketId as string
      const market = (this.data.marketList as MarketMini[]).find(m => m.id === marketId)
      if (!market) return
      const currentAllowsMarket = this._allowsMarket(marketId)
      const stores = (this.data.storeListByMarket as Record<string, StoreMini[]>)[marketId] || []
      const firstStore = stores[0]
      const next: Scope = currentAllowsMarket
        ? { scopeType: 'market', marketId, scopeId: marketId, scopeName: market.name }
        : firstStore
          ? {
            scopeType: 'store',
            marketId,
            scopeId: firstStore.storeId,
            scopeName: `${market.name} · ${firstStore.storeName}`,
          }
          : this.data.current as Scope
      this.setData({ current: next, currentAllowsMarket })
    },

    onPickStore(e: WechatMiniprogram.TouchEvent) {
      const storeId = (e.currentTarget.dataset.storeId as string) || ''
      const cur = this.data.current as Scope
      if (!cur.marketId) return
      const market = (this.data.marketList as MarketMini[]).find(m => m.id === cur.marketId)
      if (!market) return

      // "全部门店" → 立即以市场维度生效并关闭
      if (storeId === '') {
        if (!this.data.currentAllowsMarket) return
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
      // 具体门店是终态选择 → 立即 emit 并关闭
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

    // 同步写入 applied + current，避免 loadOptions 异步回填时读到陈旧 current 覆盖选择
    _confirmAndEmit(scope: Scope) {
      this.setData({
        userPicked: true,
        applied: scope,
        current: scope,
        currentAllowsMarket: this._allowsMarket(scope.marketId),
        showPopup: false,
      })
      // 下拉里只有在营门店，显式选择恒为在营
      this.triggerEvent('change', {
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        scopeName: scope.scopeName,
        inactive: false,
      })
    },

    _allowsMarket(marketId?: string) {
      return !!marketId && (this.data.allowedMarketIds as string[]).includes(marketId)
    },
  },
})
