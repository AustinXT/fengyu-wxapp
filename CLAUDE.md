# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

凤御双美容院微信小程序生态系统（monorepo）。

## 项目概述

- **fengyu-client**：顾客端小程序（C端，appid: wx811eb4ded3dfba3f）
- **fengyu-staff**：员工端小程序（B端，appid: wxe3f5d9ee6a94d22d）
- **db**：PostgreSQL 数据库（Drizzle ORM）

两个小程序均运行在**腾讯云开发（CloudBase）**上。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | 微信小程序原生 + Vant Weapp 1.x + TypeScript |
| 后端 | CloudBase 云函数 (Node.js 18, 纯 JS) |
| 数据库 | PostgreSQL（自托管）+ SQL Server（WorkFine，只读）|
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
   ┌───▼────────────────▼───┐
   │  PostgreSQL  │  MSSQL  │
   │  (读写)      │ (只读)   │
   └────────────────────────┘
```

每个云函数是单入口 action 路由网关：`{ action: 'module.method', payload: {} }`。路由懒加载 `require('./routes/' + module)`。

## 目录结构

```
fengyu-wxapp/
├── fengyu-client/
│   ├── miniprogram/           # 前端（详见其 CLAUDE.md）
│   ├── cloudfunctions/
│   │   ├── clientApi/         # API 网关（详见其 CLAUDE.md）
│   │   └── payNotify/         # 支付回调
│   └── cloudbaserc.json       # CloudBase 部署配置（envId: cloud1-3gpht4b01ff88838）
├── fengyu-staff/
│   ├── miniprogram/
│   ├── cloudfunctions/
│   │   └── staffApi/
│   └── cloudbaserc.json       # CloudBase 部署配置（envId: cloud1-9g3ydpg512eecc99）
├── db/                        # 数据库 schema 与迁移
├── docker-compose.yml         # 本地 PostgreSQL（fengyu/fengyu123/fengyu）
└── .42cog/                    # 规范文档与需求文档
```

## 常用命令

### 数据库（db/）

```bash
cd db
npm run db:generate   # 生成迁移文件
npm run db:migrate    # 执行迁移
npm run db:push       # 推送 schema（开发环境）
npm run db:studio     # Drizzle Studio
```

本地 PostgreSQL：`docker compose up -d`（根目录）

### 云函数

云函数无本地运行/测试命令。部署使用 CloudBase MCP 工具或 `tcb` CLI。

云函数依赖安装：
```bash
cd fengyu-client/cloudfunctions/clientApi && npm install
cd fengyu-staff/cloudfunctions/staffApi && npm install
```

### 小程序前端

无构建命令。使用微信开发者工具（DevTools）打开：
- **fengyu-client**：打开 `fengyu-client/`（project.config.json 在此）
- **fengyu-staff**：打开 `fengyu-staff/miniprogram/`（project.config.json 在此，注意不是父目录）

Vant Weapp npm 构建：在 DevTools 中执行"构建 npm"。

## 重要规范

- 小程序前端**仅允许 TypeScript (`.ts`)**，禁止 `.js`
- 云函数本身用 `.js`（CloudBase 运行时不支持 TS 直接运行）
- 认证基于微信 OPENID（`cloud.getWXContext()`），客户和员工使用独立用户表
- 响应格式：`{ code: 0, message: "success", data: {} }`，错误码 -1/-400/-401/-403
- 数据库连接：PG 连接池 max 5，MSSQL max 5 min 1，均为懒初始化
- 订单号格式：`FY-XSD-WX-{YYMMDD}{4位序号}`，使用 advisory lock 防并发

## 双数据库模式

| 数据库 | 用途 | 访问方式 |
|--------|------|----------|
| PostgreSQL | 业务数据（订单、预约、服务单、用户） | `pg.query(sql, params)` / `pg.transaction()` |
| WorkFine SQL Server | 基础数据（门店、员工、客户、商品目录） | 只读查询，表名如 `UDT_M_219`、`UDT_S_287` |

Drizzle ORM 的 schema 定义在 `db/schema/*.ts`，但云函数中用原生 SQL 查询（`pg` 和 `mssql` 库），不引入 Drizzle。

## API 路由表

### clientApi（顾客端）

| 模块 | 接口 |
|------|------|
| auth | login, bindPhone, bindStore |
| store | list, detail |
| product | categories, spuList, skuDetail, spuDetail, hotList, shopInit |
| staff | list, default |
| order | create, pay, offlinePay, list, detail, cancel, appointableItems |
| appointment | create, list, cancel |
| service | detail |

### staffApi（员工端）

| 模块 | 接口 |
|------|------|
| auth | login, bindPhone |
| store | list |
| staff | list, departments |
| customer | search, calendar, detail, paidOrders |
| product | categories, skuDetail, spuList, promotionList |
| order | create, qrcode, confirmOffline, close, resetFailed, list, detail |
| allocation | save, deleteAllocation |
| appointment | list, confirm, checkin |
| service | create, start, complete, list |

## 重要文件

- `.42cog/spec/system_architecture.md` - 系统架构规范
- `.42cog/spec/backend_pr.md` - 后端需求
- `.42cog/spec/client_pr.md` - 客户端需求
- `db/schema/index.ts` - 所有 Drizzle schema 的统一导出
- `fengyu-client/cloudfunctions/clientApi/CLAUDE.md` - clientApi 详细文档
- `fengyu-client/miniprogram/CLAUDE.md` - 顾客端前端详细文档
