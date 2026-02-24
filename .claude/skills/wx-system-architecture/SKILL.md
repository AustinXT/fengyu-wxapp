---
name: wx-system-architecture
description: 用于规划微信小程序 + CloudBase 系统架构，覆盖平台概览与服务拓扑、项目目录结构、NoSQL/MySQL 服务选型、开发环境搭建、安全架构设计与控制台管理。
metadata:
  title: 微信小程序系统架构设计
  author: fengyu
  version: 1.0.0
---

> 架构设计前请先了解 `.42cog/real.md`（业务约束）和 `.42cog/cog.md`（认知模型）。

## 何时使用此技能

在进行 **微信小程序系统架构设计** 时使用，包括：

- CloudBase 平台架构理解与服务选型
- 小程序项目目录结构规划
- 开发环境搭建与配置
- 安全架构设计（认证、权限、数据访问）
- CloudBase 控制台管理

**不适用于：**
- 页面 UI 设计（请使用 `wx-ui-design`）
- 具体编码实现（请使用 `wx-coding`）
- 数据库表结构设计（请使用 `wx-database-design`）

---

# CloudBase 平台架构概览

## 环境概念

- CloudBase 环境是资源隔离单元，包含数据库、云函数、存储等服务
- 可通过 `envQuery` MCP 工具查询环境 ID
- 不同环境之间数据和资源完全隔离

## 服务拓扑

```text
┌─────────────────────────────────────────────────────────────┐
│                    CloudBase 环境                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  NoSQL 数据库  │  │  云函数       │  │  云存储       │      │
│  │  (文档数据库)  │  │  (Node.js)   │  │  (文件/图片)  │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  MySQL 数据库  │  │  身份认证     │  │  静态网站托管  │      │
│  │  (关系型)      │  │  (微信登录)   │  │  (CDN)       │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
         ↑                    ↑                   ↑
    wx.cloud.database()  wx.cloud.callFunction()  wx.cloud.uploadFile()
         ↑                    ↑                   ↑
┌─────────────────────────────────────────────────────────────┐
│                    微信小程序客户端                           │
└─────────────────────────────────────────────────────────────┘
```

## SDK 初始化

小程序端在 `app.ts` 中初始化：

```typescript
// app.ts
App({
  onLaunch() {
    wx.cloud.init({
      env: 'your-env-id',   // CloudBase 环境 ID
      traceUser: true        // 追踪用户访问（推荐）
    })
  }
})
```

---

# 小程序项目结构

## 标准目录布局

```text
project-root/
├── cloudfunctions/          # CloudBase 云函数
│   ├── createOrder/         # 每个云函数一个目录
│   │   ├── index.js         # 入口文件
│   │   └── package.json     # 依赖声明
│   └── ...
├── miniprogram/             # 小程序前端代码
│   ├── pages/               # 页面模块
│   │   ├── index/           # 首页
│   │   │   ├── index.wxml   # 结构
│   │   │   ├── index.wxss   # 样式
│   │   │   ├── index.ts     # 逻辑
│   │   │   └── index.json   # 页面配置
│   │   └── ...
│   ├── components/          # 公共组件
│   ├── utils/               # 工具函数
│   ├── models/              # 数据层（类型定义）
│   ├── app.ts               # 应用入口
│   ├── app.json             # 应用配置
│   └── app.wxss             # 全局样式
├── typings/                 # TypeScript 类型声明
├── project.config.json      # 项目配置（含 appid）
├── project.private.config.json  # 私有配置
└── package.json
```

## 四文件页面结构

每个页面由 4 个文件组成（缺一不可）：

| 文件 | 用途 | 必须内容 |
|---|---|---|
| `page.wxml` | 页面结构 | 使用原生组件（view/text/image） |
| `page.wxss` | 页面样式 | 750rpx 布局，优先 rpx（border 可用 px） |
| `page.ts` | 页面逻辑 | Page({}) + onLoad/onShow/onShareAppMessage |
| `page.json` | 页面配置 | navigationBarTitleText + usingComponents |

## 配置文件要点

### project.config.json

