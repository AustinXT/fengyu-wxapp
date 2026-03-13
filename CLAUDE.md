# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

凤御双美容院微信小程序生态系统（monorepo）。

## 项目概述

- **fengyu-client**：顾客端小程序（C端）— 详见 `fengyu-client/CLAUDE.md`
- **fengyu-staff**：员工端小程序（B端）— 详见 `fengyu-staff/CLAUDE.md`
- **fengyu-admin**：管理后台（规划中）— 详见 `fengyu-admin/CLAUDE.md`
- **db**：PostgreSQL 数据库（Drizzle ORM）— 详见 `db/CLAUDE.md`

两个小程序均运行在**腾讯云开发（CloudBase）**上。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | 微信小程序原生 + Vant Weapp 1.x + TypeScript |
| 后端 | CloudBase 云函数 (Node.js 18, 纯 JS) |
| 数据库 | PostgreSQL（自托管，业务主库）+ SQL Server（WorkFine，仅同步模块连接）|
| ORM | Drizzle ORM（仅 db/ 目录，云函数用原生 SQL） |

## 架构概览

```
┌─────────────┐  ┌─────────────┐
│ fengyu-     │  │ fengyu-     │
│ client      │  │ staff       │
│ miniprogram │  │ miniprogram │
└──────┬──────┘  └──────┬──────┘
       │                │
  wx.cloud.callFunction
       │                │
┌──────▼──────┐  ┌──────▼──────┐
│  clientApi  │  │  staffApi   │
│ (云函数)     │  │ (云函数)     │
└──────┬──────┘  └──────┬──────┘
       │                │
       └───────┬────────┘
               │
         PostgreSQL
         （业务主库）
```

每个云函数是单入口 action 路由网关：`{ action: 'module.method', payload: {} }`。路由懒加载 `require('./routes/' + module)`。

**运行时 100% PostgreSQL，零 MSSQL 依赖。** WorkFine SQL Server 仅供 `db/scripts/sync-workfine.js` 同步模块连接，云函数不直接访问。

## 目录结构

```
fengyu-wxapp/
├── fengyu-client/             # 顾客端（详见其 CLAUDE.md）
│   ├── miniprogram/           # 前端（详见其 CLAUDE.md）
│   ├── cloudfunctions/
│   │   ├── clientApi/         # API 网关（详见其 CLAUDE.md）
│   │   └── payNotify/         # 支付回调
│   └── cloudbaserc.json
├── fengyu-staff/              # 员工端（详见其 CLAUDE.md）
│   ├── miniprogram/
│   ├── cloudfunctions/
│   │   └── staffApi/
│   └── cloudbaserc.json
├── fengyu-admin/              # 管理后台（规划中）
├── db/                        # 数据库 schema 与迁移（详见其 CLAUDE.md）
├── docker/
│   └── docker-compose.yml     # 本地 PostgreSQL（fengyu/fengyu123/fengyu）
└── .42cog/                    # 认知框架与规范文档
```

## 重要规范

- 小程序前端**仅允许 TypeScript (`.ts`)**，禁止 `.js`
- 云函数本身用 `.js`（CloudBase 运行时不支持 TS 直接运行）
- 认证基于微信 OPENID（`cloud.getWXContext()`），客户和员工使用独立用户表
- 响应格式：`{ code: 0, message: "success", data: {} }`，错误码 -1/-400/-401/-403
- 错误前缀约定：`UNAUTHORIZED:`、`PHONE_REQUIRED:`、`INVALID_PARAMS:`、`PERMISSION_DENIED:`
- 数据库连接：PG 连接池 max 5，懒初始化
- 订单号格式：`FY-XSD-WX-{YYMMDD}{4位序号}`，使用 advisory lock 防并发
- Drizzle ORM 的 schema 定义在 `db/schema/*.ts`，但云函数中用原生 SQL 查询（`pg` 库），不引入 Drizzle

## 常用命令

```bash
# 本地数据库
docker compose -f docker/docker-compose.yml up -d
cd db && npm run db:push       # 推送 schema（开发环境）

# 云函数依赖
cd fengyu-client/cloudfunctions/clientApi && npm install
cd fengyu-staff/cloudfunctions/staffApi && npm install

# 云函数部署
# 使用 CloudBase MCP 工具或 tcb CLI，详见 cloudbase-deploy skill
```

小程序前端无构建命令，使用微信开发者工具（DevTools）打开。Vant Weapp 需在 DevTools 中执行"构建 npm"。

## 规范文档

- `.42cog/cog.md` — 认知模型（核心实体与业务流程）
- `.42cog/real.md` — 现实约束（不可违反的硬规则）
- `.42cog/pm/backend.pr.spec.md` — 后端需求规范
- `.42cog/pm/client.pr.spec.md` — 顾客端需求规范
- `.42cog/pm/staff.pr.spec.md` — 员工端需求规范
- `.42cog/pm/admin.pr.spec.md` — 管理后台需求规范
- `.42cog/pm/workfine-sync.spec.md` — WorkFine 数据同步规范
- `.42cog/dev/sys.spec.md` — 系统架构规范
