# Mock 数据开发模式

> 本文档是 `wx-coding` 技能的参考资料，提供通用的 Mock 拦截架构模式与代码模板。

## 适用场景

- 后端 API 尚未开发完成，前端需要先行开发页面
- 无法连接云开发环境（离线开发、网络受限）
- 需要调试特定数据状态（空列表、分页边界、错误响应）
- 快速原型验证 UI 交互

## 目录结构

```text
miniprogram/
├── utils/
│   ├── dev-config.ts     # Mock 开关（默认 false）
│   └── mock-api.ts       # Mock 调度器
├── mock/                  # Mock 数据目录（生产构建排除）
│   ├── index.ts           # 注册表：聚合所有模块 handlers
│   └── {module}.ts        # 按业务模块组织 mock handler
```

## utils/dev-config.ts

```typescript
// utils/dev-config.ts
// ⚠️ 上线前必须确认为 false
export const MOCK_ENABLED = false
```

## utils/mock-api.ts

Mock 调度器核心逻辑：懒加载 + 延迟模拟 + 日志输出。

```typescript
// utils/mock-api.ts
import { MOCK_ENABLED } from './dev-config'

type MockHandler = (payload: Record<string, any>) => any

let handlers: Record<string, MockHandler> | null = null

function getHandlers(): Record<string, MockHandler> {
  if (!handlers) {
    // 懒加载：仅在首次调用时加载 mock 模块
    handlers = require('../mock/index').mockHandlers
  }
  return handlers
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Mock 拦截入口
 * @returns mock 数据，或 null 表示不拦截（走真实 API）
 */
export async function mockCallApi(
  action: string,
  payload: Record<string, any>
): Promise<any | null> {
  if (!MOCK_ENABLED) return null

  const allHandlers = getHandlers()
  const handler = allHandlers[action]
  if (!handler) return null  // 该 action 无 mock，走真实 API

  // 模拟网络延迟（300-800ms），让 loading 态正常运作
  await delay(300 + Math.random() * 500)

  const result = handler(payload)
  console.log(`[Mock] ${action}`, payload, '→', result)
  return result
}
```

**关键设计：**
- `MOCK_ENABLED = false` 时，`mockCallApi` 立即返回 `null`，不加载任何 mock 文件，零运行时开销
- `require()` 懒加载：只在首次命中 mock 时才加载 handler 模块
- 返回 `null` 表示不拦截：支持部分 mock（部分 action 走真实 API，部分走 mock）
- 模拟 300-800ms 延迟：让 loading 骨架屏、下拉刷新等状态正常展示

## mock/index.ts 注册表

```typescript
// mock/index.ts
// 聚合所有模块的 mock handlers
import { itemHandlers } from './item'
import { userHandlers } from './user'

export const mockHandlers: Record<string, (payload: Record<string, any>) => any> = {
  ...itemHandlers,
  ...userHandlers,
  // 按需添加更多模块...
}
```

## Mock Handler 编写规范

每个模块文件导出一个 handlers 对象，key 为 action 名，value 为处理函数。

### handler 签名

```typescript
// mock/{module}.ts
type MockHandler = (payload: Record<string, any>) => any

export const itemHandlers: Record<string, MockHandler> = {
  'item.list': (payload) => { /* ... */ },
  'item.detail': (payload) => { /* ... */ },
}
```

### 模拟成功响应（列表）

```typescript
'item.list': (payload) => ({
  list: [
    { id: '1', name: '示例项目 A', status: 'active', price: 9900 },
    { id: '2', name: '示例项目 B', status: 'inactive', price: 19900 },
  ],
  total: 2,
})
```

### 模拟空列表

```typescript
'item.list': () => ({ list: [], total: 0 })
```

### 模拟分页

```typescript
'item.list': (payload) => {
  const { page = 1, pageSize = 10 } = payload
  const total = 50
  const list = Array.from({ length: Math.min(pageSize, total - (page - 1) * pageSize) }, (_, i) => ({
    id: String((page - 1) * pageSize + i + 1),
    name: `项目 ${(page - 1) * pageSize + i + 1}`,
    status: i % 2 === 0 ? 'active' : 'inactive',
    price: (i + 1) * 1000,
  }))
  return { list, total }
}
```

### 模拟详情

```typescript
'item.detail': (payload) => ({
  id: payload.id || '1',
  name: '示例项目详情',
  description: '这是一段详情描述文字',
  status: 'active',
  price: 9900,
  createdAt: '2025/01/15 10:30:00',
})
```

### 模拟错误

