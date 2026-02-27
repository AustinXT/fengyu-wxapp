---
name: wx-quality-assurance
description: |
  适用于微信小程序 + CloudBase 项目的质量保障工作，覆盖测试策略、云函数单元测试、
  部署验证、开发者工具调试、性能优化与安全测试清单。
  当用户进行测试编写、质量检查、性能优化、安全审查时使用。
metadata:
  author: nvoyager
  title: 微信小程序质量保障
  version: 1.0.2
  description_zh: 微信小程序 + CloudBase 项目的测试、调试、性能和安全质量保障指南
---

## 何时使用此技能

在进行 **微信小程序质量保障** 时使用，包括：

- 制定测试策略与编写测试用例
- 云函数单元测试与集成测试
- 部署验证与日志调试
- 微信开发者工具调试
- 数据库操作验证
- 性能优化
- 安全测试与审核准备

**不适用于：**
- UI 设计（请使用 `wx-ui-design`）
- 编码实现（请使用 `wx-coding`）
- 数据库设计（请使用 `wx-database-design`）
- 云函数部署操作（请使用 `cloudbase-deploy`）

---

# 测试策略

## 小程序测试金字塔

```text
        ┌───────────┐
        │  手动测试   │  10% — 真机预览、流程走查
        │  (Manual)  │
        ├───────────┤
        │  集成测试   │  30% — 云函数 + 数据库联调
        │(Integration)│
        ├───────────┤
        │  单元测试   │  60% — 云函数逻辑、工具函数
        │  (Unit)    │
        └───────────┘
```

## 测试重点分配

| 测试类型 | 覆盖目标 | 工具 |
|---|---|---|
| 单元测试 | 云函数业务逻辑、工具函数、数据转换 | Jest / Vitest |
| 集成测试 | 云函数 + 数据库联调、API 契约 | Jest + 测试环境 |
| 手动测试 | 真机预览、流程走查、UI 适配 | 微信开发者工具 |

## 测试文件组织

```text
cloudfunctions/
└── myApi/
    ├── index.ts
    ├── package.json
    └── __tests__/
        ├── index.test.ts        # 单元测试
        └── index.integration.ts # 集成测试
miniprogram/
└── utils/
    ├── formatter.ts
    └── __tests__/
        └── formatter.test.ts
```

---

# 云函数单元测试

## Mock wx-server-sdk

```typescript
// __tests__/mocks/wx-server-sdk.ts
const mockDb = {
  collection: jest.fn().mockReturnThis(),
  doc: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  get: jest.fn(), add: jest.fn(), update: jest.fn(), remove: jest.fn(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  command: {
    eq: jest.fn(v => ({ $eq: v })),
    inc: jest.fn(v => ({ $inc: v })),
    set: jest.fn(v => ({ $set: v })),
  },
  serverDate: jest.fn(() => new Date()),
  runTransaction: jest.fn(async (fn) => await fn(mockDb)),
}
const mockCloud = {
  init: jest.fn(),
  database: jest.fn(() => mockDb),
  getWXContext: jest.fn(() => ({
    OPENID: 'test-openid-001', APPID: 'wx1234567890', UNIONID: undefined,
  })),
  DYNAMIC_CURRENT_ENV: 'test-env',
}
module.exports = mockCloud
module.exports._mockDb = mockDb
```

## 标准云函数测试模板

```typescript
jest.mock('wx-server-sdk', () => require('./mocks/wx-server-sdk'))
const cloud = require('wx-server-sdk')
const { _mockDb: mockDb } = cloud
const { main } = require('../index')

describe('createOrder', () => {
  beforeEach(() => { jest.clearAllMocks() })

  test('成功创建订单', async () => {
    mockDb.add.mockResolvedValue({ _id: 'order-001' })
    const result = await main({
      storeId: 'store-001',
      items: [{ productId: 'p1', quantity: 1, price: 100 }]
    })
    expect(result.code).toBe(0)
    expect(result.data.orderId).toBe('order-001')
  })

  test('参数缺失返回错误', async () => {
    const result = await main({ storeId: '' })
    expect(result.code).toBe(-1)
    expect(result.message).toContain('参数')
  })

  test('未认证用户返回权限错误', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: '' })
    const result = await main({ storeId: 'store-001', items: [{ productId: 'p1', quantity: 1 }] })
    expect(result.code).toBe(-1)
  })
})
```

## Action 路由模式测试

适用于使用 `{ action: 'module.method', payload }` 路由的云函数：

