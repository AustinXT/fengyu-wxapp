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
| inventory | inventory_skus, inventory_locations, inventory_stock_lots, inventory_docs/_items, inventory_movements | 总部 / 市场 / 门店统一进销存（V3）|
| system-config | system_configs | 系统配置（键值对） |
| enums | — | TypeScript 枚举定义 |

## 命令

```bash
npm run db:generate   # 生成迁移文件（schema 变更后）
npm run db:migrate    # 执行迁移
npm run db:studio     # Drizzle Studio 可视化管理
npm run db:test       # node:test 套件（migration 字面量回归等，不连库）
npm run db:check:attribution   # 款项归属日期迁移前体检（只读，须显式传 DATABASE_URL）
```

⚠ `npm run db:test` **不在** admin / staffApi 的 vitest 基线里，"单测全绿"不覆盖它，发版前要单独跑。

迁移前需设置环境变量 `DATABASE_URL`（或在 `.env` 中配置）。Drizzle 配置见 `drizzle.config.ts`，启用了 strict 模式（破坏性变更需确认）。

**不用 `db:push`**：push 会直接改目标库 schema 而不写 `drizzle.__drizzle_migrations` 表，会让库和 journal 脱节。所有变更都必须走 `db:generate` + `db:migrate`。

## Schema 变更工作流（2026-04 baseline reset 之后强制）

标准流程：

1. 改 `schema/*.ts`（22 个模块之一。`schema/*.ts` 是 schema 的唯一权威来源）
2. `npm run db:generate` — drizzle-kit 产出 `migrations/00NN_<name>.sql` + 对应 `meta/00NN_snapshot.json` + 更新 `meta/_journal.json`
3. **本地验证**：起一个临时 docker PG，用 `DATABASE_URL=postgresql://postgres:...@localhost:54399/test npx drizzle-kit migrate` 在空库上跑一次，确认新 migration 能从零 apply 起整个 schema
4. **提交 PR**：必须同时包含 `schema/*.ts` + `migrations/00NN_*.sql` + `migrations/meta/` 三者的改动，缺一不可
5. **部署**：PR merge 后，**dev / prod 两个业务库都要迁**（都在使用，不是生产 + 冷备）：
   - dev：从 `envs/dev.env` 的 `PG_CONNECTION_STRING` 显式迁 **101.34.242.103:5433/fengyu_wxapp**；不得使用容器网桥地址 `172.18.0.1`
   - prod：从 `envs/prod.env` 的 `ADMIN_DATABASE_URL` 显式迁 **118.178.196.26:5433/fengyu_wxapp**
   - 详见下文「dev / prod 两套业务库」小节；完整发版优先使用 `/release-all <env>` 的目标断言与迁移门禁

### ⚠️ 迁移 0039–0041 的编号在 2026-09-16 的 main→dev 合并里重排过

同一条迁移在两条分支上拿到过不同编号，合并时按 `when` 时序重排为：

| idx | tag | when | 来历 |
|---|---|---|---|
| 39 | `0039_inventory_org_endpoints_and_permissions` | 1788231409458 | dev 线原样 |
| 40 | `0040_payment_attribution_date_always_set` | 1789117632431 | dev 线原样；**test/main 线上它叫 0039** |
| 41 | `0041_bizarre_wolfpack`（#137） | 1789357902234 | test/main 线的 0040 改号而来 |

**为什么必须是这个顺序**：drizzle 的 migrator 拿 `__drizzle_migrations` 里最大的 `created_at`
与 journal 各条的 `when` 比大小来决定跳过谁（不是按 hash 求集合差）。inventory 的 `when` 早于
payment，一旦把它排到 payment 之后，**任何已 apply 过 payment 的库都会永久静默跳过它** ——
2026-09-14 prod 需要手工 apply + 手工 INSERT 就是踩了这个。`when` 值一个都不许改。

**三个 SQL 文件内容逐字节未动**（改名不改内容），所以已 apply 的库里记的 (hash, created_at)
仍然对得上，不会被判成待迁。

**⚠️ `0041_bizarre_wolfpack.sql` 内部的注释仍写「0039 的 BEFORE trigger」「0039 是已发布的
迁移」** —— 那是它在 test 线被写下时的编号，指的是现在的 **0040**。这些注释**故意不改**：
迁移文件的内容参与 hash，改一个字就会让已 apply 的库报 hash 漂移。读 SQL 注释时按本表换算。

