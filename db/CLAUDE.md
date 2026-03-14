# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

PostgreSQL 数据库层，使用 Drizzle ORM 管理 schema 定义与迁移。

## Schema 模块

定义在 `schema/*.ts`，统一从 `schema/index.ts` 导出：

| 模块 | 表 | 说明 |
|------|-----|------|
| org | org_nodes, stores | 组织架构树（邻接表）+ 门店详情 |
| product | product_categories, products, product_skus | 品项分类 + 商品 + 规格 |
| user | client_wechat_users, staff_wechat_users | 微信用户（客户端含顾客档案 + 员工端含员工档案） |
| order | sale_orders, sale_items, sale_allocations | 订单 + 销售明细 + 营业额分配 |
| appointment | appointments | 预约记录 |
| service | service_orders, service_items | 护理单 + 护理明细 |
| permission | permission_roles | 权限角色分配 |
| commission | commission_rate_matrix | 提成比例矩阵 |
| coupon | coupon_templates, user_coupons | 优惠券模板 + 用户券实例 |
| store-unbind | store_unbind_requests | 门店解绑申请 |
| operation-log | operation_logs | 操作审计日志 |
| points | member_levels, customer_points, point_transactions | 积分系统 |
| message | messages | 消息中心 |
| prepaid-card | prepaid_cards, card_transactions | 充值卡 + 流水 |
| service-commission | service_commissions | 服务提成（手工费/卡数提成） |
| pickup | pickup_records | 院装产品提货记录 |
| system-config | system_configs | 系统配置（键值对） |
| enums | — | TypeScript 枚举定义 |

## 命令

```bash
npm run db:generate   # 生成迁移文件（schema 变更后）
npm run db:migrate    # 执行迁移（生产环境）
npm run db:push       # 推送 schema（开发环境，跳过迁移文件）
npm run db:studio     # Drizzle Studio 可视化管理
```

迁移前需设置环境变量 `DATABASE_URL`（或在 `.env` 中配置）。Drizzle 配置见 `drizzle.config.ts`，启用了 strict 模式（破坏性变更需确认）。

## 本地数据库

```bash
# 从 monorepo 根目录启动
docker compose -f docker/docker-compose.yml up -d

# 连接信息
# host: localhost:5432, db: fengyu, user: fengyu, password: fengyu123

# 进入 psql
docker exec -it fengyu-postgres psql -U fengyu -d fengyu
```

## 同步脚本

`scripts/` 目录下的同步脚本将 WorkFine（SQL Server）数据单向同步到 PostgreSQL：

- `sync-workfine.js` — 综合同步（组织架构、员工、顾客）
- `sync-products-from-workfine.js` — 商品数据同步（一次性导入后手动维护）

同步以 phone 为匹配键 UPSERT，运行时需 `MSSQL_CONNECTION_STRING` 和 `DATABASE_URL` 环境变量。

## 与云函数的关系

Drizzle 仅用于此目录的 schema 管理和迁移生成。两者共享同一个 PostgreSQL 数据库，此处的 schema 定义是权威来源。
