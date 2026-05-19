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
| service | service_orders, service_items | 服务单 + 服务明细 |
| permission | permission_roles | 权限角色分配 |
| commission | commission_rate_matrix | 提成比例矩阵 |
| coupon | coupon_templates, user_coupons | 优惠券模板 + 用户券实例 |
| store-unbind | store_unbind_requests | 门店解绑申请 |
| operation-log | operation_logs | 操作审计日志 |
| points | customer_points, point_transactions | 积分系统（会员等级由 client_wechat_users.member_level 单独维护） |
| message | messages | 消息中心 |
| prepaid-card | prepaid_cards, card_transactions | 充值卡 + 流水 |
| service-commission | service_commissions | 服务提成（手工费/卡数提成） |
| pickup | pickup_records | 家居产品提货记录 |
| system-config | system_configs | 系统配置（键值对） |
| enums | — | TypeScript 枚举定义 |

## 命令

```bash
npm run db:generate   # 生成迁移文件（schema 变更后）
npm run db:migrate    # 执行迁移
npm run db:studio     # Drizzle Studio 可视化管理
```

迁移前需设置环境变量 `DATABASE_URL`（或在 `.env` 中配置）。Drizzle 配置见 `drizzle.config.ts`，启用了 strict 模式（破坏性变更需确认）。

**不用 `db:push`**：push 会直接改目标库 schema 而不写 `drizzle.__drizzle_migrations` 表，会让库和 journal 脱节。所有变更都必须走 `db:generate` + `db:migrate`。

## Schema 变更工作流（2026-04 baseline reset 之后强制）

标准流程：

1. 改 `schema/*.ts`（22 个模块之一。`schema/*.ts` 是 schema 的唯一权威来源）
2. `npm run db:generate` — drizzle-kit 产出 `migrations/00NN_<name>.sql` + 对应 `meta/00NN_snapshot.json` + 更新 `meta/_journal.json`
3. **本地验证**：起一个临时 docker PG，用 `DATABASE_URL=postgresql://postgres:...@localhost:54399/test npx drizzle-kit migrate` 在空库上跑一次，确认新 migration 能从零 apply 起整个 schema
4. **提交 PR**：必须同时包含 `schema/*.ts` + `migrations/00NN_*.sql` + `migrations/meta/` 三者的改动，缺一不可
5. **部署**：PR merge 后，对生产业务库跑 `npm run db:migrate`
   - **5434/fengyu**（唯一生产业务库，admin + 全部云函数共用）
   - 5433/fengyu_wxapp（冷备库）可选双跑，仅作灾备演练；不双跑不影响业务
   - 详见下文「生产库与冷备库」小节

### 严格禁止

- **禁止** 用 `psql` 或任何客户端直连库执行 `CREATE TABLE / ALTER TABLE / DROP` 等 DDL
- **禁止** 手写 `.sql` 文件塞进 `db/migrations/`（哪怕序号不冲突）
- **禁止** 手动编辑 `db/migrations/meta/_journal.json`（baseline reset 收尾用 `db/scripts/reset-drizzle-journal.js` 除外）
- **禁止** 在已 merge 的 migration 上原地修改，应该写一个新 migration 修复
- **禁止** 用 `db:push` 对生产/开发库 push schema，会让 journal 脱节
- **唯一例外**：生成的 migration `.sql` 文件末尾可以追加手写 `UPDATE`/`INSERT` 做数据回填（参考归档里的
  `_archive_pre_baseline_2026_04/sql/0018_green_rogue.sql` 模式），但**只能追加**，不能修改 drizzle-kit 生成的部分

### 补救措施

- **尚未 merge 的 migration 要改**：删除对应 `.sql` + `meta/00NN_snapshot.json`，手工把 `_journal.json` 的 entry 删掉，重新 `db:generate`
- **已在远程 apply 过的 migration 要改**：**绝对不要**改它，写一个新的 migration 来修复
- **发现 schema.ts 和实际库 drift**：不要再 psql 补漏，一律走 `db:generate` → review SQL → `db:migrate` 流程

## 生产库与冷备库（2026-04-25 修订）

项目过去存在两个独立 PG 实例（详见 `project_db_dual_env.md` memory）。**2026-04-24** env drift 主动修复后，admin 与全部云函数（staffApi / clientApi / payNotify）已统一连同一个业务库；5433 自此停止接收业务写入：

| 角色 | 连接 | 使用方 |
|------|------|--------|
| **生产业务库** | `postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu` | admin web、staffApi、clientApi、payNotify、`db/.env` 的 `DATABASE_URL`（`db:migrate` 主目标） |
| **冷备库** | `postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp` | 仅作历史镜像；不再接业务写入；schema 可选双跑作为灾备演练 |