### 写 sale_order_payments 的硬约束（迁移 0040 / 0041）

`sale_order_payments.performance_attribution_date` 由 BEFORE trigger
`initialize_payment_performance_attribution_date()` 赋值，并由 CHECK 约束
`chk_sop_attribution_date_present` 兜底非空。各端报表直读这一列，没有任何查询侧回退。

因此：**任何绕过 trigger 写这张表的路径都必须显式提供 `performance_attribution_date`**。
`pg_restore --disable-triggers`、`session_replication_role = replica`（逻辑复制订阅端）、
`ALTER TABLE ... DISABLE TRIGGER` 下的批量导入都属于这类路径 —— CHECK 约束不随 trigger 一起被关掉，
不带这一列会直接报 `violates check constraint`。

同理，`sale_orders.performance_attribution_date` 变更由 AFTER UPDATE trigger
`sync_order_performance_attribution_to_payments()` 同步到首次支付行与同次储值卡行；
手工改这一列时不要顺手 DISABLE 它，否则镜像脱拍、业绩会静默落到错误的日子
（cron STEP 11 的 I6 / I6b 巡检会在次日告警，但那是安全网不是修复）。

**锁序约定：`sale_orders` → `sale_order_payments`，新代码不得反向。**

迁移 0041 给 BEFORE trigger 的两处 `SELECT ... FROM sale_orders` 补了 `FOR SHARE`
（**不能降回 `FOR KEY SHARE`**：归属日期不是键列，普通 `UPDATE sale_orders` 取 FOR NO KEY UPDATE，
与 FOR KEY SHARE 不冲突 —— 实测挡不住）。

该共享锁的**实际触发面只有两类写入**，不是"写这张表就会锁订单"：
1. `change_type = '首次支付'` 行的 INSERT，或它的 `status` / `paid_at` / `performance_attribution_date` UPDATE；
2. 归属日期列为空、且能配对到同 `status`、同精确 `paid_at` 主流水的 `储值卡抵扣` 行的 INSERT / 入账重算。

回款与退款走 ELSE 分支，不读 `sale_orders`；`allocation_status` 之类的 UPDATE 不在
`UPDATE OF status, paid_at, performance_attribution_date` 列表里，根本不触发 trigger。

⚠ **已知的反向锁序（既有，非 0040 引入）**：手工营业额分配
（`fengyu-admin/src/actions/allocations.ts` 的 `refreshOrderAllocationRollup` 链路、
staffApi `routes/allocation.js` 的保存/删除）是「先改款项行、再刷新订单汇总」。
它与「订单级改期」（先锁订单、再回写款项行）并发时会 40P01 —— 已在临时 PG 实测复现，
且**把 0041 的 AFTER trigger 禁用、改用改造前的应用层 UPDATE 同样复现**，
说明这个环在 0040 之前就存在，只是同步动作下沉后不再能从应用代码里一眼看出锁足迹。修它属于 allocation 模块的独立课题。

另有两条路径（clientApi `routes/order.js` 的 repay 纯卡/混合分支、admin `orders.ts` 的
`deductPrepaidCardAtCreation`）不先锁订单，但它们写的是配对不上主流水的卡行，压根不触发上面的共享锁，
且被 `prepaid_cards` 行锁串行化 —— **无环是因为不触发，不是因为顺序对**。改动这两处时要重新评估。

跑 0041 之前先执行 `npm run db:check:attribution` 确认没有真阻塞项：该迁移的
`ADD CONSTRAINT` 取 ACCESS EXCLUSIVE 并持有到事务提交，回填与自检的全表扫描都落在这个窗口里，
应避开营业高峰。迁移首条已加 `SET LOCAL lock_timeout = '3s'`，拿不到锁会直接失败而不是把业务卡住。

⚠ drizzle 把**所有**待应用迁移放进同一个事务（已核 drizzle-orm 0.45.1 的 `pg-core/dialect.cjs`），
所以积压越多、锁窗口越长。别攒一堆迁移一起上。

### 严格禁止