```typescript
// 模拟业务错误 — 直接 throw，callApi 会正常捕获
'item.create': () => {
  throw { code: -400, message: '参数不完整：缺少必填字段' }
}

// 模拟权限错误
'item.delete': () => {
  throw { code: -403, message: '无权限执行此操作' }
}
```

## callApi Mock 改造

在页面的 `callApi` / `callClientApi` / `callStaffApi` 函数中添加 2 行拦截代码。

### 标准版（throw new Error）

```typescript
import { mockCallApi } from '../../utils/mock-api'

async function callApi(action: string, payload: Record<string, any> = {}) {
  // ✅ Mock 拦截（2 行新增）
  const mockResult = await mockCallApi(action, payload)
  if (mockResult !== null) return mockResult

  // 原有逻辑不变
  const res = await wx.cloud.callFunction({
    name: 'myApi',
    data: { action, payload }
  }) as any
  const result = res.result
  if (result.code !== 0) {
    throw new Error(result.message || '请求失败')
  }
  return result.data
}
```

### 保留 err.code 版（本项目常用）

```typescript
import { mockCallApi } from '../../utils/mock-api'

async function callClientApi(action: string, payload: Record<string, any> = {}) {
  // ✅ Mock 拦截（2 行新增）
  const mockResult = await mockCallApi(action, payload)
  if (mockResult !== null) return mockResult

  // 原有逻辑不变
  const res = await wx.cloud.callFunction({
    name: 'myApi',
    data: { action, payload }
  }) as any
  const err = { code: res.result?.code, message: res.result?.message }
  if (err.code !== 0) {
    throw err  // 保留 err.code 用于特殊处理（如 -403 弹手机号授权）
  }
  return res.result.data
}
```

## app.ts Mock 模式处理

App.onLaunch 中的 auth.login 也需要 mock 支持：

```typescript
// app.ts
import { MOCK_ENABLED } from './utils/dev-config'

App({
  globalData: { userInfo: null as IUserInfo | null },
  onLaunch() {
    wx.cloud.init({ env: 'your-env-id', traceUser: true })

    if (MOCK_ENABLED) {
      // Mock 模式：使用模拟用户数据，跳过真实登录
      this.globalData.userInfo = {
        id: 'mock-user-001',
        name: 'Mock 用户',
        phone: '13800138000',
        // 根据项目 IUserInfo 接口补充其他字段
      } as IUserInfo
      console.log('[Mock] 使用模拟用户数据，跳过 auth.login')
      return
    }

    // 原有登录逻辑不变...
    try {
      const cached = wx.getStorageSync('userInfo')
      if (cached) this.globalData.userInfo = cached
    } catch {}
    wx.cloud.callFunction({
      name: 'myApi', data: { action: 'auth.login' }
    }).then((res: any) => {
      if (res.result.code === 0) {
        this.globalData.userInfo = res.result.data
        wx.setStorageSync('userInfo', res.result.data)
      }
    }).catch((err: Error) => console.error('sync failed:', err))
  },
})
```

## 生产安全

### packOptions.ignore 排除 mock 目录

在 `project.config.json` 中配置，确保 mock 文件不会打包到生产版本：

```json
{
  "packOptions": {
    "ignore": [
      { "type": "folder", "value": "mock" }
    ]
  }
}
```

### 交付自检清单

- [ ] `dev-config.ts` 中 `MOCK_ENABLED = false`
- [ ] `project.config.json` 的 `packOptions.ignore` 包含 `mock` 目录
- [ ] 体验版 / 正式版中 console 无 `[Mock]` 日志输出
- [ ] 所有页面的 callApi 在 `MOCK_ENABLED = false` 时走真实 API

## 工作流指引

当收到"使用 mock 数据开发"或"后端还没好，先做前端"类请求时：

1. **创建 mock 基础设施**：按上述目录结构创建 `dev-config.ts`、`mock-api.ts`、`mock/index.ts`
2. **分析项目 action 路由表**：阅读项目实际的云函数 `index.js` 路由映射，确定需要 mock 的 action 列表
3. **生成 mock handlers**：根据项目的实际数据结构（阅读 schema、接口返回值）生成贴合业务的 mock 数据，而非照搬通用模板
4. **改造 callApi**：在相关页面的 callApi 函数顶部添加 2 行 mock 拦截
5. **处理 app.ts**：添加 mock 模式下的用户数据模拟
6. **设置 packOptions**：在 `project.config.json` 中排除 mock 目录
7. **开启 mock**：将 `MOCK_ENABLED` 设为 `true`
8. **开发完成后**：将 `MOCK_ENABLED` 改回 `false`，执行交付自检清单
