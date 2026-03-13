# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

凤御美业管理后台（Admin Panel），基于 Next.js 15 全栈架构。

## 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Next.js 15 (App Router, RSC, Server Actions) |
| 语言 | TypeScript strict |
| 样式 | Tailwind CSS v4 + 自定义 CSS 变量 |
| 组件 | 自建 shadcn/ui 风格组件（无 Radix UI 依赖） |
| 状态 | Zustand（仅 UI 状态）+ Server Component 数据获取 |
| 表单 | React Hook Form + Zod（规划中） |
| 包管理 | bun |

## 目录结构

```
fengyu-admin/
├── src/
│   ├── app/
│   │   ├── (auth)/            # 登录/改密（无 Shell 布局）
│   │   ├── (main)/            # 主布局（Sidebar + TopBar）
│   │   │   ├── dashboard/     # 工作台
│   │   │   ├── orders/        # 订单管理 + 开单
│   │   │   ├── allocations/   # 营业额分配
│   │   │   ├── services/      # 服务单
│   │   │   ├── appointments/  # 预约
│   │   │   ├── org/           # 组织架构
│   │   │   ├── stores/        # 门店
│   │   │   ├── employees/     # 员工
│   │   │   ├── products/      # 商品 + 分类 + SKU
│   │   │   ├── commission/    # 提成矩阵
│   │   │   ├── customers/     # 顾客
│   │   │   ├── coupons/       # 优惠券
│   │   │   ├── permissions/   # 权限
│   │   │   ├── sync/          # 数据同步
│   │   │   ├── logs/          # 操作日志
│   │   │   ├── settings/      # 系统配置
│   │   │   └── data-center/   # 数据中心（P2）
│   │   ├── globals.css        # Tailwind + 品牌色 CSS 变量
│   │   ├── layout.tsx         # 根布局
│   │   └── page.tsx           # 重定向到 /dashboard
│   ├── components/
│   │   ├── ui/                # 基础 UI 组件
│   │   └── layout/            # 布局组件（Sidebar, Topbar, Breadcrumb）
│   └── lib/
│       ├── types.ts           # TypeScript 类型定义
│       ├── mock-data.ts       # Mock 数据（开发用）
│       ├── auth.ts            # 认证工具（当前 mock）
│       ├── menu.ts            # 菜单配置 + 角色可见性
│       └── utils.ts           # cn() + 格式化工具
```

## 常用命令

```bash
bun install           # 安装依赖
bun run dev           # 开发服务器（Turbopack）
bun run build         # 生产构建
bun run lint          # ESLint
```

## 当前状态

前端 UI 已完成，使用 mock 数据。后续需要：
1. 接入 Drizzle ORM（复用 `../db/schema/`）实现 Server Actions
2. 实现 Better Auth 认证（JWT + admin_passwords 表）
3. 实现权限中间件（PERMISSION_MATRIX + buildScopeWhere）
4. CloudBase 云存储图片上传
5. 替换 mock 数据为真实 DB 查询

## 品牌色

- 主色：`#C0322A`（中国红）
- 状态色：待处理 `#D4820A` / 成功 `#3D8A5A` / 进行中 `#5E8BB3` / 完结 `#888888` / 错误 `#D94040`

## 规范文档

- `.42cog/pm/admin.pr.spec.md` — 产品需求规格书
- `.42cog/dev/admin.sys.spec.md` — 系统架构规格书
- `.42cog/design/admin.ui.spec.md` — UI 设计规格书
