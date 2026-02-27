---
name: wx-system-architecture
description: >-
  用于规划微信小程序 + CloudBase 系统架构。覆盖 CloudBase
  服务拓扑、双线程运行时模型、分包性能策略、安全架构与核心架构决策规则。在进行架构设计、技术选型或项目初始化时使用。
metadata:
  author: nvoyager
  title: 微信小程序系统架构设计
  version: 1.0.1
  description_zh: 微信小程序 + CloudBase 系统架构规划指南
---

## 何时使用此技能

在进行 **微信小程序系统架构设计** 时使用，包括：

- CloudBase 平台架构理解与服务选型
- 小程序运行时架构与生命周期理解
- 小程序项目目录结构规划
- 分包策略与启动性能优化
- 开发环境搭建与配置
- 安全架构设计（认证、权限、数据访问）
- CloudBase 控制台管理

**不适用于：**
- 页面 UI 设计（请使用 `wx-ui-design`）
- 具体编码实现（请使用 `wx-coding`）
- 数据库表结构设计（请使用 `wx-database-design`）

## 快速索引

| 决策点 | 参考章节 |
|--------|----------|
| CloudBase 服务选型 | CloudBase 平台架构 |
| 双线程 / setData 性能 | 运行时架构 |
| 分包策略 | 性能架构 |
| 安全认证 | 安全架构 |
| 运行环境差异 / 生命周期细节 | [references/runtime-architecture.md](references/runtime-architecture.md) |
| 开发者工具配置 / MCP / mcporter | [references/dev-environment.md](references/dev-environment.md) |
| 控制台 URL | [references/console-urls.md](references/console-urls.md) |

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

## 云存储 vs 静态网站托管

CloudBase 提供两个独立的存储服务，用途不同：

| | 云存储 | 静态网站托管 |
|---|---|---|
| **用途** | 有隐私要求的文件（用户上传、凭证等） | 可公开访问的文件（Web 页面、公共资源） |
| **访问方式** | 通过临时文件 URL（`getTempFileURL`） | 公共 Web 地址直接访问 |
| **自定义域名** | 不支持 | 支持（需控制台配置） |
| **CDN** | 内置 | 内置 |
| **API** | `wx.cloud.uploadFile` / `downloadFile` | 通过 MCP `getWebsiteConfig` 工具获取域名 |
| **控制台** | `#/storage` | `#/hosting` |

**关键区别：** 静态托管和云存储是**两个不同的存储桶**。访问静态托管的目录路径时，URL **必须以 `/` 结尾**。

## VPC 配置

当云函数需要访问 VPC 内资源（如自托管的 PostgreSQL / MySQL 数据库）时，需配置 VPC：

```javascript
// 创建云函数时通过 func.vpc 指定
{
  vpc: {
    vpcId: "vpc-xxxxx",
    subnetId: "subnet-xxxxx"
  }
}
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

# 小程序运行时架构

## 双线程模型

微信小程序采用**渲染层与逻辑层分离**的双线程架构，两线程通过 Native 层桥接通信：

```text
┌──────────────┐                    ┌──────────────┐
│   渲染层      │                    │   逻辑层      │
│  (Render)    │                    │  (Logic)     │
│              │                    │              │
│  WebView /   │  ←── Native ───→  │  JSCore /    │
│  Skyline     │      Bridge       │  V8          │
│              │                    │              │
│  WXML+WXSS   │                    │  App Service │
│  页面渲染     │                    │  JS 逻辑执行  │
└──────────────┘                    └──────────────┘
       ↑                                   ↑
       └──────── 微信客户端 (Native) ────────┘
                 系统能力、网络请求、
                 存储、媒体等
