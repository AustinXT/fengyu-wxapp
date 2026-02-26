---
name: implement-feature
description: |
  适用于全栈功能开发工作流。从 .42cog/spec/ 需求文档出发，依次完成数据库设计、
  Schema 迁移、云函数 API 开发、小程序前端页面实现、部署验证的完整链路。
  当用户说"实现某个功能"、"开发新模块"、"做一个新页面+接口"时激活。
argument-hint: '[功能名称或需求描述]'
user-invocable: true
metadata:
  author: fengyu
  version: 1.0.0
  title: 全栈功能开发
  description_zh: 从需求到上线的全栈功能开发工作流
---

# 全栈功能开发工作流

从需求文档到功能上线的完整开发流程。

## 何时使用

- 需要实现一个新的业务功能（涉及数据库 + 后端 + 前端）
- 需求文档已在 `.42cog/spec/` 中描述
- 用户说"实现 XX 功能"、"开发 XX 模块"

## 使用方法

```bash
/implement-feature 预约功能
/implement-feature 会员卡充值模块
```

## 不适用

- 仅修改前端样式（用 `wx-ui-design`）
- 仅修改云函数逻辑（用 `implement-api`）
- 修复线上 bug（用 `debug-production`）

---

## Phase 1: 需求分析

### 1.1 阅读需求文档

读取相关需求文档，理解功能范围：

```text
.42cog/spec/client_pr.md   # 客户端需求
.42cog/spec/staff_pr.md    # 员工端需求
.42cog/spec/backend_pr.md  # 后端需求
```

### 1.2 阅读约束文档

**必须** 阅读以下文件，了解业务硬性约束：

```text
.42cog/real.md   # 现实约束（7 条不可违反规则）
.42cog/cog.md    # 认知模型（实体关系）
```

### 1.3 输出需求摘要

分析后输出结构化摘要，与用户确认：

```text
功能名称：[名称]
涉及端：[ ] 客户端  [ ] 员工端
涉及模块：
  - 数据库：[需要新建/修改的表]
  - API：[需要新建/修改的 action]
  - 页面：[需要新建/修改的页面]
依赖：[依赖的现有模块/接口]
约束检查：[与 real.md 相关的规则]
```

**等待用户确认后再进入下一阶段。**

---

## Phase 2: 数据库设计与迁移

### 2.1 检查现有 Schema

阅读现有 schema 文件，了解表结构和关系：

```text
db/schema/index.ts        # schema 导出索引
db/schema/order.ts        # 订单相关
db/schema/product.ts      # 商品相关
db/schema/user.ts         # 用户相关
db/schema/service.ts      # 服务单相关
db/schema/appointment.ts  # 预约相关
db/schema/enums.ts        # 枚举定义
```

### 2.2 设计新 Schema

使用 Drizzle ORM 编写 schema（参见 `wx-database-design` 技能）：

**关键约定：**
- 表名使用 snake_case
- 主键统一 `id serial` 或 `uuid`
- 必须包含 `created_at` / `updated_at` 时间戳
- 枚举使用 `db/schema/enums.ts` 中的 pgEnum
- WorkFine 关联字段以 `_wf_id` 结尾

### 2.3 生成并执行迁移

```bash
cd db
npm run db:generate   # 生成迁移文件
npm run db:migrate    # 执行迁移（生产环境）
# 或
npm run db:push       # 直接推送（开发环境）
```

验证迁移文件：
- 检查 `db/migrations/` 下新生成的 `.sql` 文件
- 确认 `db/migrations/meta/_journal.json` 已更新
- 阅读 SQL 确认无破坏性变更

---

## Phase 3: 后端 API 开发

### 3.1 确定目标云函数

| 端 | 云函数 | 路由入口 |
|---|---|---|
| 客户端 | `clientApi` | `fengyu-client/cloudfunctions/clientApi/index.js` |
| 员工端 | `staffApi` | `fengyu-staff/cloudfunctions/staffApi/index.js` |

### 3.2 创建路由 Handler

在对应 `routes/` 目录下创建或修改路由文件：

```text
cloudfunctions/clientApi/routes/{module}.js
cloudfunctions/staffApi/routes/{module}.js
```

