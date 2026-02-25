# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个**微信小程序生态系统**（凤御双美容院），包含：
- **fengyu-client**：顾客端小程序（C端）
- **fengyu-staff**：员工端小程序（B端）
- **db**：PostgreSQL 数据库（使用 Drizzle ORM）

两个小程序均运行在**腾讯云开发（CloudBase）**上，使用独立环境。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | 微信小程序（原生开发）+ Vant Weapp UI |
| 后端 | CloudBase 云函数 (Node.js) |
| 数据库 | PostgreSQL（自托管）+ SQL Server（WorkFine，只读）|
| ORM | Drizzle ORM |
| 实时通信 | WebSocket + 轮询降级 |

## 目录结构

```
fengyu-wxapp/
├── fengyu-client/              # 顾客端小程序
│   ├── miniprogram/           # 前端页面与组件
│   └── cloudfunctions/
│       └── clientApi/         # 统一 API 网关（action 路由）
├── fengyu-staff/              # 员工端小程序（尚未完全开发）
│   ├── miniprogram/
│   └── cloudfunctions/
│       └── staffApi/          # 员工端 API 网关
├── db/                        # 数据库 schema 与迁移
│   ├── schema/                # Drizzle ORM schemas
│   ├── migrations/            # SQL 迁移文件
│   ├── drizzle.config.ts      # Drizzle 配置
│   └── package.json
├── notes/                     # 业务需求与规格说明
└── .42cog/                    # 架构规范文档
```

## 常用命令

### 数据库（db/）

```bash
cd db

# 根据 schema 变更生成迁移文件
npm run db:generate

# 执行迁移到远程数据库
npm run db:migrate

# 推送 schema 到数据库（开发环境）
npm run db:push

# 打开 Drizzle Studio 可视化编辑
npm run db:studio
```

### 云函数

```bash
cd fengyu-client/cloudfunctions/clientApi

# 安装依赖
npm install

# 使用 CloudBase MCP 工具部署
# 详见 cloudbase-deploy skill
```

### 小程序

```bash
cd fengyu-client/miniprogram

# 微信开发者工具负责构建和运行
# 开发阶段通常不常用 npm 脚本
```

### TypeScript 配置（重要）

小程序**仅支持 TypeScript (`.ts`)**，禁止使用 JavaScript (`.js`)。

**必须配置：**

1. `project.config.json` 中启用 TypeScript 编译器：
```json
"useCompilerPlugins": ["typescript"]
```

2. 禁止创建同名的 `.js` 文件覆盖 `.ts`：
   - 微信开发者工具默认优先使用 `.js`，如果存在同名 `.js` 会忽略 `.ts`
   - 所有页面逻辑必须写在 `.ts` 文件中

3. 删除项目中所有覆盖 `.ts` 的 `.js` 文件：
```bash
find pages -name "*.js" -type f -delete
```

## 云函数架构

### API 路由模式

所有云函数使用 **action 路由**：

```javascript
// 小程序端调用
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'order.create',  // 模块.方法 格式
    payload: { /* 参数 */ }
  }
})
```

### clientApi 路由（顾客端）

| 模块 | 接口 |
|------|------|
| auth | login, bindPhone |
| store | list |
| product | categories, spuList, skuDetail |
| staff | list |
| order | create, pay, offlinePay, list, detail |
| appointment | create, list, cancel |
| service | detail |

### staffApi 路由（员工端）

| 模块 | 接口 |
|------|------|
| auth | login, bindPhone |
| store | list |
| staff | list, departments |
| customer | search, calendar |
| product | categories, skuDetail |
| order | create, qrcode, confirmOffline, close, resetFailed, list, detail |
| allocation | save, delete |
| appointment | list, confirm, checkin |
| service | create, start, complete, list |

## 数据库策略

### PostgreSQL（读写）
- `client_wechat_users` - 顾客微信用户
- `staff_wechat_users` - 员工微信用户
- `product_spu` - 商品 SPU 元数据
- `product_spu_sku_map` - SKU 与 WorkFine 映射
- `orders` + `order_items` - 订单主表与明细
- `service_orders` + `service_items` - 服务单主表与明细
- `appointments` - 预约记录
- `revenue_allocations` + `revenue_allocation_items` - 营业额分配

### WorkFine SQL Server（只读）
- `UDT_M_219` - 门店列表
- `UDT_S_287` - 员工档案
- `UDT_M_1281` - 可售项目（全国）
- `UDT_M_1383` - 门店自定义项目
- `UDT_M_341` - 院装产品

## 关键模式

### 认证
- 基于微信 OPENID 的认证，通过 `cloud.getWXContext()` 获取
- 手机号绑定用于身份验证
- 客户和员工使用独立的用户表

### 支付流程
1. `order.create` → 创建订单，状态为"待支付"
2. `order.pay` → 返回微信支付参数
3. 用户通过 `wx.requestPayment` 完成支付
4. `payNotify`（回调）→ 更新状态，处理幂等性

### 服务核销
- 原子递减：`UPDATE order_items SET remaining_sessions = remaining_sessions - n WHERE item_flow_no = $1 AND remaining_sessions >= n`
- 幂等：重复调用不会超扣

## 重要文件

- `.42cog/spec/system_architecture.md` - 完整系统架构规范
- `fengyu-client/cloudfunctions/clientApi/index.js` - API 入口
- `db/schema/*.ts` - 数据库 schemas（user, product, order, service, appointment）
- `fengyu-client/miniprogram/app.ts` - CloudBase SDK 初始化
- `notes/backend_pr.md` - 后端需求
- `notes/client_pr.md` - 客户端需求

## Claude Skills

项目在 `.claude/skills/` 目录下包含了以下技能：
- `wx-coding` - 微信小程序 + CloudBase 编码规范
- `wx-database-design` - 数据库设计（NoSQL/MySQL）
- `wx-ui-design` - 小程序 UI 设计
- `wx-quality-assurance` - 质量保证与测试
- `cloudbase-deploy` - CloudBase 云函数部署
- `vant-weapp` - Vant Weapp 组件使用
- `auth-wechat` - 微信认证

执行相关任务时，使用 `/skill` 命令调用这些技能。
