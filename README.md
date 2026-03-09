# 凤御双美容院微信小程序

美容院数字化运营的微信小程序生态系统（monorepo），包含顾客端和员工端两个小程序。

## 项目结构

```
fengyu-wxapp/
├── fengyu-client/          # 顾客端小程序（C端）
│   ├── miniprogram/        # 前端代码
│   └── cloudfunctions/     # 云函数（clientApi, payNotify）
├── fengyu-staff/           # 员工端小程序（B端）
│   ├── miniprogram/        # 前端代码
│   └── cloudfunctions/     # 云函数（staffApi）
├── db/                     # 数据库 schema 与迁移（Drizzle ORM）
├── .42cog/                 # 认知框架与规范文档
├── docs/                   # 用户文档
├── notes/                  # 开发者文档与会议纪要
└── sources/                # 原始素材
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | 微信小程序原生 + Vant Weapp 1.x + TypeScript |
| 后端 | CloudBase 云函数 (Node.js 18) |
| 数据库 | PostgreSQL（业务数据）+ SQL Server（WorkFine 基础数据，只读）|
| ORM | Drizzle ORM（db/ 目录） |

## 快速开始

### 本地数据库

```bash
docker compose up -d    # 启动 PostgreSQL
cd db && npm run db:push # 推送 schema
```

### 小程序开发

- **顾客端**：微信开发者工具打开 `fengyu-client/`
- **员工端**：微信开发者工具打开 `fengyu-staff/miniprogram/`

### 云函数依赖

```bash
cd fengyu-client/cloudfunctions/clientApi && npm install
cd fengyu-staff/cloudfunctions/staffApi && npm install
```

## 详细文档

- [CLAUDE.md](./CLAUDE.md) — 完整项目文档（架构、API、规范）
- [.42cog/](./42cog/) — 认知框架与规范文档
