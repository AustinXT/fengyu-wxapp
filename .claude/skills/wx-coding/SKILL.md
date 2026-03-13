---
name: wx-coding
title: 微信小程序编码规范
description: >
  用于编写微信小程序 Page/Component、开发 CloudBase 云函数（Action 路由）、
  集成微信认证与错误处理。适用于所有编码实现任务，不含 UI 设计和 Schema 设计。
metadata:
  title: 微信小程序编码规范
  description_zh: 微信小程序编码约束、CloudBase 云函数模式、认证集成与错误处理
  author: nvoyager
  version: 1.0.3
---

## 何时使用 / 不适用

**使用：** Page/Component 编写、CloudBase 云函数、微信认证、错误处理。
**不适用：** UI → `wx-ui-design` | DB → `wx-database-design` | 架构 → `wx-system-architecture` | Vant → `vant-weapp`

---

## §1 callApi 模式

### 客户端：per-page inline callClientApi

每个页面顶部定义自己的 `callClientApi`，**不从 utils/ 导入**。这是有意为之：`throw err` 保留 `err.code` 用于区分 `-403 PHONE_REQUIRED` 弹授权弹窗。

```typescript
async function callClientApi(action: string, payload: Record<string, any> = {}) {
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: { action, payload }
  }) as any;
  if (res.result?.code !== 0) {
    const err: any = new Error(res.result?.message || '请求失败');
    err.code = res.result?.code;
    err.data = res.result?.data;
    throw err;
  }
  return res.result.data;
}
```

**页面中捕获特定错误码：**

```typescript
catch (err: any) {
  if (err.code === -403) {
    this.setData({ showPhoneAuth: true })  // 弹手机号授权
    return
  }
  wx.showToast({ title: err.message || '请求失败', icon: 'error' })
}
```

### 员工端：共享 callStaffApi

员工端使用 `utils/cloud.ts` 导出的共享函数（含 Mock 拦截）：

```typescript
// utils/cloud.ts
import { mockCallApi } from './mock-api'

export async function callStaffApi<T = any>(
  action: string,
  payload: Record<string, any> = {}
): Promise<T> {
  const mockResult = await mockCallApi(action, payload)
  if (mockResult !== null) return mockResult as T

  const res = await wx.cloud.callFunction({
    name: 'staffApi',
    data: { action, payload }
  }) as any
  if (res.result?.code !== 0) {
    throw new Error(res.result?.message || '请求失败')
  }
  return res.result.data as T
}
```

---

## §2 云函数 ctx 对象契约

每个路由 handler 接收的 `ctx` shape：

```javascript
const ctx = {
  event: { ...event, payload },  // event.payload = 前端传入参数
  context,                        // 云函数 context（functionName 等）
  wxContext: cloud.getWXContext(), // { OPENID, APPID, UNIONID }
  auth: null,                     // auth 中间件注入（用户行数据）
  result: null,                   // handler 写入，返回给前端
}
```

### 错误前缀 → code 映射

| 错误前缀 | code | 含义 |
|---|---|---|
| `UNAUTHORIZED:` | -401 | 身份未验证 |
| `PERMISSION_DENIED:` | -403 | 无权限（角色不足） |
| `PHONE_REQUIRED:` | -403 | 需绑定手机号 |
| `INVALID_PARAMS:` | -400 | 参数校验失败 |
| `NOT_FOUND:` | -404 | 资源不存在 |
| （无前缀） | -1 | 通用错误 |

---

## §3 认证规则

**客户端无登录页。** 微信自动注入 OPENID，`auth.login` 在 App.onLaunch 静默调用。禁止生成登录页面。

**员工端 bindPhone 流程：** 未绑定员工返回 `isNewUser: true` → 前端弹手机号授权 → `auth.bindPhone`（按 phone 找同步行写入 openid）。

**CloudID 必须在 data 顶层。** 嵌套在 payload 内时微信不解密，静默返回原始字符串。