```typescript
jest.mock('wx-server-sdk', () => require('./mocks/wx-server-sdk'))
const { main } = require('../index')

describe('action 路由', () => {
  test('有效 action 正确路由', async () => {
    const result = await main({ action: 'user.getProfile', payload: { userId: 'u001' } })
    expect(result.code).toBe(0)
  })

  test('无效 action 返回错误', async () => {
    const result = await main({ action: 'nonexistent.method', payload: {} })
    expect(result.code).toBe(-1)
  })

  test('缺少 action 返回错误', async () => {
    const result = await main({ payload: {} })
    expect(result.code).toBe(-1)
  })
})
```

## 工具函数测试

```typescript
import { maskPhone, formatPrice } from '../formatter'

describe('maskPhone', () => {
  test('标准手机号', () => expect(maskPhone('13812345678')).toBe('138****5678'))
  test('空值返回空', () => { expect(maskPhone('')).toBe(''); expect(maskPhone(undefined)).toBe('') })
})

describe('formatPrice', () => {
  test('分转元', () => { expect(formatPrice(10000)).toBe('100.00'); expect(formatPrice(99)).toBe('0.99') })
})
```

---

# 部署与集成验证

## TypeScript 编译检查

```bash
cd miniprogram && npx tsc --noEmit        # 小程序前端
cd cloudfunctions/myApi && npx tsc --noEmit # 云函数
```

确保 `tsconfig.json` 中 `strict: true`，关注类型不匹配、未处理 `null`/`undefined`、缺少必需属性。

## npm 构建验证

小程序使用 npm 包需经构建（微信开发者工具 → 工具 → 构建 npm）：

- [ ] `miniprogram/miniprogram_npm/` 目录已生成
- [ ] 组件在 `app.json` 或页面 `.json` 中正确注册
- [ ] 构建后无报错，组件正常渲染
- [ ] 开发者工具「详情 → 本地设置」勾选：上传时自动压缩 JS/WXML/WXSS
- [ ] 使用「代码质量分析」面板清理无依赖文件和未使用组件

## 云函数部署验证

使用 `invokeFunction` MCP 工具验证部署：

```text
invokeFunction({ name: "myApi", data: { action: "health.check", payload: {} } })
# 预期返回：{ code: 0, message: "ok" }
```

**部署后检查清单：**
- [ ] 函数可正常调用，无超时
- [ ] 环境变量已正确配置
- [ ] 依赖已安装（云端自动安装）
- [ ] 返回格式符合 `{ code, message, data }` 契约

## 云函数日志查询

使用 `getFunctionLogs` 获取日志列表，再用 `getFunctionLogDetail` + RequestId 获取详细堆栈。限制：时间间隔不超过 1 天，`Offset + Limit` 不超过 10000。建议使用结构化日志：`console.log(JSON.stringify({ action, params, timestamp }))`。

---

# 微信开发者工具调试

| 面板 | 用途 |
|---|---|
| Console | 查看 `console.log` 输出和运行时错误 |
| Network | 监控云函数调用、文件上传，检查参数和耗时 |
| Storage | 查看/编辑本地存储（`wx.setStorageSync`） |
| Audits | 检测启动性能、运行时性能 |
| Memory | 监控内存使用，识别内存泄漏 |
| 代码质量 | 检测无依赖文件、未使用组件/插件、资源体积 |

**vConsole：** 真机右上角菜单「打开调试」→ 重启后右下角出现 vConsole 按钮，可查看 Console/Network/Storage。注意 vConsole 中对象显示为 JSON 序列化结果，Infinity 显示为 null。

**云函数日志：** 在「云开发控制台 → 云函数 → 日志」中查看，使用结构化日志便于检索。

**实时日志：** 使用 `wx.getRealtimeLogManager()` 记录关键路径日志，可在管理后台「开发 → 运维中心 → 实时日志」查看，不受 console.log 限制。

**体验评分：** 开发者工具 Audits 面板自动评分，关键权重：脚本执行时间(7)、首屏时间(6)、setData 频率和大小(各6)、WXML 节点数(6)、请求耗时(5)。

---

# 数据库测试

## 安全规则测试

1. 验证不同角色的访问权限：
   - 普通用户只能读写自己的数据
   - 管理员可以读写所有数据
   - 未认证用户无法写入

## _openid 隔离测试

```typescript
test('用户只能查询自己的订单', async () => {
  cloud.getWXContext.mockReturnValue({ OPENID: 'user-A' })
  const result = await main({ action: 'order.myList', payload: {} })
  expect(mockDb.where).toHaveBeenCalledWith(
    expect.objectContaining({ _openid: 'user-A' })
  )
})
```

---

# 性能优化

## 启动优化

