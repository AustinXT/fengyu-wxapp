# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

凤御双美容院微信小程序生态系统（monorepo）。各子项目详见其目录下的 CLAUDE.md。

## 技术栈

| 层级 | 技术 |
|------|------|
| 小程序前端 | 微信小程序原生 + Vant Weapp 1.x + TypeScript |
| 云函数 | CloudBase 云函数 (Node.js 18, 纯 JS) |
| 管理后台 | Next.js 15 (App Router) + Tailwind CSS v4 |
| 数据库 | PostgreSQL（自托管，业务主库）|
| ORM | Drizzle ORM（仅 db/ 目录，云函数用原生 SQL） |

## 架构概览

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ fengyu-     │  │ fengyu-     │  │ fengyu-     │
│ client      │  │ staff       │  │ admin       │
│ miniprogram │  │ miniprogram │  │ (Next.js)   │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
  wx.cloud.callFunction          Drizzle ORM
       │                │                │
┌──────▼──────┐  ┌──────▼──────┐        │
│  clientApi  │  │  staffApi   │        │
│ (云函数)     │  │ (云函数)     │        │
└──────┬──────┘  └──────┬──────┘        │
       │                │                │
       └───────┬────────┴────────────────┘
               │
         PostgreSQL
         （业务主库）
```

每个云函数是单入口 action 路由网关：`{ action: 'module.method', payload: {} }`。路由懒加载 `require('./routes/' + module)`。

**运行时 100% PostgreSQL，零 MSSQL 依赖。** WorkFine SQL Server 仅供 `db/scripts/sync-workfine.js` 同步模块连接，云函数不直接访问。

## 全局规范

- 小程序前端**仅允许 TypeScript (`.ts`)**，禁止 `.js`；云函数用 `.js`（CloudBase 不支持 TS 直接运行）
- 认证基于微信 OPENID（`cloud.getWXContext()`），客户和员工使用独立用户表
- 云函数响应格式：`{ code: 0, message: "success", data: {} }`，错误码 -1/-400/-401/-403
- 错误前缀约定：`UNAUTHORIZED:`、`PHONE_REQUIRED:`、`INVALID_PARAMS:`、`PERMISSION_DENIED:`
- PG 连接池 max 5，懒初始化；云函数用原生 `pg` 库写 SQL，不引入 Drizzle
- 订单号格式：`FY-XSD-WX-{YYMMDD}{4位序号}`，使用 advisory lock 防并发
- 品牌主色 `#C0322A`（中国红）

## 常用命令

```bash
docker compose -f docker/docker-compose.yml up -d    # 本地数据库
```

数据库迁移命令见 `db/CLAUDE.md`，云函数部署见 cloudbase-deploy skill，小程序前端使用微信开发者工具打开。

## 规范文档

- `.42cog/cog.md` — 认知模型（核心实体与业务流程）
- `.42cog/real.md` — 现实约束（不可违反的硬规则）
- `.42cog/pm/*.pr.spec.md` — 产品需求规范（backend / client / staff / admin）
- `.42cog/pm/workfine-sync.spec.md` — WorkFine 数据同步规范
- `.42cog/dev/sys.spec.md` — 系统架构规范（各端有独立 sys.spec）
- `.42cog/design/*.ui.spec.md` — UI 设计规范（client / staff / admin）