- **禁止** 用 `psql` 或任何客户端直连库执行 `CREATE TABLE / ALTER TABLE / DROP` 等 DDL
- **禁止** 手写 `.sql` 文件塞进 `db/migrations/`（哪怕序号不冲突）
- **禁止** 手动编辑 `db/migrations/meta/_journal.json`（baseline reset 收尾用 `db/scripts/reset-drizzle-journal.js` 除外）
- **禁止** 在已 merge 的 migration 上原地修改，应该写一个新 migration 修复
- **禁止** 用 `db:push` 对 prod/dev 任一业务库 push schema，会让 journal 脱节（e2e 独立库是唯一例外，见下文）
- **唯一例外**：生成的 migration `.sql` 文件末尾可以追加手写 `UPDATE`/`INSERT` 做数据回填（参考归档里的
  `_archive_pre_baseline_2026_04/sql/0018_green_rogue.sql` 模式），但**只能追加**，不能修改 drizzle-kit 生成的部分

### 补救措施

- **尚未 merge 的 migration 要改**：删除对应 `.sql` + `meta/00NN_snapshot.json`，手工把 `_journal.json` 的 entry 删掉，重新 `db:generate`
- **已在远程 apply 过的 migration 要改**：**绝对不要**改它，写一个新的 migration 来修复
- **发现 schema.ts 和实际库 drift**：不要再 psql 补漏，一律走 `db:generate` → review SQL → `db:migrate` 流程

## dev / prod 两套业务库（2026-09-01 起）

项目有两个独立 PG 实例，分处两台服务器。**两套库都在使用，schema 必须同步维护——不是生产 + 冷备的关系。**

| 角色 | 连接 | 使用方 |
|------|------|--------|
| **prod 业务库** | `postgresql://fengyu:***@118.178.196.26:5433/fengyu_wxapp`（SSH `lx-prod`） | 线上 admin、prod CloudBase 的 staffApi / clientApi / payNotify、**trial + release 版小程序**；**`test` 与 `main` 两条分支都发布到这里** |
| **dev 业务库** | 本地迁移：`postgresql://fengyu:***@101.34.242.103:5433/fengyu_wxapp`（SSH `lx-test`）；同机容器：`postgresql://fengyu:***@172.18.0.1:5433/fengyu_wxapp` | dev admin / analyst、dev CloudBase 云函数（cloud1-*）、**仅 develop 版小程序**；**`dev` 分支发布到这里** |

⚠ 两套库**均用 5433 端口 + `fengyu_wxapp` 库名**，本地迁移仅靠 **IP** 区分：
dev=`101.34.242.103`、prod=`118.178.196.26`。`172.18.0.1` 只允许 lx-test 上的容器回连宿主，
禁止作为本地 migration / backfill 目标。

**分支与环境的映射**（易混淆，以此为准）：`dev` 分支 → dev 环境（lx-test / 101）；
`test` 与 `main` 分支 → **prod 环境**（lx-prod / 118）。分支名 `test` **不**对应任何独立的 test 环境——
早期的独立 test 环境（`envs/test.env`）已于 2026-09-01 随 dev 迁入同一台机器而退役，不再单独定义。

### 已弃用：ali-demo `47.113.202.7`

2026-09-01 起**全面停用**，不再是任何环境的目标。该机上的两个库都不得再连：

| 地址 | 历史角色 | 现状 |
|---|---|---|
| `47.113.202.7:5433/fengyu_wxapp` | 2026-07-17 之前是**生产库**（2026-05-21 实测线上 admin 真实数据全在它上面），之后降级为 dev+test 共用库 | **仍可连通但数据陈旧**（停在 2026-08-24）。连它不会报错，只会静默拿到旧数据——这是最危险的失败模式 |
| `47.113.202.7:5434/fengyu` | 2026-07-17 之前的开发库 | 该实例上**已无任何 fengyu 库**（2026-09-14 实测仅剩 postgres/template0/template1）。写 `5434/*` 的引用一律失效 |

源码与配置中**不应再出现** `47.113.202.7`；仍出现的地方只有两类：归档的历史记录
（`notes/tickets/archives/**`、`docs/changes/**`、`db/migrations/_archive*`、测试执行报告），
以及保留原文并加注了现状的一次性脚本注释。

