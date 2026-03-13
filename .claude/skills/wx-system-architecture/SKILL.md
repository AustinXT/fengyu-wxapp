---
name: wx-system-architecture
description: >-
  Design and validate 微信小程序 + CloudBase 系统架构。适用于架构选型、安全规则设计、 开发环境初始化。覆盖
  CloudBase 服务拓扑、认证模型与核心架构约束。
metadata:
  author: opc
  title: 微信小程序系统架构设计
  description_zh: 微信小程序 + CloudBase 系统架构设计，覆盖服务拓扑、认证模型与核心约束
  version: 1.0.2
---

## 何时使用此技能

在进行 **微信小程序系统架构设计** 时使用，包括：

- CloudBase 平台服务选型与配置
- 安全架构设计（认证、权限、数据访问）
- 开发环境搭建与 MCP 配置
- CloudBase 控制台管理

**不适用于：**
- 页面 UI 设计（请使用 `wx-ui-design`）
- 具体编码实现（请使用 `wx-coding`）
- 数据库表结构设计（请使用 `wx-database-design`）

## 快速索引

| 决策点 | 参考位置 |
|--------|----------|
| 开发者工具 MCP 配置 / 文件上传白名单 | [references/dev-environment.md](references/dev-environment.md) |
| 控制台 URL | [references/console-urls.md](references/console-urls.md) |

---

## 陷阱与约束

## 静态托管 vs 云存储：两个独立存储桶

CloudBase 有**两个独立存储服务**，混淆会导致 404 或权限错误：

| | 云存储 | 静态网站托管 |
|---|---|---|
| **用途** | 有隐私要求的文件（用户上传、凭证） | 可公开访问的文件（Web 页面、公共资源） |
| **访问方式** | 临时文件 URL（`getTempFileURL`） | 公共 Web 地址直接访问 |
| **API** | `wx.cloud.uploadFile` / `downloadFile` | 通过 MCP `getWebsiteConfig` 获取域名 |
| **控制台** | `#/storage` | `#/hosting` |

**陷阱：** 访问静态托管目录路径时，URL **必须以 `/` 结尾**，否则返回 404。

## 禁止生成登录页

微信小程序 + CloudBase 认证是**自动且无缝的**：

1. 用户打开小程序时自动完成认证
2. 调用云函数时，微信自动注入 `OPENID`/`APPID`/`UNIONID`
3. 云函数通过 `cloud.getWXContext()` 获取
4. **无需显式登录流程，禁止生成登录页面**

```javascript
// 云函数中获取用户身份 — 无需前端传入任何凭证
const { OPENID, APPID, UNIONID } = cloud.getWXContext()
```

## 跨集合操作必须走云函数

前端安全规则只能控制**单集合**访问。跨集合读写、事务操作（`db.runTransaction()`）必须通过云函数实现。

## 双配置文件机制

微信开发者工具使用两个配置文件：

- `project.config.json` — 项目共享配置（提交 git），含 appid、根目录路径
- `project.private.config.json` — 个人开发配置（加入 `.gitignore`），含 `urlCheck` 等个人偏好

**陷阱：** 将 `urlCheck` 等个人设置放入 `project.config.json` 会覆盖团队成员的配置。

## libVersion 生产建议

| 值 | 适用场景 |
|---|---|
| `"latest"` | 开发调试 |
| `"widelyUsed"` | **生产环境推荐** — 确保用户基础库兼容性 |

## enablePassiveEvent

在 `app.json` 中设置 `"enablePassiveEvent": true` 可优化滚动性能（将 touch 事件标记为 passive）。遗漏此配置会导致体验评分扣分。

---

## 核心行为规则

1. **云函数网关**：所有数据访问通过云函数 action 路由网关，前端不直调数据库
2. **云函数最小化**：一个函数处理多种请求（action 路由），减少函数数量
3. **认证规则**：小程序天然免登录，云函数中获取 OPENID，禁止生成登录页
4. **部署顺序**：先部署云函数后端，再预览前端
5. **安全优先**：所有写操作在云函数中完成，前端仅做安全直读

---

## Action 路由网关骨架

```javascript
// 云函数入口 — 单函数多 action 路由
exports.main = async (event, context) => {
  const { action, payload } = event
  const [module, method] = action.split('.')
  const handler = require(`./routes/${module}`)
  return handler[method](payload, context)
}
```

---

## 相关技能索引

| 架构子领域 | 推荐技能 | 说明 |
|---|---|---|
| 数据库选型与 Schema 设计 | `wx-database-design` | NoSQL/MySQL/PostgreSQL 选型、权限规则、迁移 |
| 页面 UI 与组件设计 | `wx-ui-design` | 750rpx 布局、WXSS、Vant 主题、图标资源 |
| Vant Weapp 组件用法 | `vant-weapp` | 复合组件模式、事件类型、常见陷阱 |
| 编码实现 | `wx-coding` | Page/Component 编写、云函数路由、错误处理 |
| 质量保障 | `wx-quality-assurance` | 测试、调试、性能优化、安全审查 |
| 云函数部署 | `cloudbase-deploy` | MCP 部署、环境变量、函数调用验证 |
| 全栈功能开发 | `wx-implement-feature` | 从需求到部署的完整开发工作流 |
| 线上排障 | `wx-debug-production` | 日志分析、错误定位、修复验证 |
