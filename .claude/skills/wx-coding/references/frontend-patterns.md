# 前端高级模式

> 本文档是 `wx-coding` 技能的参考资料，涵盖小程序前端开发中的高级模式与封装。

## callApi 封装

统一封装 `wx.cloud.callFunction`，归一化错误处理：

```typescript
// utils/call-api.ts
interface IApiResult<T = any> {
  code: number
  message: string
  data: T
}

async function callApi<T = any>(
  action: string,
  payload: Record<string, any> = {}
): Promise<T> {
  const res = await wx.cloud.callFunction({
    name: 'myApi',     // 替换为实际云函数名
    data: { action, payload }
  })
  const result = (res as any).result as IApiResult<T>
  if (result.code !== 0) {
    throw new Error(result.message || '请求失败')
  }
  return result.data
}

export { callApi, IApiResult }
```

### 页面中使用

```typescript
import { callApi } from '../../utils/call-api'

Page({
  async loadData() {
    try {
      this.setData({ isLoading: true })
      const data = await callApi<IOrder[]>('order.list', { status: 'paid' })
      this.setData({ orderList: data, isLoading: false })
    } catch (err) {
      this.setData({ isLoading: false })
      wx.showToast({ title: (err as Error).message, icon: 'error' })
    }
  }
})
```

## 下拉刷新

```json
// page.json
{ "enablePullDownRefresh": true }
```

```typescript
Page({
  data: { list: [] as IItem[], isLoading: false },

  onLoad() { this.loadData() },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh())
  },

  async loadData() {
    this.setData({ isLoading: true })
    try {
      const data = await callApi<IItem[]>('item.list')
      this.setData({ list: data, isLoading: false })
    } catch (err) {
      this.setData({ isLoading: false })
      wx.showToast({ title: '加载失败', icon: 'error' })
    }
  }
})
```

## 无限滚动（onReachBottom）

```typescript
Page({
  data: {
    list: [] as IItem[],
    page: 1,
    hasMore: true,
    isLoadingMore: false,
  },

  onLoad() { this.loadPage(1) },

  onReachBottom() {
    if (!this.data.hasMore || this.data.isLoadingMore) return
    this.loadPage(this.data.page + 1)
  },

  async loadPage(page: number) {
    const PAGE_SIZE = 20
    this.setData({ isLoadingMore: true })
    try {
      const items = await callApi<IItem[]>('item.list', {
        page, pageSize: PAGE_SIZE
      })
      this.setData({
        list: page === 1 ? items : [...this.data.list, ...items],
        page,
        hasMore: items.length === PAGE_SIZE,
        isLoadingMore: false,
      })
    } catch (err) {
      this.setData({ isLoadingMore: false })
      wx.showToast({ title: '加载失败', icon: 'error' })
    }
  }
})
```

## Tab 切换 + 页面级缓存

```typescript
Page({
  data: {
    activeTab: 0,
    tabs: ['全部', '待支付', '已完成'],
    cache: {} as Record<number, IOrder[]>,
  },

  onTabChange(e: WechatMiniprogram.CustomEvent) {
    const index = e.detail.index as number
    this.setData({ activeTab: index })
    if (!this.data.cache[index]) {
      this.loadTabData(index)
    }
  },

  async loadTabData(tabIndex: number) {
    const status = ['all', 'pending', 'completed'][tabIndex]
    const data = await callApi<IOrder[]>('order.list', { status })
    this.setData({
      [`cache.${tabIndex}`]: data,
    })
  }
})
```

## EventChannel 页面通信

用于 `navigateTo` 跳转页面间的双向通信：

```typescript
// 页面 A：发起导航并监听返回数据
wx.navigateTo({
  url: '/pages/select-item/select-item',
  events: {
    onSelected(data: { itemId: string }) {
      // 页面 B 通过 emit 发送的数据
      console.log('选中:', data.itemId)
    }
  },
  success(res) {
    // 向页面 B 发送初始数据
    res.eventChannel.emit('initData', { category: 'beauty' })
  }
})

// 页面 B：接收并回传数据
Page({
  onLoad() {
    const channel = this.getOpenerEventChannel()
    channel.on('initData', (data) => {
      console.log('收到初始数据:', data.category)
    })
  },

  handleSelect(e: WechatMiniprogram.TouchEvent) {
    const channel = this.getOpenerEventChannel()
    channel.emit('onSelected', { itemId: e.currentTarget.dataset.id })
    wx.navigateBack()
  }
})
```

## localStorage 工具封装

