# 陷阱与防错参考

> `wx-coding` 技能参考资料。含 ❌/✅ 代码对比、CloudID 敏感数据完整流程、交付清单。

## iOS Date 解析

```typescript
// ❌ iOS 上返回 Invalid Date
const date = new Date('2025-01-15 09:30:00')

// ✅ 替换为 /
const date = new Date('2025-01-15 09:30:00'.replace(/-/g, '/'))

// ✅ 或 ISO 格式
const date = new Date('2025-01-15T09:30:00')
```

## 页面栈 10 层限制

`wx.navigateTo` 最多 10 层，超出后静默失败。

```typescript
// ❌ 列表→详情→列表→详情… 很快触达上限
wx.navigateTo({ url: '/pages/detail/detail?id=' + id })

// ✅ 深层导航使用 redirectTo（不增加栈）
wx.redirectTo({ url: '/pages/detail/detail?id=' + id })

// ✅ Tab 页必须用 switchTab
wx.switchTab({ url: '/pages/home/home' })
```

## CloudID 必须在 data 顶层

嵌套在 payload 或其他对象内时，微信不会解密，**静默返回原始字符串**。这是最隐蔽的陷阱：不报错，只是解密不生效。

```typescript
// ❌ 嵌套在 payload 内 — 解密静默失败
await wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'auth.bindPhone',
    payload: {
      phoneData: wx.cloud.CloudID(cloudID)   // ❌
    }
  }
})

// ✅ 放在 data 顶层
await wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'auth.bindPhone',
    phoneData: wx.cloud.CloudID(cloudID),     // ✅ 正确位置
    payload: {}
  }
})
```

### 手机号获取完整流程

```typescript
// 前端 — WXML
<button open-type="getPhoneNumber" bindgetphonenumber="onGetPhone">
  授权手机号
</button>
```

```typescript
// 前端 — TS
async onGetPhone(e: WechatMiniprogram.GetPhoneNumberEvent) {
  if (e.detail.errMsg !== 'getPhoneNumber:ok') return
  const cloudID = e.detail.cloudID

  // ✅ CloudID 必须在 data 顶层
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: {
      action: 'auth.bindPhone',
      phoneData: wx.cloud.CloudID(cloudID),   // ✅ 顶层
      payload: {}
    }
  })
}
```

```javascript
// 云函数端 — 直接访问 event.phoneData.data
exports.bindPhone = async (ctx) => {
  const phoneInfo = ctx.event.phoneData   // 已自动解密
  if (phoneInfo.errCode) {
    throw new Error('INVALID_PARAMS: 手机号解密失败')
  }
  const phone = phoneInfo.data.phoneNumber
  // ... 绑定逻辑 ...
}
```

### 微信步数（WeRun）

```typescript
// 前端
const { cloudID } = await wx.getWeRunData()
const res = await wx.cloud.callFunction({
  name: 'myApi',
  data: {
    action: 'werun.getData',
    weRunData: wx.cloud.CloudID(cloudID),   // ✅ 顶层
  }
})
```

```javascript
// 云函数端
const weRunData = ctx.event.weRunData
if (weRunData.errCode) {
  throw new Error('INVALID_PARAMS: 步数数据解密失败')
}
const stepInfoList = weRunData.data.stepInfoList
// stepInfoList: [{ timestamp, step }, ...]
```

**CloudID 关键规则：**
- **禁止** session_key 手动解密 — CloudID 更安全更简单
- **必须** 实现兜底机制处理 cloudID 获取失败
- 需要基础库 2.7.0+

## 环境变量覆盖

```javascript
// ❌ 直接设置，丢失已有变量
await updateFunctionConfig({
  envVariables: { NEW_VAR: 'value' }
})

// ✅ 先读后合并
const current = (await getFunctionDetail({ functionName })).EnvVariables || {}
await updateFunctionConfig({
  envVariables: { ...current, NEW_VAR: 'value' }
})
```

## 运行时不可变更

创建云函数时的 `runtime` 一旦设定**无法修改**，错误选择只能删除重建。推荐 `Nodejs18.15`。

## Auth 缓存过期

Auth 中间件有 5 分钟 LRU 缓存。写操作后不清缓存 → 5 分钟内返回旧数据。

```javascript
// ❌ 绑定手机号后未清缓存
exports.bindPhone = async (ctx) => {
  await auth(ctx, async () => {
    await pg.query('UPDATE ... SET phone = $1 WHERE openid = $2', [phone, OPENID])
    ctx.result = { success: true }
  })
}

// ✅ 写操作后立即清除
const { auth, invalidateAuthCache } = require('../middleware/auth')

exports.bindPhone = async (ctx) => {
  await auth(ctx, async () => {
    await pg.query('UPDATE ... SET phone = $1 WHERE openid = $2', [phone, OPENID])
    invalidateAuthCache(OPENID)   // ✅ 立即清除
    ctx.result = { success: true }
  })
}
```

## onLoad vs navigateBack

`navigateBack()` 返回上一页时**不触发 onLoad**，只触发 `onShow`。

```typescript
// ❌ 仅 onLoad → navigateBack 后数据不刷新
Page({
  onLoad() { this.loadData() },
})

// ✅ onLoad + onShow 双加载
Page({
  onLoad() { this.loadData() },
  onShow() { this.loadData() },
})
```

> 用 `isLoading` 标志位防并发（首次打开时 onLoad + onShow 各调一次）。

---

## 交付精简清单

| # | 检查项 |
|---|---|
| 1 | 所有 `new Date()` 使用 `/` 或 ISO 格式（iOS 兼容） |
| 2 | 深层导航使用 redirectTo/reLaunch（页面栈 ≤ 10） |
| 3 | CloudID 在 data 顶层（非 payload 内） |
| 4 | 环境变量先读后合并 |
| 5 | 写操作后调用 `invalidateAuthCache(OPENID)` |
| 6 | Tab/列表页在 onShow 中也加载数据 |
| 7 | 表单提交有 submitting guard + finally 重置 |
| 8 | 所有 `.ts` 文件，无 `.js` |
