/**
 * 微信小程序全局对象 mock
 * 模拟 wx.getStorageSync / wx.setStorageSync 等 API
 */

const storage = new Map<string, any>()

/**
 * IntersectionObserver mock（issue #248 的 utils/cover-window 用）。
 * 不模拟真实相交计算，只把 observe 的选择器与回调记下来，由测试手动喂相交结果。
 */
interface FakeObserver {
  options: any;
  relativeToSelector: string;
  relativeToMargins: any;
  observeSelector: string;
  callback: ((res: any) => void) | null;
  disconnected: boolean;
  relativeTo(selector: string, margins?: any): FakeObserver;
  relativeToViewport(margins?: any): FakeObserver;
  observe(selector: string, cb: (res: any) => void): void;
  disconnect(): void;
}

const observers: FakeObserver[] = []
let observerFactoryThrows = false
let observerWiringThrows = false

const wx = {
  /** nav-bar / workbench 等页面在用；测试里同步执行即可 */
  nextTick(cb: () => void) {
    cb()
  },

  createIntersectionObserver(_ctx: any, options?: any): FakeObserver {
    if (observerFactoryThrows) throw new Error('IntersectionObserver unavailable')
    const inst: FakeObserver = {
      options,
      relativeToSelector: '',
      relativeToMargins: null,
      observeSelector: '',
      callback: null,
      disconnected: false,
      relativeTo(selector, margins) {
        if (observerWiringThrows) throw new Error('relativeTo failed')
        inst.relativeToSelector = selector
        inst.relativeToMargins = margins
        return inst
      },
      relativeToViewport(margins) {
        inst.relativeToMargins = margins
        return inst
      },
      observe(selector, cb) {
        inst.observeSelector = selector
        inst.callback = cb
      },
      disconnect() {
        inst.disconnected = true
      },
    }
    observers.push(inst)
    return inst
  },

  __getObservers() {
    return observers
  },
  __lastObserver(): FakeObserver | undefined {
    return observers[observers.length - 1]
  },
  __setObserverFactoryThrows(v: boolean) {
    observerFactoryThrows = v
  },
  /** relativeTo/observe 接线抛错（瞬态），与工厂抛错（能力缺失）区分开 */
  __setObserverWiringThrows(v: boolean) {
    observerWiringThrows = v
  },
  __resetObservers() {
    observers.length = 0
    observerFactoryThrows = false
    observerWiringThrows = false
  },

  getStorageSync(key: string) {
    return storage.get(key) ?? ''
  },
  setStorageSync(key: string, value: any) {
    storage.set(key, value)
  },
  removeStorageSync(key: string) {
    storage.delete(key)
  },
  clearStorageSync() {
    storage.clear()
  },
  // bindPhoneWithCloudID 等工具用到 loading UI，测试环境静默
  showLoading(_options?: { title?: string; mask?: boolean }) {},
  hideLoading() {},
  // 用于测试间清理
  __resetStorage() {
    storage.clear()
  },
}

// 挂载到 globalThis
;(globalThis as any).wx = wx