```typescript
// ✅ 正确
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'auth.bindPhone',
    phoneData: wx.cloud.CloudID(cloudID),  // ✅ 顶层
    payload: {}
  }
})

// ❌ 错误 — 解密静默失败
data: {
  action: 'auth.bindPhone',
  payload: { phoneData: wx.cloud.CloudID(cloudID) }  // ❌ 嵌套
}
```

**Auth 缓存失效：** Auth 中间件使用 5 分钟 LRU 缓存。`bindPhone`、`bindStore` 等写操作后必须调用 `invalidateAuthCache(OPENID)`，否则后续请求返回旧数据。

---

## §4 前端防错模式

### submitting guard

表单提交（下单、确认、审核）必须加 `submitting` 标志位防重复提交：

```typescript
async onSubmit() {
  if (this.data.submitting) return
  this.setData({ submitting: true })
  try {
    await callClientApi('order.create', { /* ... */ })
    setTimeout(() => wx.redirectTo({ url: '/pages/orders/orders' }), 1500)
  } catch (err: any) {
    if (err.code === -403) { this.setData({ showPhoneAuth: true }); return }
    wx.showToast({ title: err.message || '提交失败', icon: 'error' })
  } finally {
    this.setData({ submitting: false })
  }
}
```

要点：`finally` 重置、成功后 `redirectTo`（非 navigateTo）防返回重提交。

### onShow 双加载

Tab 页和列表页需要在 `onLoad` **和** `onShow` 中都调用 `loadData()`，因为 `navigateBack()` 只触发 `onShow`。用 `isLoading` 标志位防并发。

### iOS Date

`new Date('2025-01-15')` 在 iOS 上返回 Invalid Date。必须替换 `-` 为 `/` 或使用 ISO 格式 `T`。

---

## §5 Mock 模式

后端未就绪时，在 callApi 顶部添加 2 行 mock 拦截代码。`MOCK_ENABLED = false` 时零运行时开销，支持部分 mock。

> 完整模板（目录结构、dev-config、mock-api、handler 规范、app.ts 处理、生产安全自检）→ [references/mock-data-patterns.md](references/mock-data-patterns.md)

---

## §6 陷阱速查

| # | 陷阱 | 修复 |
|---|---|---|
| 1 | iOS `new Date('2025-01-15')` → Invalid Date | 替换 `-` 为 `/` 或 ISO `T` |
| 2 | 页面栈超 10 层，navigateTo 静默失败 | 用 redirectTo / reLaunch |
| 3 | CloudID 嵌套在 payload 内 → 解密静默失败 | 放 data 顶层 |
| 4 | 环境变量直接覆盖 → 丢失已有变量 | 先读后合并 |
| 5 | 云函数运行时创建后不可变更 | 首次选 Nodejs18.15 |
| 6 | Auth 缓存写后不清 → 5 分钟内返回旧数据 | 写操作后 invalidateAuthCache |

> 详细 ❌/✅ 代码对比 + CloudID 完整流程 → [references/pitfalls.md](references/pitfalls.md)

---

## 参考资源

| 文件 | 内容 |
|---|---|
| [pitfalls.md](references/pitfalls.md) | 陷阱代码对比、CloudID 手机号/WeRun 流程、交付清单 |
| [mock-data-patterns.md](references/mock-data-patterns.md) | Mock 拦截架构、handler 编写规范、生产安全 |
| [cloud-function-patterns.md](references/cloud-function-patterns.md) | Auth LRU 缓存、N+1 预防、_testOpenid、env 管理、cron、部署 |

| 关联技能 | 用途 |
|---|---|
| `wx-ui-design` | WXML/WXSS 布局与样式 |
| `vant-weapp` | Vant Weapp 组件使用 |
| `wx-database-design` | 数据库 Schema 设计 |
| `wx-system-architecture` | 系统架构、认证模型 |
| `cloudbase-deploy` | 部署工作流 |