**Handler 模板：**
```javascript
const pg = require('../db/pg')
const { requirePhone } = require('../middleware/auth')
const { requireFields } = require('../middleware/validate')

exports.newAction = async (ctx) => {
  // 1. 参数校验
  const { param1 } = ctx.event.payload
  requireFields(ctx.event.payload, ['param1'])

  // 2. 权限校验（如需要手机号）
  await requirePhone(ctx)

  // 3. 业务逻辑（PG 查询）
  const result = await pg.query('SELECT ...', [param1])

  // 4. 返回结果
  ctx.result = result.rows
}
```

### 3.3 注册路由

在 `index.js` 的路由映射表中添加新 action：

```javascript
const routes = {
  // ... 现有路由
  'module.newAction': () => require('./routes/module').newAction,
}
```

### 3.4 WorkFine 查询（如需要）

读取 `.42cog/spec/workfine_database.md` 了解 WorkFine 表结构。

**关键约束（来自 real.md）：对 WorkFine SQL Server 仅限 SELECT，严禁写入。**

```javascript
const mssql = require('../db/mssql')

const pool = await mssql.getPool()
const result = await pool.request()
  .input('param', mssql.NVarChar, value)
  .query('SELECT ... FROM UDT_M_xxx WHERE ...')
```

---

## Phase 4: 前端页面开发

### 4.1 创建页面文件

每个小程序页面包含 4 个文件（参见 `wx-ui-design` 和 `wx-coding` 技能）：

```text
pages/{page-name}/
  ├── {page-name}.ts      # 页面逻辑（仅 TypeScript）
  ├── {page-name}.wxml    # 页面结构
  ├── {page-name}.wxss    # 页面样式
  └── {page-name}.json    # 页面配置
```

### 4.2 注册页面路由

在 `miniprogram/app.json` 的 `pages` 数组中添加页面路径。

### 4.3 实现页面逻辑

**TS 页面模板：**
```typescript
const app = getApp<IAppOption>();

async function callClientApi(action: string, payload: Record<string, any> = {}) {
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: { action, payload }
  }) as any;
  if (res.result?.code !== 0) {
    throw new Error(res.result?.message || '请求失败');
  }
  return res.result.data;
}

Page({
  data: {
    isLoading: true,
    // ...
  },

  onLoad(options: Record<string, string>) {
    this.loadData(options);
  },

  onShow() {},

  async loadData(options: Record<string, string>) {
    try {
      this.setData({ isLoading: true });
      const data = await callClientApi('module.action', { id: options.id });
      this.setData({ ...data, isLoading: false });
    } catch (err) {
      console.error('loadData failed:', err);
      this.setData({ isLoading: false });
    }
  }
});
```

### 4.4 UI 实现

- 使用 Vant Weapp 组件时参见 `vant-weapp` 技能
- UI 风格遵循项目黑金奢华主题（参见 `wx-ui-design` 技能）
- 必须使用 rpx 单位，严禁 HTML 标签

### 4.5 页面配置

```json
{
  "navigationBarTitleText": "页面标题",
  "usingComponents": {
    "van-button": "@vant/weapp/button/index"
  }
}
```

---

## Phase 5: 部署与验证

### 5.1 部署云函数

使用 `cloudbase-deploy` 技能部署修改过的云函数：

```text
触发词："部署云函数" 或 "部署 clientApi"
```

### 5.2 冒烟测试

部署后通过 MCP 工具调用 action 验证：

```json
{
  "tool": "invokeFunction",
  "envId": "<ENV_ID>",
  "functionName": "clientApi",
  "params": { "action": "module.newAction", "payload": { "param1": "test" } }
}
```

> **注意：** envId 从 `cloudbaserc.json` 或 `.claude/mcp.json` 中获取。

### 5.3 检查清单

- [ ] 数据库迁移已执行成功
- [ ] 新 action 在路由表中已注册
- [ ] 云函数已部署到云端
- [ ] invokeFunction 返回 `{ code: 0 }`
- [ ] 前端页面已在 app.json 注册
- [ ] 页面 .json 中已注册所需 Vant 组件
- [ ] TypeScript 无编译错误
- [ ] real.md 约束已遵守

---

## Phase 6: 总结与交接

输出实现摘要：

```text
完成功能：[功能名称]
修改文件：
  - db/schema/xxx.ts（新增/修改表）
  - db/migrations/xxxx.sql（迁移文件）
  - cloudfunctions/.../routes/xxx.js（API 路由）
  - cloudfunctions/.../index.js（路由注册）
  - miniprogram/pages/xxx/（前端页面）
  - miniprogram/app.json（页面注册）
新增 API：
  - module.action1 — 功能描述
  - module.action2 — 功能描述
待办事项：[未完成的部分]
```