```typescript
// utils/storage.ts

function getStorage<T>(key: string, fallback: T): T {
  try {
    const val = wx.getStorageSync(key)
    return val !== '' && val != null ? (val as T) : fallback
  } catch {
    return fallback
  }
}

function setStorage(key: string, value: any): void {
  try {
    wx.setStorageSync(key, value)
  } catch (err) {
    console.error(`setStorage(${key}) failed:`, err)
  }
}

function removeStorage(key: string): void {
  try {
    wx.removeStorageSync(key)
  } catch {}
}

export { getStorage, setStorage, removeStorage }
```

## WXS 视图层运算

WXS 在视图线程执行，适合频繁格式化；**限制：无 async、无 wx API、无 ES6+**。

```xml
<wxs module="fmt">
  module.exports = {
    maskPhone: function(phone) {
      if (!phone || phone.length < 11) return phone
      return phone.substring(0, 3) + '****' + phone.substring(7)
    },
    formatPrice: function(cents) {
      return (cents / 100).toFixed(2)
    },
    ellipsis: function(str, max) {
      if (!str) return ''
      return str.length > max ? str.substring(0, max) + '...' : str
    }
  }
</wxs>

<text>{{fmt.maskPhone(user.phone)}}</text>
<text>{{fmt.formatPrice(item.price)}}</text>
```

也可以独立 `.wxs` 文件引入：

```xml
<wxs module="fmt" src="../../wxs/format.wxs" />
```

## CloudID 敏感数据

### 手机号获取

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

  // ✅ CloudID 必须放在 data 顶层
  const res = await wx.cloud.callFunction({
    name: 'myApi',
    data: {
      action: 'auth.bindPhone',
      phoneData: wx.cloud.CloudID(cloudID),   // ✅ 顶层
      payload: { /* 其他参数 */ }
    }
  })
}
```

```javascript
// ❌ 错误：CloudID 嵌套在 payload 内 → 解密静默失败！
data: {
  action: 'auth.bindPhone',
  payload: {
    phoneData: wx.cloud.CloudID(cloudID)   // ❌ 嵌套
  }
}

// ✅ 正确：CloudID 在 data 顶层
data: {
  action: 'auth.bindPhone',
  phoneData: wx.cloud.CloudID(cloudID),     // ✅ 顶层
  payload: {}
}
```

```javascript
// 云函数端 — 直接访问 event.phoneData.data
exports.main = async (event) => {
  const phoneInfo = event.phoneData   // 已自动解密
  if (phoneInfo.errCode) {
    return { code: -1, message: '手机号解密失败' }
  }
  const phone = phoneInfo.data.phoneNumber
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

## AI 模型调用

基础库 3.7.1+ 支持通过 `wx.cloud.extend.AI` 调用大模型：

```typescript
const model = wx.cloud.extend.AI.createModel('hunyuan')

// 流式响应
const stream = await model.streamText({
  model: 'hunyuan-lite',
  messages: [{ role: 'user', content: '你好' }]
})

for await (const chunk of stream) {
  // chunk.data 是文本片段（注意：必须访问 .data 属性）
  this.setData({ reply: this.data.reply + chunk.data })
}
```

> `streamText` 返回的每个 chunk 必须通过 `.data` 访问文本内容，直接使用 chunk 对象会得到 `[object Object]`。

## 废弃 API 迁移

| 废弃 API | 替代 API | 用途 |
|---|---|---|
| `wx.getSystemInfo` | `wx.getWindowInfo` | 屏幕宽高、安全区 |
| | `wx.getDeviceInfo` | 品牌、型号、系统版本 |
| | `wx.getAppBaseInfo` | SDKVersion、语言 |
| | `wx.getSystemSetting` | 蓝牙/WiFi/定位开关 |
| `wx.getSystemInfoSync` | 同上各 API 的同步版 | |

```typescript
// ❌ 废弃
const sysInfo = wx.getSystemInfoSync()

// ✅ 推荐
const windowInfo = wx.getWindowInfo()    // 屏幕尺寸、安全区
const deviceInfo = wx.getDeviceInfo()    // 设备品牌、型号
const appInfo = wx.getAppBaseInfo()      // SDK 版本
```

## wx.cloud 前端 API 速查

| API | 用途 | 示例 |
|---|---|---|
| `callFunction` | 调用云函数 | `wx.cloud.callFunction({ name, data })` |
| `database` | 获取数据库引用 | `wx.cloud.database().collection('x')` |
| `database().watch` | 实时数据监听 | `.watch({ onChange, onError })` |
| `uploadFile` | 上传文件到云存储 | `wx.cloud.uploadFile({ cloudPath, filePath })` |
| `downloadFile` | 下载云存储文件 | `wx.cloud.downloadFile({ fileID })` |
| `getTempFileURL` | 获取临时链接 | `wx.cloud.getTempFileURL({ fileList })` |
| `deleteFile` | 删除云存储文件 | `wx.cloud.deleteFile({ fileList })` |
| `CloudID` | 包装敏感数据标识 | `wx.cloud.CloudID(cloudID)` |