```

- **渲染层**负责页面结构与样式渲染，每个页面使用一个独立的 WebView/Skyline 线程
- **逻辑层**负责 JavaScript 执行，所有页面共享一个逻辑层线程
- 两层之间的数据传输通过 Native 桥接（`setData` 触发），需要序列化，因此 `setData` 的数据量直接影响性能

## 生命周期状态机

### 启动方式

- **冷启动**：用户首次打开或小程序被销毁后再次打开，需重新加载代码包和初始化
- **热启动**：小程序已在后台存活，用户再次进入，直接从后台切到前台

### 状态流转

```text
冷启动 → [前台运行] → 切后台(5秒后) → [后台运行] → (30分钟/内存不足) → [挂起] → [销毁]
                ↑                                                              │
                └──────────── 用户再次打开（冷启动）─────────────────────────────┘
```

- **前台 → 后台**：用户点击右上角关闭或切换 App，约 5 秒后进入后台状态
- **后台 → 挂起**：后台运行约 30 分钟后，小程序被挂起（停止代码执行，但保留内存状态）
- **挂起 → 销毁**：系统内存不足时主动销毁挂起的小程序
- 可通过 `wx.onMemoryWarning` 监听内存警告，提前做资源释放

### 重启策略

在 `app.json` 中通过 `restartStrategy` 配置重启行为：

| 值 | 行为 |
|---|---|
| `"homePage"`（默认） | 销毁后重新打开时回到首页 |
| `"homePageAndLatestPage"` | 重新打开时回到最后浏览的页面 |

> 平台运行环境差异（iOS/Android/DevTools）、`onSaveExitState` 退出状态保留、版本更新机制详见 [references/runtime-architecture.md](references/runtime-architecture.md)。

---

# 小程序项目结构

## 标准目录布局

```text
project-root/
├── cloudfunctions/          # CloudBase 云函数
│   ├── myFunction/          # 每个云函数一个目录
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

> libVersion 选项说明、开发者工具 CLI 命令、MCP 配置、mcporter、glass-easel 详见 [references/dev-environment.md](references/dev-environment.md)。

---

# 开发环境搭建

## 渲染引擎选型

微信小程序支持两种渲染引擎：

| 引擎 | 配置 | 特点 | 适用场景 |
|---|---|---|---|
| **WebView**（默认） | 无需配置 | 兼容性好，生态成熟 | 大多数项目 |
| **Skyline** | `"renderer": "skyline"` | 更高性能，支持 worklet 动画、手势系统、`list-view`/`grid-view` 等高性能组件 | 追求极致性能/复杂动画 |

> Skyline 引擎提供更优的渲染性能和专属组件（如 `list-view`、`grid-view`、`sticky-header`），但部分 CSS 特性和组件行为与 WebView 存在差异，迁移前需评估兼容性。

> app.json 性能配置（`lazyCodeLoading`、`enablePassiveEvent`）、MCP 配置详见 [references/dev-environment.md](references/dev-environment.md)。

---

# 性能架构

## 启动性能目标

**启动定义：** 从用户点击小程序图标到首页 `Page.onReady` 触发。

官方大盘平均启动耗时（参考目标）：

| 平台 | 平均启动耗时 |
|---|---|
| Android | ≤ 3.0s |
| iOS | ≤ 1.2s |

**三大优化方向：**

1. **代码包体积优化** — 减小主包大小，使用分包加载
2. **代码注入优化** — 按需注入 + 用时注入，减少启动时执行的代码量
3. **首屏渲染优化** — 减少首屏 `setData` 数据量，初始渲染页面骨架

## 分包策略

### 四种分包方式

| 策略 | 说明 | 适用场景 |
|---|---|---|
| **普通分包** | 按功能模块拆分，进入分包页面时下载 | 功能模块较多，主包体积超限 |
| **独立分包** | 无需下载主包即可独立运行 | 活动页、广告落地页等独立入口 |
| **分包预下载** | 进入指定页面时预加载其他分包 | 用户高概率跳转的关联模块 |
| **分包异步化** | 跨分包调用组件和 JS 逻辑 | 分包间存在代码依赖 |