> **注意**：微信开发者工具使用双配置文件机制：
> - `project.config.json` — 项目共享配置（提交到 git），包含 appid、根目录路径等
> - `project.private.config.json` — 个人开发配置（建议加入 `.gitignore`），包含 `urlCheck`、编译条件等个人偏好
>
> 开发者个人相关的设置（如 `urlCheck`）应放在 `project.private.config.json` 中，避免覆盖团队成员的个人设置。

```json
{
  "appid": "wx1234567890",
  "miniprogramRoot": "miniprogram/",
  "cloudfunctionRoot": "cloudfunctions/",
  "setting": {
    "es6": true,
    "postcss": true,
    "minified": true,
    "lazyCodeLoading": "requiredComponents"
  },
  "libVersion": "latest"
}
```

```json
// project.private.config.json（个人设置，不提交 git）
{
  "setting": {
    "urlCheck": false
  }
}
```

- `appid` 字段**必须配置**，打开开发者工具前确认
- `miniprogramRoot` 指向小程序代码目录
- `cloudfunctionRoot` 指向云函数目录
- `lazyCodeLoading: "requiredComponents"` — 官方推荐，按需加载组件代码，优化启动性能

### libVersion 选项

| 值 | 说明 | 适用场景 |
|---|---|---|
| `"latest"` | 最新版本 | 开发调试 |
| `"trial"` | 预览版 | 测试新特性 |
| `"widelyUsed"` | 广泛使用的稳定版 | **生产环境推荐** |

> 开发阶段可使用 `"latest"`，上线前建议切换为 `"widelyUsed"` 以确保用户基础库兼容性。

---

# CloudBase 服务选型

## NoSQL vs MySQL 决策

| 场景 | 选择 | 原因 |
|---|---|---|
| 需要 `.watch()` 实时推送 | NoSQL | MySQL 不支持实时监听 |
| 复杂关联查询和 JOIN | MySQL | NoSQL 不擅长跨集合 JOIN |
| 灵活/半结构化数据 | NoSQL | 文档模型更灵活 |
| 严格事务一致性 | MySQL | 原生 ACID 事务 |
| 前端直接读取 | NoSQL | `wx.cloud.database()` 直调 |

## 云函数 vs 客户端直调

| 操作 | 选择 | 原因 |
|---|---|---|
| 读取公开数据 | 客户端直调 | 减少延迟，利用安全规则 |
| 写入操作 | 云函数 | 服务端校验权限 |
| 跨集合操作 | 云函数 | 安全规则无法跨集合 |
| 敏感数据处理 | 云函数 | 脱敏、权限校验 |
| 外部 API 调用 | 云函数 | 保护密钥 |

## 数据流图

```text
顾客下单流程：
  小程序 → callFunction('createOrder') → 云函数
    → 1. 校验权限（openid + 门店绑定）
    → 2. 写入 CloudBase NoSQL（触发 watch）
    → 3. 同步 Workfine SQL Server
    → 4. 返回订单 ID

员工端实时更新：
  员工小程序 → db.collection('orders').watch()
    → onChange → 更新日历视图
    → onError → 降级 30 秒轮询
```

---

# 开发环境搭建

## 微信开发者工具

### 打开项目

- **macOS**: `/Applications/wechatwebdevtools.app/Contents/MacOS/cli open --project "/path/to/project"`
- **Windows**: `"C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat" open --project "项目根目录"`
- 项目路径指向**包含 `project.config.json` 的目录**

### 关键检查

1. 确认 `project.config.json` 已配置 `appid`
2. 确认云开发环境已关联
3. 基础库版本建议使用 `latest`（开发阶段）或 `widelyUsed`（生产环境）

### 渲染引擎选型

微信小程序支持两种渲染引擎：

| 引擎 | 配置 | 特点 | 适用场景 |
|---|---|---|---|
| **WebView**（默认） | 无需配置 | 兼容性好，生态成熟 | 大多数项目 |
| **Skyline** | `"renderer": "skyline"` | 更高性能，支持 worklet 动画、手势系统、`list-view`/`grid-view` 等高性能组件 | 追求极致性能/复杂动画 |