| 优化项 | 方法 |
|---|---|
| 代码包体积 | 分包加载（subpackages），主包 < 2MB |
| 按需加载 | **`"lazyCodeLoading": "requiredComponents"`**（app.json，官方强烈推荐） |
| 首屏数据 | 使用预拉取（prefetch），减少等待 |
| 图片资源 | 使用 CDN，Icons8（< 5KB），避免 Base64 |
| 初始化与被动事件 | `wx.cloud.init()` 在 `onLaunch` 仅调一次；启用 `"enablePassiveEvent": true` |
| 同步 API | 缓存 `getSystemInfoSync` 结果，启动时减少 Sync 调用 |
| 初始渲染缓存 | 开启 `initialRenderingCache`，加速首屏 |
| 分包预下载 | app.json 配置 `preloadRule`，预下载即将访问的分包 |

## WXML 节点优化

单页面 < 1000 个节点，树深度 < 30 层，子节点 < 60 个。节点过多导致内存增加和样式重排耗时。使用 `wx:if` 而非 `hidden` 移除不需要的子树。

## setData 优化

```typescript
// 错误：频繁调用
items.forEach(item => {
  this.setData({ [`list[${i}]`]: item })  // 多次调用
})

// 正确：合并为一次
const updateData: Record<string, any> = {}
items.forEach((item, i) => {
  updateData[`list[${i}]`] = item
})
this.setData(updateData)  // 一次调用

// 正确：路径更新代替全量替换
this.setData({ 'list[0].status': '已支付' })  // 而非替换整个 list
```

## 图片优化

- 使用 `<image>` 的 `lazy-load` 属性
- 设置合理的 `mode`（`aspectFill` / `widthFix` / `scaleToFill`）
- 列表中避免加载原图，使用缩略图
- **优先使用 webp 格式**（体积更小，微信 `<image>` 组件原生支持）
- 根据实际显示尺寸请求对应大小的图片（如通过 CDN 缩放参数）

---

# 安全测试清单

> 微信官方安全开发原则：① 互不信任（后台校验） ② 最小权限 ③ 禁止明文存敏感数据
> ④ 重要逻辑放后台/云函数 ⑤ 接口必须身份鉴权

## 通用安全验证模式

### 认证验证

- [ ] 云函数中使用 `getWXContext()` 获取 OPENID，不依赖前端传值
- [ ] OPENID 为空时拒绝请求并返回明确错误
- [ ] 所有写操作在云函数中执行，不信任前端数据

### 授权与 RBAC

- [ ] 角色权限在云函数中校验，不依赖前端判断
- [ ] 不同角色调用同一接口返回不同权限范围的数据
- [ ] 越权操作返回明确的权限错误（如普通用户调用管理接口）
- [ ] 平行越权：用户 A 不能通过修改参数访问用户 B 数据
- [ ] 垂直越权：普通用户不能调用管理员接口

### 输入校验

- [ ] 云函数中校验所有输入参数类型和范围
- [ ] 枚举值严格匹配，拒绝非法值
- [ ] 字符串长度限制，防止超长输入

### 幂等性

- [ ] 创建类接口防止重复提交（如使用唯一键或状态检查）
- [ ] 确认/完成类操作重复调用不会重复执行副作用
- [ ] 使用乐观锁或版本号防止并发冲突

### 数据脱敏

返回敏感信息时在云函数中统一脱敏，不依赖前端。官方规范：

| 类型 | 规范 |
|---|---|
| 姓名 | 两字：`*三`；多字：`王*四` |
| 身份证 | `3****************1`（首尾各一位） |
| 手机号 | `156******77`（≥10 位前三后二） |
| 银行卡 | `************1234`（仅后四位） |

不同权限角色返回不同脱敏级别。

### 状态机验证

- [ ] 状态只能按预定义路径流转，拒绝非法状态跳转
- [ ] 状态变更在事务中执行，保证原子性
- [ ] 已终态的记录不可再次变更

### 基础设施安全

- [ ] 数据库连接串、API Key 使用环境变量，不硬编码
- [ ] 跨集合操作通过云函数，不依赖前端拼接
- [ ] 每个集合/表配置了适当的安全规则
- [ ] SQL 使用参数化查询，禁止字符串拼接
- [ ] 用户输入过滤特殊字符（`;`、`|`、`&` 等），防命令注入
- [ ] 文件上传使用白名单限制类型
- [ ] 对并发敏感操作加锁或使用队列（防条件竞争）
- [ ] 生产环境禁止暴露 .git 目录，代码仓库设置适当权限

## 隐私 API 授权测试

自 2023 年起，微信要求隐私 API 需先通过授权。涉及 `wx.getLocation`、`wx.chooseAddress`、`wx.chooseLocation`、`wx.getWeRunData` 等需配置 `requiredPrivateInfos` 并调用 `wx.requirePrivacyAuthorize`。

**测试清单：**
- [ ] `app.json` 中配置 `"usePrivacyCheck": true`
- [ ] 隐私弹窗在 API 调用前展示
- [ ] 用户拒绝授权后有友好提示和降级处理
- [ ] 隐私政策文档已在管理后台上传

