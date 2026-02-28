# CLAUDE.md

凤御双美容院微信小程序生态系统。

## 项目概述

- **fengyu-client**：顾客端小程序（C端）
- **fengyu-staff**：员工端小程序（B端）
- **db**：PostgreSQL 数据库（Drizzle ORM）

两个小程序均运行在**腾讯云开发（CloudBase）**上。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | 微信小程序原生 + Vant Weapp + TypeScript |
| 后端 | CloudBase 云函数 (Node.js) |
| 数据库 | PostgreSQL（自托管）+ SQL Server（WorkFine，只读）|
| ORM | Drizzle ORM |

## 目录结构

```
fengyu-wxapp/
├── fengyu-client/              # 顾客端小程序
│   ├── miniprogram/           # 前端（详见其 CLAUDE.md）
│   └── cloudfunctions/
│       └── clientApi/         # API 网关（详见其 CLAUDE.md）
├── fengyu-staff/              # 员工端小程序
│   ├── miniprogram/
│   └── cloudfunctions/
│       └── staffApi/
├── db/                        # 数据库 schema 与迁移
│   ├── schema/
│   ├── migrations/
│   └── drizzle.config.ts
└── .42cog/                    # 规范文档与需求文档
```

## 数据库命令（db/）

```bash
cd db
npm run db:generate   # 生成迁移文件
npm run db:migrate    # 执行迁移
npm run db:push       # 推送 schema（开发环境）
npm run db:studio     # Drizzle Studio
```

## staffApi 路由（员工端）

| 模块 | 接口 |
|------|------|
| auth | login, bindPhone |
| store | list |
| staff | list, departments |
| customer | search, calendar, detail, paidOrders |
| product | categories, skuDetail |
| order | create, qrcode, confirmOffline, close, resetFailed, list, detail |
| allocation | save, delete |
| appointment | list, confirm, checkin |
| service | create, start, complete, list |

## 重要规范

- 小程序**仅允许 TypeScript (`.ts`)**，禁止 `.js`
- 云函数使用 action 路由：`{ action: 'module.method', payload: {} }`
- 认证基于微信 OPENID（`cloud.getWXContext()`）
- 客户和员工使用独立用户表

## 重要文件

- `.42cog/spec/system_architecture.md` - 系统架构规范
- `db/schema/*.ts` - 数据库 schemas
- `.42cog/spec/backend_pr.md` - 后端需求
- `.42cog/spec/client_pr.md` - 客户端需求