### e2e 独立库

| 库 | 连接 | 说明 |
|---|---|---|
| **admin e2e 库** | `postgresql://fengyu:***@101.34.242.103:5433/fengyu_e2e` | 与 dev 业务库**同机不同库**，靠库名隔离，避免多会话/worktree 并行跑 e2e 互相清库 |

- 引用点只有两处，改一处必须同步另一处：`db/scripts/bootstrap-e2e-db.sh`（建库）与
  `fengyu-admin/package.json` 的 `test:e2e` / `test:e2e:ui`（跑测试）。两者都以 `E2E_DB_NAME` 为库名来源，
  自定义隔离库（如 `fengyu_e2e_wt1`）时**两边都要设同一个 `E2E_DB_NAME`**，否则建了隔离库而测试仍连默认库。
- ⚠️ **`test:e2e:manual`（e2e-chains 跨页链路）不走这个独立库**，它按设计跑在 **dev 业务库**上：
  35 个 spec 的 psql helper（`_helpers/cron-runner.ts`、`_helpers/scope-helpers.ts`、各 `link-*.spec.ts`）
  硬编码连 `fengyu_wxapp`，`playwright.manual.config.ts` 也注明「server 也须连 fengyu_wxapp」，
  靠 `FY-FIX-*` / `FY-TEST-*` 命名空间与日常数据共存。给它注入 `E2E_DATABASE_URL` 会造成
  dev server 连 e2e 库、而夹具 SQL 连业务库的**分裂**，所以该脚本刻意不注入。
- ⚠️ **待办（需 DBA）**：`101.34.242.103` 上 `fengyu` 角色当前 `rolcreatedb=false`，
  `bootstrap-e2e-db.sh` 建不了库。需先执行 `ALTER ROLE fengyu CREATEDB`，再跑 bootstrap 建库灌 schema。
  在此之前 admin e2e 无库可连（旧 e2e 库随 `47.113.202.7` 一并弃用）。
- **e2e 只允许使用 dev 侧，绝不碰 prod。**

**schema 变更两个库都要迁**：

- dev：必须从 `../envs/dev.env` 读取 `PG_CONNECTION_STRING`，并在执行前断言公网 host 是
  **101.34.242.103**。
- prod：必须从 `../envs/prod.env` 读取 `ADMIN_DATABASE_URL`，并在执行前断言 host 是
  **118.178.196.26**。

```bash
TARGET_DATABASE_URL="$(grep -m1 '^PG_CONNECTION_STRING=' ../envs/dev.env | cut -d= -f2- | tr -d '\r\"')"
node -e 'const u=new URL(process.argv[1]); const BAD=["host","hostaddr","port","dbname","database","options","service","passfile"].filter(k=>u.searchParams.has(k)); if(BAD.length){console.error("拒绝：query 参数 "+BAD.join(",")+" 会覆盖连接目标");process.exit(1)}; if(u.hostname!=="101.34.242.103"||u.port!=="5433"||u.pathname!=="/fengyu_wxapp") process.exit(1)' "$TARGET_DATABASE_URL"
DATABASE_URL="$TARGET_DATABASE_URL" npm run db:migrate

TARGET_DATABASE_URL="$(grep -m1 '^ADMIN_DATABASE_URL=' ../envs/prod.env | cut -d= -f2- | tr -d '\r\"')"
node -e 'const u=new URL(process.argv[1]); const BAD=["host","hostaddr","port","dbname","database","options","service","passfile"].filter(k=>u.searchParams.has(k)); if(BAD.length){console.error("拒绝：query 参数 "+BAD.join(",")+" 会覆盖连接目标");process.exit(1)}; if(u.hostname!=="118.178.196.26"||u.port!=="5433"||u.pathname!=="/fengyu_wxapp") process.exit(1)' "$TARGET_DATABASE_URL"
DATABASE_URL="$TARGET_DATABASE_URL" npm run db:migrate
unset TARGET_DATABASE_URL
```

⚠ 上面断言里的 `BAD` 检查不能省：PG 连接串的 query 参数（`?host=` 乃至编码形式 `?%68ost=`）优先级高于 URL authority，只比 `hostname/port/pathname` 会被整个绕过——而 `db:migrate` 打错库无法回滚。