> 本项目当前使用 WebView 渲染引擎。Skyline 引擎提供更优的渲染性能和专属组件（如 `list-view`、`grid-view`、`sticky-header`），但需要注意部分 CSS 特性和组件行为与 WebView 存在差异。

### glass-easel 组件框架（新特性参考）

微信新推出的 glass-easel 组件框架支持模板内函数调用、链式 API、动态 slot 等增强能力。当前项目使用标准组件框架即可，如需更灵活的组件开发能力可评估迁移。

### app.json 性能优化配置

```json
{
  "lazyCodeLoading": "requiredComponents",
  "enablePassiveEvent": true
}
```

| 配置 | 说明 |
|---|---|
| `lazyCodeLoading` | 按需加载组件代码，减少启动时间（**官方强烈推荐**） |
| `enablePassiveEvent` | 优化滚动性能，将 touch 事件标记为 passive |

## MCP 配置（CloudBase）

在 `.mcp.json` 中配置 CloudBase MCP：

```json
{
  "mcpServers": {
    "cloudbase": {
      "command": "npx",
      "args": ["@cloudbase/cloudbase-mcp@latest"]
    }
  }
}
```

MCP 提供的工具：环境管理、函数部署、数据库操作、安全规则配置等。

## Icons8 图标资源

用于 tabbar 图标、按钮图标等：

- URL 格式: `https://img.icons8.com/{style}/{size}/{color}/{icon-name}.png`
- `style`: `ios`（线框）/ `ios-filled`（填充）
- `size`: `100`（推荐，文件 < 5KB）
- `color`: 十六进制颜色码（不带 #）
- 使用 `downloadRemoteFile` 工具下载

---

# 安全架构

## 认证模型

微信小程序 + CloudBase 认证是**自动且无缝的**：

1. 用户打开小程序时自动完成认证
2. 调用云函数时，微信自动注入 `OPENID`/`APPID`/`UNIONID`
3. 在云函数中通过 `cloud.getWXContext()` 获取
4. **无需显式登录流程，禁止生成登录页面**

```javascript
// 云函数中获取用户身份
const { OPENID, APPID, UNIONID } = cloud.getWXContext()
// OPENID 始终可用且经过验证
// UNIONID 需绑定开放平台后才可用
```

## 数据库权限模型

| 规则 | 读 | 写 | 适用场景 |
|---|---|---|---|
| `READONLY` | 所有人 | 创建者/管理员 | 公开数据 |
| `PRIVATE` | 创建者/管理员 | 创建者/管理员 | 私有数据 |
| `ADMINWRITE` | 所有人 | 管理员 | 系统管理数据 |
| `ADMINONLY` | 管理员 | 管理员 | 敏感数据 |
| `CUSTOM` | 自定义规则 | 自定义规则 | 精细控制 |

**关键规则：**
- 云函数始终拥有管理员权限
- 小程序端读取利用 `_openid` 自动过滤
- 所有写操作和权限校验应在云函数中完成

## 跨集合操作规则

- 跨集合的读写操作**必须**通过云函数实现
- 前端安全规则只能控制单集合访问
- 事务操作需在云函数中执行 `db.runTransaction()`

---

# 控制台管理

CloudBase 控制台 URL 格式：`https://tcb.cloud.tencent.com/dev?envId=${envId}#/{path}`

详细入口列表参见 [references/console-urls.md](references/console-urls.md)。

---

## 核心行为规则

1. **后端策略**：优先使用 SDK 直调 CloudBase 数据库，仅在需要权限校验、跨集合操作或外部 API 时使用云函数
2. **云函数最小化**：在确保安全的前提下尽可能减少云函数数量（如一个函数处理多种客户端请求，一个函数做数据初始化）
3. **认证规则**：小程序天然免登录，在云函数中获取 OPENID
4. **部署顺序**：先部署云函数后端，再预览前端
5. **安全优先**：所有写操作在云函数中完成，前端仅做安全直读

> 详细编码规范请参考 `wx-coding` 技能。