---

# 冒烟测试矩阵

部署后对核心 action 逐一验证，确保基本功能正常。

## 冒烟测试矩阵模板

根据项目实际云函数定义，填写各 action 的测试用例。以下为通用示例：

| # | Action | 测试 Payload | 预期结果 |
|---|---|---|---|
| 1 | `auth.login` | `{}` | `code: 0`，返回用户信息或新建用户 |
| 2 | `item.list` | `{ page: 1 }` | `code: 0`，返回列表数组 |
| 3 | `item.detail` | `{ id: 'xxx' }` | `code: 0`，返回详情对象 |
| 4 | `health.check` | `{}` | `code: 0`，返回 `ok` |

> 按项目实际 action 扩展此矩阵，确保覆盖所有核心读写接口。多个云函数入口（如 C 端 / B 端）分别维护各自的冒烟测试表。

## 常见部署后根因速查

部署后接口行为异常时，按此表快速定位根因：

| 现象 | 根因 | 修复方式 |
|---|---|---|
| `relation "xxx" does not exist` | 数据库迁移未执行 | 执行数据库迁移命令 |
| `ETIMEOUT` / `ECONNREFUSED` | 环境变量中数据库地址错误或缺失 | `getFunctionConfig` 检查并修正环境变量 |
| 代码已修改但行为未变 | 云函数未重新部署 | 重新执行 `updateFunctionCode` |
| `Cannot find module 'xxx'` | `package.json` 缺少依赖 | 添加依赖后重新部署 |
| `action "xxx" not found` | 路由未在 `index.js` 中注册 | 在路由映射表中添加 action |

---

# Bug 预防与常见问题

## 已知平台 Bug

### iOS 日期解析

iOS 的 `Date` 构造函数不支持 `YYYY-MM-DD` 格式：

```typescript
// 错误：iOS 上返回 Invalid Date
const date = new Date('2024-01-15')

// 正确：将 - 替换为 /
const date = new Date('2024-01-15'.replace(/-/g, '/'))

// 或使用时间戳
const date = new Date(timestamp)
```

### 导航栈溢出

小程序页面栈上限为 **10 层**，超出后 `wx.navigateTo` 静默失败。栈深 >= 9 时改用 `wx.redirectTo`，tab 页面必须使用 `wx.switchTab`。

### 原生组件层级

`<canvas>`、`<video>`、`<map>` 等原生组件层级最高，普通 `<view>` 无法覆盖：

- 使用 `<cover-view>` 和 `<cover-image>` 覆盖原生组件
- 或使用同层渲染能力（基础库 2.11.0+）

## 常见开发问题排查

### 白屏问题

| 可能原因 | 排查方法 |
|---|---|
| JS 运行时错误 | Console 面板查看红色错误 |
| 页面路径未注册 | 检查 `app.json` 的 `pages` 配置 |
| 分包配置错误 | 检查 `subpackages` 路径是否正确 |
| setData 数据过大 | 检查 setData 数据量（单次建议 < 256KB） |

### 组件未注册

在页面 `.json` 或 `app.json` 的 `usingComponents` 中注册组件。排查：组件路径正确、npm 包已构建、`miniprogram_npm` 目录存在。

### npm 构建失败

- 确认 `package.json` 在 `miniprogram/` 目录下
- `project.config.json` 中 `setting.packNpmManually` 配置正确
- 清除 `miniprogram_npm` 后重新构建

### 云函数超时

- 默认超时 3 秒，可在云开发控制台调整（最大 60 秒）
- 检查数据库查询是否缺少索引
- 检查是否有未 await 的 Promise
- 大数据操作考虑分批处理

## 小程序审核准备清单

| 检查项 | 说明 |
|---|---|
| 类目匹配 | 小程序服务类目与实际功能一致 |
| 功能完整 | 所有页面可正常访问，无空白页或死链 |
| 测试账号 | 如需登录，提供审核用测试账号 |
| 隐私与合规 | 配置隐私协议；UGC 内容需有审核机制 |
| 虚拟支付 | iOS 端不可使用虚拟支付（需走苹果 IAP） |
| 授权说明 | 获取用户信息需说明用途；版本更新说明清晰 |

---

## 示例

**示例 1：新增 API 后编写测试** — 阅读云函数源码 → 用 Mock 模板搭建测试 → 编写正向/反向用例 → 验证幂等性。

**示例 2：生产问题调试** — `getFunctionLogs` 获取错误日志 → `getFunctionLogDetail` 查看堆栈 → 本地复现并编写回归测试 → `invokeFunction` 验证修复。

**示例 3：提审前质量检查** — `tsc --noEmit` 编译检查 → 运行测试用例 → 安全清单核验 → 审核准备清单核验 → Bug 预防项检查。