**数据修复 / backfill**：先分清目标环境——dev=`101.34.242.103:5433`、prod=`118.178.196.26:5433`，
**永远显式传 `DATABASE_URL` 并断言 host/port/dbname**。仅修某环境的数据时只跑
目标库；需要双环境一致的修复必须两库分别执行并记录结果。

`db/scripts/` 下的脚本**不提供指向远程业务库的 `DATABASE_URL` 默认值**：缺变量直接报错退出。
历史上多个脚本以旧 dev 地址作 fallback，而该库至今仍可连通（数据陈旧），忘传变量会静默跑错库且不报错。
（例外：`verify-member-level-cron.js`、`sync-products-from-workfine.js` 的 fallback 指向 `localhost`
自管容器，不会连到任何远程库。）

## Baseline reset 历史

2026-04-10 执行了一次 drizzle-kit baseline reset。背景、过程、归档位置、follow-up 任务见
`db/migrations/_archive_pre_baseline_2026_04/README.md`。在此之前的迁移历史通过 git log 和归档目录查询。

**5433 drift 修复（同日完成）**：5433/fengyu_wxapp 的 schema drift 已通过 `db/scripts/5433-converge.sql`
一次性 delta DDL 修复，并用 `db/scripts/reset-drizzle-journal.js` 对齐 journal。当时 prod/dev 两库的 `drizzle.__drizzle_migrations`
现在完全一致（同一 baseline hash + created_at）。drift 历史清单保留在 `db/scripts/follow-up-5433-drift.txt` 文件头加了 RESOLVED 标记。
全量备份位于 `~/backups/5433-before-drift-fix-20260410.dump`（50MB custom format）。

**2026-08-06 baseline reset**：以 `0000_baseline` 作为新的迁移起点，旧 94 条迁移保存在
`db/migrations/_archive_pre_baseline_20260806/`；之后的变更从此 baseline 继续追加增量 migration。这是一次性发布操作的例外，不可把它当作普通的已合并 migration 修改：已有业务库必须先按归档 README 执行
`npm --prefix db run db:baseline:reset`（dry-run 后再加 `-- --yes`），再运行 `db:migrate`；直接先跑 `db:migrate` 会尝试重放完整 baseline。该命令只接受完整的 94 条旧 journal，空库仍直接运行 `db:migrate`。

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
3. **0028_fine_maelstrom.sql 末尾**：硬编码 `ALTER DATABASE fengyu SET timezone=...`（`fengyu` 是开发库 5434 的库名，非通用）

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

**任何业务库（prod 118.178.196.26 / dev 101.34.242.103，均 5433）都不要跑此脚本**（业务库应直接运行目标断言后的 `db:migrate`）。

## 同步脚本

`scripts/` 目录下的同步脚本将 WorkFine（SQL Server）数据单向同步到 PostgreSQL：

- `sync-workfine.js` — 综合同步（组织架构、员工、顾客）
- `sync-products-from-workfine.js` — 商品数据同步（一次性导入后手动维护）

同步以 phone 为匹配键 UPSERT，运行时需 `MSSQL_CONNECTION_STRING` 和 `DATABASE_URL` 环境变量。

## 导出/备份

`scripts/dump-prod.sh` — 导出生产业务库（118.178.196.26:5433/fengyu_wxapp）为 custom-format dump（只读，AccessShareLock 不阻塞业务，但执行期间避免跑 db:migrate）：

```bash
bash db/scripts/dump-prod.sh                       # 全库导出（默认 ~/backups/fengyu/，custom format）
bash db/scripts/dump-prod.sh -t sale_orders        # 仅指定表（可重复 -t，支持通配符）
bash db/scripts/dump-prod.sh -F plain              # 纯 SQL 文本
```

连接串从 `envs/prod.env` 读取（不硬编码密码）；需本地 `postgresql@16`（pg_dump major 须 ≥ 服务端 16）；
内置防误连校验（必须含生产 IP 118.178.196.26，否则拒绝）；产物落项目外，避免敏感数据误入 git。

## 与云函数的关系

Drizzle 仅用于此目录的 schema 管理和迁移生成。两者共享同一个 PostgreSQL 数据库，此处的 schema 定义是权威来源。
