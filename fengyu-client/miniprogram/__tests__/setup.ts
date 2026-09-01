/**
 * 微信小程序全局对象 mock
 * 模拟 wx.getStorageSync / wx.setStorageSync 等 API
 */

const storage = new Map<string, any>()

const wx = {
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