### 按需注入配置

在 `app.json` 中配置：

```json
{
  "lazyCodeLoading": "requiredComponents"
}
```

- **按需注入**：未访问的页面/组件代码不会在启动时注入
- **用时注入**：配合 `"componentPlaceholder"` 使用，组件被渲染时才注入代码

```json
// 页面 page.json 中配置占位组件
{
  "usingComponents": {
    "heavy-component": "/components/heavy/index"
  },
  "componentPlaceholder": {
    "heavy-component": "view"
  }
}
```

## 网络架构

### 域名白名单

小程序的网络请求受域名白名单限制，需在微信公众平台「开发管理 → 开发设置 → 服务器域名」中配置：

- **request 合法域名** — `wx.request` 请求的服务端域名
- **socket 合法域名** — WebSocket 连接域名
- **uploadFile 合法域名** — 文件上传域名
- **downloadFile 合法域名** — 文件下载域名
- **业务域名** — web-view 组件加载的网页域名

**HTTPS 强制要求：** 除本地开发环境外，所有网络请求均要求 HTTPS 协议。

> 文件上传白名单（18 种后缀）详见 [references/dev-environment.md](references/dev-environment.md)。

---

# CloudBase 服务选型

## 数据库选型

CloudBase 提供 NoSQL 文档数据库和 MySQL 关系型数据库两种选择，各有适用场景。详细的选型对比、Schema 设计与查询模式请参考 `wx-database-design` 技能。

## 云函数 vs 客户端直调

| 操作 | 选择 | 原因 |
|---|---|---|
| 读取公开数据 | 客户端直调 | 减少延迟，利用安全规则 |
| 写入操作 | 云函数 | 服务端校验权限 |
| 跨集合操作 | 云函数 | 安全规则无法跨集合 |
| 敏感数据处理 | 云函数 | 脱敏、权限校验 |
| 外部 API 调用 | 云函数 | 保护密钥 |

## 通用数据流模式

```text
读取（直调）：
  小程序 → wx.cloud.database().collection('xxx').get()
    → CloudBase NoSQL 直接返回数据
    → 受安全规则约束（仅返回有权限的文档）

写入（经云函数）：
  小程序 → callFunction('myFunction', { action: 'create', payload })
    → 云函数校验权限（openid + 业务规则）
    → 写入数据库
    → 返回结果

实时监听（watch）：
  小程序 → db.collection('xxx').where({...}).watch()
    → onChange → 实时更新界面
    → onError → 降级轮询
```

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

## 数据库权限概要

CloudBase NoSQL 提供 5 种内置安全规则（`READONLY`、`PRIVATE`、`ADMINWRITE`、`ADMINONLY`、`CUSTOM`），云函数始终拥有管理员权限，小程序端读取利用 `_openid` 自动过滤。详细权限规则与配置请参考 `wx-database-design` 技能。

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

---

# 相关技能索引

| 架构子领域 | 推荐技能 | 说明 |
|---|---|---|
| 数据库选型与 Schema 设计 | `wx-database-design` | NoSQL/MySQL/PostgreSQL 选型、权限规则、迁移 |
| 页面 UI 与组件设计 | `wx-ui-design` | 750rpx 布局、WXSS、Vant 主题、图标资源 |
| Vant Weapp 组件用法 | `vant-weapp` | 复合组件模式、事件类型、常见陷阱 |
| 编码实现 | `wx-coding` | Page/Component 编写、云函数路由、错误处理 |
| 质量保障 | `wx-quality-assurance` | 测试、调试、性能优化、安全审查 |
| 云函数部署 | `cloudbase-deploy` | MCP 部署、环境变量、函数调用验证 |
| 全栈功能开发 | `implement-feature` | 从需求到部署的完整开发工作流 |
| 线上排障 | `debug-production` | 日志分析、错误定位、修复验证 |
