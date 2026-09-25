// components/mgmt-scope-picker — scope 驱动的市场/门店二级筛选器
import { callStaffApi } from '../../utils/cloud'
import { resolveDefaultMgmtScope } from '../../utils/mgmt-scope'

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
  /** 权限内门店组织节点已停用的门店（不进下拉）；null = 服务端查询失败、未知 */
  inactiveStores?: StoreMini[] | null
}

const DEFAULT_ALL: Scope = { scopeType: 'all', scopeId: null, scopeName: '全部市场' }

Component({
  properties: {
    defaultScope: {
      type: Object,
      value: { scopeType: 'all', scopeId: null, scopeName: '全部市场' } as Scope,
    },
    // 页面以 summary 回包确认的停用状态（#400）：门店在会话中被启停时同步触发器上的「（已停用）」
    appliedInactive: { type: Boolean, value: false },
    // false = 当前范围是用户显式选的：落在停用门店时只标注、不自动换店
    autoCorrect: { type: Boolean, value: true },
    // true = 当前范围仍是页面初判：拿到 scopeOptions 后按 resolveDefaultMgmtScope 纠正一次（#424），随后广播 defaultresolved。
    // 与 autoCorrect 分开：autoCorrect 在 summary 首次成功后就关，而初判纠正与 summary 并发，不能因 summary 先回而跳过
    resolveDefault: { type: Boolean, value: false },
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
    // null = 未知（旧云函数不下发 / 查询失败）：不做停用纠正，也不撤已知的停用标记
    inactiveStoreIds: null as string[] | null,
    optionsLoaded: false,
    optionsSeq: 0,
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
      if (def.scopeType === applied.scopeType && def.scopeId === applied.scopeId) {
        // 同一范围只是启停标记变了（页面据 summary 回包确认）：照抄，不重新校正、不广播。
        // 若拿缓存的 inactiveStoreIds 重新校正，会把服务端刚确认的停用撤掉 → change → 重新 summary →
        // 又确认停用 …… 形成请求死循环（#400 评审发现）
        if (!!def.inactive !== !!applied.inactive) {
          this.setData({ 'applied.inactive': !!def.inactive, 'current.inactive': !!def.inactive })
        }
        return
      }
      this.setData({ applied: def, current: def })
      // 页面 initDashboard 在同一次 setData 里下发 defaultScope + resolveDefault（#424）：依赖框架「同批属性先全部提交、
      // 再派发 observers」，此处读到的 resolveDefault 已是新值。若 optionsLoaded 此刻为 false，纠正在首次 loadOptions 里做
      if (this.data.optionsLoaded) this._normalizeApplied()
    },
    appliedInactive(inactive: boolean) {
      const applied = this.data.applied as Scope
      if (applied.scopeType !== 'store' || !!applied.inactive === !!inactive) return
      this.setData({ 'applied.inactive': !!inactive, 'current.inactive': !!inactive })
    },
  },

  methods: {
    /**
     * 拉范围数据。首次加载后校正默认范围；之后每次打开弹窗重拉（会话中门店可能被启停），
     * 重拉只刷新可选列表、不动当前范围——当前范围的启停由页面按 summary 回包同步，不在这里自动换店。
     */
    async loadOptions() {
      const seq = this.data.optionsSeq + 1
      const initial = !this.data.optionsLoaded
      this.setData({ optionsSeq: seq })
      try {
        const res = await callStaffApi<ScopeOptionsResp>('mgmtDashboard.scopeOptions', {})
        if (seq !== this.data.optionsSeq) return
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
          inactiveStoreIds: Array.isArray(res.inactiveStores)
            ? res.inactiveStores.map((store) => store.storeId)
            : null,
          optionsLoaded: true,
        })
        if (initial) this._normalizeApplied()
      } catch (err) {
        if (seq !== this.data.optionsSeq) return
        // 重拉失败保留已有列表，不打扰；首次失败才提示
        if (initial) wx.showToast({ title: '加载范围失败', icon: 'none' })
      }
    },

    /** 按已加载的范围数据校正 applied（回填名称 / 纠正停用门店），有变化才广播 change */
    _normalizeApplied() {
      const marketList = this.data.marketList as MarketMini[]
      const storeListByMarket = this.data.storeListByMarket as Record<string, StoreMini[]>
      const allowedMarketIds = this.data.allowedMarketIds as string[]

      const applied = this.data.applied as Scope
      let nextApplied = applied
      // 默认范围规则对齐 admin（#424）：页面初判只凭登录缓存（不知道市场下有没有在营门店），
      // 这里按 scopeOptions 纠正——如「店长 + hr@品项公司」初判落品项公司，纠正到门店。
      // 落在已停用门店的交给下方 #400 逻辑：它要尊重 autoCorrect（数字展示过后门店被停用，重建时不换店）
      const onKnownInactive = applied.scopeType === 'store'
        && ((this.data.inactiveStoreIds as string[] | null) || []).includes(applied.scopeId || '')
      // 弹窗开着时不纠正（首次加载失败、onOpen 重拉才首次拿到选项）：会覆盖弹窗里正在选的项
      const resolving = this.properties.resolveDefault && !this.data.userPicked && !onKnownInactive && !this.data.showPopup
      if (resolving) {
        const resolved = resolveDefaultMgmtScope(
          {
            allowAll: this.data.allowAll,
            allowedMarketIds,
            markets: marketList.map((m) => ({ ...m, stores: storeListByMarket[m.id] || [] })),
          },
          applied,
          getApp<IAppOption>().globalData.managerStoreIds || [],
        )
        if (resolved) nextApplied = resolved
        // 初判纠正每个会话只做一次：页面据此关掉 resolveDefault。否则 wx:if 切 tab 重建 picker 时会再纠正一遍，
        // 把会话中组织变动后、已展示过数字的范围换掉（违背 #400「展示过就不换店」）
        this.triggerEvent('defaultresolved')
      }
      // 若调用方传入的 defaultScope 是 market 维度但 scopeName / marketId 缺失（页面层占位），
      // 按返回数据回填真实市场名，并广播一次 change 同步页面显示。
      if (nextApplied.scopeType === 'market' && nextApplied.scopeId && (!nextApplied.scopeName || !nextApplied.marketId)) {
        const marketId = nextApplied.scopeId
        const m = marketList.find(x => x.id === marketId)
        if (m) nextApplied = { ...nextApplied, marketId: m.id, scopeName: m.name }
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
      const knownInactive = this.data.inactiveStoreIds as string[] | null
      if (knownInactive) {
        const inactiveIds = new Set(knownInactive)
        if (nextApplied.scopeType === 'store' && nextApplied.scopeId && inactiveIds.has(nextApplied.scopeId)) {
          // 两份列表出自两条查询（非同一快照），同一家店可能两边都有 → 停用优先，替代门店须不在停用集合里
          const firstActiveOf = (m: MarketMini) => (storeListByMarket[m.id] || []).find((store) => !inactiveIds.has(store.storeId))
          const market = marketList.find((m) => !!firstActiveOf(m))
          const firstActive = market ? firstActiveOf(market) : undefined
          nextApplied = market && firstActive && this.properties.autoCorrect
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
          marketId: nextApplied.marketId,
          inactive: nextApplied.inactive === true,
        })
      }
    },

    onOpen() {
      // 每次打开都重拉：首次加载失败时补救；会话中门店被启停时刷新可选列表（#400 评审发现）
      this.loadOptions()
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
      // 首次选项是在弹窗开着时才拿到的（首次加载失败、onOpen 重拉）：当时跳过的默认纠正在关弹窗后补做（#424）。
      // 纠正过后页面会关掉 resolveDefault，这里不会重复纠正
      if (this.properties.resolveDefault && !this.data.userPicked && this.data.optionsLoaded) this._normalizeApplied()
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
      // 下拉只列在营门店；仅在「两条查询之间被停用」的窗口里会选到停用门店，按停用集合如实标注
      const inactive = scope.scopeType === 'store'
        && ((this.data.inactiveStoreIds as string[] | null) || []).includes(scope.scopeId || '')
      const next: Scope = { ...scope, inactive }
      this.setData({
        userPicked: true,
        applied: next,
        current: next,
        currentAllowsMarket: this._allowsMarket(next.marketId),
        showPopup: false,
      })
      this.triggerEvent('change', {
        scopeType: next.scopeType,
        scopeId: next.scopeId,
        scopeName: next.scopeName,
        // 带上所属市场：门店日后停用、picker 重建时已无法从在营列表反推市场
        marketId: next.marketId,
        inactive,
        userPicked: true,
      })
    },

    _allowsMarket(marketId?: string) {
      return !!marketId && (this.data.allowedMarketIds as string[]).includes(marketId)
    },
  },
})
