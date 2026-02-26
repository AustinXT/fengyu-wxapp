# 运行时架构参考

## 运行环境差异

| 平台 | 逻辑层引擎 | 渲染层引擎 | 备注 |
|---|---|---|---|
| **iOS** | JavaScriptCore | WKWebView | 无 JIT 编译，JS 执行性能较低 |
| **Android** | V8 | XWeb（基于 Mobile Chromium） | 性能较好 |
| **Windows** | Chromium | Chromium | 逻辑层与视图层共用 |
| **DevTools** | NW.js | Chromium Webview | 仅用于开发调试 |

**平台差异注意事项：**
- iOS 不支持 JIT，涉及大量计算的逻辑在 iOS 上会明显慢于 Android
- 建议开启 ES6 转 ES5（`project.config.json` 中 `"es6": true`），确保低版本兼容
- WXSS 渲染在不同平台可能存在细微差异，需多端真机测试

---

## 退出状态保留

通过 `onSaveExitState` 生命周期保存退出前的状态数据，下次冷启动时可恢复：

```typescript
Page({
  onSaveExitState() {
    return {
      data: { scrollTop: this.data.scrollTop },
      expireTimeStamp: Date.now() + 60 * 60 * 1000  // 1 小时过期
    }
  },
  onLoad() {
    const exitState = this.exitState
    if (exitState) {
      this.setData(exitState.data)
    }
  }
})
```

---

## 版本更新机制

使用 `wx.getUpdateManager()` 在小程序启动时检查新版本：

```typescript
const updateManager = wx.getUpdateManager()
updateManager.onCheckForUpdate((res) => {
  console.log('是否有新版本：', res.hasUpdate)
})
updateManager.onUpdateReady(() => {
  wx.showModal({
    title: '更新提示',
    content: '新版本已下载，是否重启应用？',
    success(res) {
      if (res.confirm) updateManager.applyUpdate()
    }
  })
})
updateManager.onUpdateFailed(() => {
  // 新版本下载失败，提示用户删除小程序重新进入
})
```