**任何 schema 变更必须**在 5434 跑 `db:migrate`，本地 `db:migrate` 默认目标已经是它（`db/.env` 里的 URL）。

如需把 schema 变更也镜像到 5433（作为灾备演练或保留快速回滚窗口）：

```bash
DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" npm run db:migrate
```

冷备库已自 2026-03-23 起几乎冻结，预计 1–2 周后彻底退役（参考 `notes/tickets/2026-04-25-staffapi-pg-connection-mismatch.md`）。在此之前，对它执行 migration 是**可选**操作，不双跑不影响业务。

## Baseline reset 历史

2026-04-10 执行了一次 drizzle-kit baseline reset。背景、过程、归档位置、follow-up 任务见
`db/migrations/_archive_pre_baseline_2026_04/README.md`。在此之前的迁移历史通过 git log 和归档目录查询。

**5433 drift 修复（同日完成）**：5433/fengyu_wxapp 的 schema drift 已通过 `db/scripts/5433-converge.sql`
一次性 delta DDL 修复，并用 `db/scripts/reset-drizzle-journal.js` 对齐 journal。两库的 `drizzle.__drizzle_migrations`
现在完全一致（同一 baseline hash + created_at）。drift 历史清单保留在 `db/scripts/follow-up-5433-drift.txt` 文件头加了 RESOLVED 标记。
全量备份位于 `~/backups/5433-before-drift-fix-20260410.dump`（50MB custom format）。

## 临时 PG（仅用于 migration 验证）

项目没有常驻本地 PG；所有真实数据库都是远程的（见上节）。当需要做 `db:generate` 后的
「空库从零 apply」验证时，**临时**起一个 docker 容器：

```bash
docker run -d --name drizzle-migrate-test \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test \
  -p 54399:5432 postgres:16

DATABASE_URL="postgresql://postgres:test@localhost:54399/test" npm run db:migrate

# 验证后销毁
docker rm -f drizzle-migrate-test
```

这个临时容器**只用于验证**，不要承载任何业务数据。`docker/docker-compose.yml` 里定义的
`fengyu-postgres` 容器是历史遗留，团队不使用。

### 新机器从零 apply（绕过历史 bug）

新机器 / CI / 临时 docker PG **不要直接跑** `npm run db:migrate`，因为存在 3 个已知历史 bug 会让从零 apply 失败：

1. **0018_black_madrox.sql**：同事务 `ALTER TYPE payment_flow_status ADD VALUE '待审批'` + 后续 `WHERE status='待审批'` 谓词 → PG 错误码 55P04（"New enum values must be committed before they can be used"）
2. **0023_keen_freak.sql L44-L47**：与 0022 重复 `ADD CONSTRAINT chk_sale_alloc_ratio` 等 4 个约束（baseline reset 时这两个 migration 在生产是手工 INSERT 的，从未真正 apply）
3. **0028_fine_maelstrom.sql 末尾**：硬编码 `ALTER DATABASE fengyu SET timezone=...`（生产库名）

使用 bootstrap 脚本一键解决：

```bash
docker run -d --name pg-from-zero \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test \
  -p 54399:5432 postgres:16
sleep 5

DATABASE_URL="postgresql://postgres:test@localhost:54399/test" \
  bash db/scripts/bootstrap-from-zero.sh

# bootstrap 完成后，后续增量 migration 用普通 db:migrate 即可（hash 已对齐）
docker rm -f pg-from-zero
```

脚本特性：
- 纯 psql 全程 apply（不依赖 drizzle migrate 整体大事务）
- 对 0018 / 0023 / 0028 三个特殊 migration 做兜底
- 每条 migration apply 后手动 INSERT `drizzle.__drizzle_migrations`（hash 用 sha256(SQL 全文)，与 drizzle 算法对齐）
- 幂等：再跑一次会全 SKIP
- 与后续 `npm run db:migrate` 完全兼容

**生产 5434 / 冷备 5433 不要跑此脚本**（已 apply 过；直接 `npm run db:migrate` 即可）。

## 同步脚本

`scripts/` 目录下的同步脚本将 WorkFine（SQL Server）数据单向同步到 PostgreSQL：

- `sync-workfine.js` — 综合同步（组织架构、员工、顾客）
- `sync-products-from-workfine.js` — 商品数据同步（一次性导入后手动维护）

同步以 phone 为匹配键 UPSERT，运行时需 `MSSQL_CONNECTION_STRING` 和 `DATABASE_URL` 环境变量。

## 与云函数的关系

Drizzle 仅用于此目录的 schema 管理和迁移生成。两者共享同一个 PostgreSQL 数据库，此处的 schema 定义是权威来源。
