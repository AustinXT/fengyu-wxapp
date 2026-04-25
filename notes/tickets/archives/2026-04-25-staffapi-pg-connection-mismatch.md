# staffApi/clientApi PG_CONNECTION_STRING 与 db/CLAUDE.md 文档不一致

> 状态：**已完成（2026-04-25）/ 候选 A 落地**
> 优先级：P2（不影响业务，但误导后续开发与 migration 流程）
> 创建时间：2026-04-25
> 完成时间：2026-04-25
> 范围：仅文档对齐，不动配置/不重部署

## 1. 问题描述

`db/CLAUDE.md`（line 73-86）"两库必须同步"小节明确写道：

| 角色 | 连接 | 使用方 |
|------|------|--------|
| 测试库 | `5434/fengyu` | admin web、`db/.env`、`db:migrate` 默认目标 |
| 开发库 | `5433/fengyu_wxapp` | **staffApi/clientApi 云函数（CloudBase 环境变量 PG_CONNECTION_STRING）** |

但是当前 `fengyu-staff/cloudbaserc.json` 与 `fengyu-client/cloudbaserc.json` 全部 3 个云函数（staffApi / clientApi / payNotify）的 `PG_CONNECTION_STRING` 都指向 **5434/fengyu**：

```jsonc
// fengyu-staff/cloudbaserc.json:11
"PG_CONNECTION_STRING": "postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu"

// fengyu-client/cloudbaserc.json:11, 25
"PG_CONNECTION_STRING": "postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu"
```

## 2. 调查发现

### 2.1 配置历史（git log 重建）

`fengyu-staff/cloudbaserc.json` 已在 2026-04-02 commit `483a584` 加入 .gitignore，但 `fengyu-client/cloudbaserc.json` 仍跟踪。从 client cloudbaserc.json 的 git log 重建：

| 阶段 | clientApi PG | 备注 |
|------|--------------|------|
| 早期 | `5433/fengyu_wxapp` | 与文档一致 |
| 中期 | `5434/fengyu_wxapp` | 端口改了但库名忘改 → 不存在的组合，`06-1-client-discount-coupon-fix.md:99` 标记为"配置漂移" |
| 当前 | `5434/fengyu` | clientApi 与 admin 共用业务库 |

### 2.2 关键转折点：2026-04-24 11:29 的 env drift 主动修复

`notes/tickets/archives/2026-04-23-prepaid-card-deduction-by-store-e2e.md:173`：

> ✅ env drift 已修（2026-04-24 11:29）：staffApi / payNotify 云端 `PG_CONNECTION_STRING` 从 `5433/fengyu_wxapp` 迁至 `5434/fengyu`，与 clientApi / admin 统一到同一业务库；其他环境变量完整保留。修复通过 `@cloudbase/manager-node` 的 `updateFunctionConfig` API 完成，以 cloudbaserc.json 为权威源覆盖云端。**场景 B 跨端链路现可直接走通。**

也就是说：**5434/fengyu 是有意为之的统一目标库**，目的是消除以前 admin 在 5434 / 云函数在 5433 写不同数据库的 env drift。这个修复早在两天前已完成。

`notes/tickets/archives/2026-04-25-cron-worker-migration.md:25` 进一步佐证：

> 业务库已经是同一个 PG（5434/fengyu），跟 admin 已经共享数据。

### 2.3 数据现状校验（2026-04-25 实测）

| 维度 | 5434/fengyu | 5433/fengyu_wxapp |
|------|-------------|-------------------|
| `sale_orders` 总数 | **142811** | 142794 |
| 最新 `sale_orders.created_at` | **2026-04-23 21:23:58** | 2026-03-23 14:04:25 |
| 近 7 天新增订单 | **10** | **0** |
| `client_wechat_users` 总数 | 58803 | 58802 |
| PG 版本 | 16.11 (Alpine) | 16.13 (Ubuntu) |

结论：
- **5434/fengyu 是当前唯一活跃的业务库**（云函数与 admin 都写它）
- **5433/fengyu_wxapp 自 2026-03-23 起几乎冻结**，仅作为 schema 同步的镜像（migration 还会被双跑），不接收业务写入
- 两库不是物理同库，不是逻辑复制，而是 schema-mirror（migration 双跑保持 DDL 一致），数据已永久分叉

### 2.4 引用证据汇总

| 文件:行号 | 证据 |
|-----------|------|
| `db/CLAUDE.md:54, 80` | 文档：staffApi/clientApi 连 5433/fengyu_wxapp（**与现实不符**）|
| `fengyu-staff/cloudbaserc.json:11` | staffApi 实际配置：5434/fengyu |
| `fengyu-client/cloudbaserc.json:11, 25` | clientApi + payNotify 实际配置：5434/fengyu |
| `notes/tickets/archives/2026-04-23-prepaid-card-deduction-by-store-e2e.md:173` | env drift 主动修复完成日志（2026-04-24 11:29）|
| `notes/tickets/archives/2026-04-25-cron-worker-migration.md:25` | "业务库已经是同一个 PG（5434/fengyu）" |
| `notes/tickets/archives/06-1-client-discount-coupon-fix.md:99` | 历史 5434/fengyu_wxapp 错位漂移记录 |
| `db/scripts/sync-workfine.js:38` 等 backfill 脚本 | DEFAULT 仍连 5433（脚本默认值过时）|

## 3. 影响

### 3.1 实际生产影响（P0 风险）—— **无**

云函数实际工作正常：staffApi/clientApi/payNotify 与 admin 都写同一个库（5434/fengyu）。订单创建、储值卡扣款、跨端联动、admin 后台数据全部一致，没有"看不到对方订单"的 drift 故障。

### 3.2 文档误导风险（P2）—— **有**

任何按 `db/CLAUDE.md` 流程办事的同事会被误导：

1. **migration 流程**：文档说"两库都跑"，但其实 5433 已退役，实际只需要跑 5434。如果继续双跑，要承担 5433 时不时挂掉、阻塞发布的成本。
2. **排查流程**：新人按文档以为云函数在 5433，连错库导致排查失败（参考 `2026-04-25-mgmt-product-repurchase-empty.md:63` 的命令默认连 5433）。
3. **backfill 脚本**：`db/scripts/*.js` 多个脚本 DEFAULT 连 5433/fengyu_wxapp（无环境变量时），如果有人不显式传 `DATABASE_URL` 跑回填，数据写到了已废库。

### 3.3 并发/数据一致性

由于 staffApi 和 admin 现都连 5434：
- admin 改员工档案 → staffApi 立刻读到 ✅
- 员工开单 → admin 立刻看到 ✅
- 顾客扫码扣储值卡 → staffApi 立刻看到 ✅

不再存在 env drift 时的"读旧数据"问题。

## 4. 修复方案候选

### 候选 A：仅修文档（推荐）

把 `db/CLAUDE.md` 的"两库必须同步"小节改写为：

- 5434/fengyu = **唯一生产业务库**（admin + 全部云函数）
- 5433/fengyu_wxapp = **历史冷备库**（曾是云函数库，2026-04-24 已迁移；migration 可选双跑作为灾备演练，但不是必须）

并补充：
- `db/scripts/*.js` 的 DEFAULT 连接串改为 5434/fengyu（或要求强制传 `DATABASE_URL`）
- `db/.env.example` 已经是单库配置，无需改

### 候选 B：恢复双库写

把云函数 PG_CONNECTION_STRING 改回 5433/fengyu_wxapp，并启用某种实时复制把 5434 数据回填给 5433。

不推荐：
- 需要重新引入 env drift（已主动修过）
- 要么搞双写中间件、要么搞逻辑复制，都是新工程量
- 没有任何业务收益（admin 与云函数本来就是一家）

### 候选 C：彻底退役 5433

执行 `~/backups/` 备份后停掉 5433 实例，docker-compose 移除该 service，所有 backfill 脚本 DEFAULT 改 5434。

未来工作，**不在本 ticket 范围**。

## 5. 推荐方案

**采用候选 A：仅修文档，保留 5433 作为冷备**。

理由：
1. 现实已稳定运行 2 天（2026-04-24 至 2026-04-25），没有故障，不要再动配置
2. CloudBase 环境变量手工修过一次，再来回切容易踩 `tcb fn deploy --force` 重置 env 的坑（参考 `project_cloudbase_envvar_risk` memory）
3. 文档对齐成本最低，能立刻消除新人误导
4. 5433 保留 1-2 周作为快速回滚窗口，确认无回归后再彻底退役（候选 C 后续再做）

## 6. 验收标准

- [x] `db/CLAUDE.md` 两库小节改为反映"5434 为唯一生产业务库"，标注 5433 为冷备
- [x] `db/CLAUDE.md` "schema 变更工作流"中"对两个库都跑 db:migrate" 改为"对 5434 跑 db:migrate；5433 可选（冷备演练）"
- [x] `db/scripts/migrate-*.js` / `sync-workfine.js` / `calc-monthly-activity.js` / `migrate-active-cards.js` / `migrate-history-orders.js` / `migrate-missing-customers.js` / `migrate-phantom-items.js` / `migrate-service-records.js` 的 DEFAULT 连接串从 5433/fengyu_wxapp 改为 5434/fengyu — 共 12 个文件、12 次替换；唯一保留是 `seed-recharge-virtual-product.js:17` header docstring 中的"运行示例"（按 ticket §6 注释段保留约定）
- [x] `MEMORY.md` 中 `project_db_dual_env` 条目同步更新（双 PG 实例 → 主备 PG 实例，主 = 5434，备 = 5433）
- [x] 不动 `fengyu-staff/cloudbaserc.json` / `fengyu-client/cloudbaserc.json`
- [x] 不重新部署任何云函数（避免 env 重置风险）
- [x] 关闭本 ticket 时附带一份"5434 vs 5433 数据差异"快照（见 §8）

## 7. 已完成动作清单（2026-04-25 实施）

| 类型 | 路径 | 改动概要 |
|------|------|----------|
| 文档 | `db/CLAUDE.md` | 「两库必须同步」改写为「生产库与冷备库」，新增 2026-04-24 env drift 修复时间锚点；schema 工作流第 5 步从"两库都跑"改为"对 5434 跑，5433 可选灾备演练" |
| 默认值 | `db/scripts/calc-monthly-activity.js` | DEFAULT → `5434/fengyu` |
| 默认值 | `db/scripts/migrate-active-cards.js` | 同上 |
| 默认值 | `db/scripts/migrate-allocations.js` | 同上 |
| 默认值 | `db/scripts/migrate-history-orders.js` | 同上 |
| 默认值 | `db/scripts/migrate-jclsh-items.js` | 同上 |
| 默认值 | `db/scripts/migrate-missing-customers.js` | 同上 |
| 默认值 | `db/scripts/migrate-phantom-items.js` | 同上 |
| 默认值 | `db/scripts/migrate-prepaid-cards.js` | 同上 |
| 默认值 | `db/scripts/migrate-presale-services.js` | 同上 |
| 默认值 | `db/scripts/migrate-service-records.js` | 同上 |
| 默认值 | `db/scripts/seed-recharge-virtual-product.js` | `DEFAULT_PG` → `5434/fengyu`（header docstring 运行示例保留） |
| 默认值 | `db/scripts/sync-workfine.js` | DEFAULT → `5434/fengyu` |
| 记忆 | `~/.claude/.../memory/project_db_dual_env.md` | 「双 PG 实例」→「主备 PG（主 5434 / 备 5433）」，加 2026-04-24 env drift 修复时间锚 |
| 记忆 | `~/.claude/.../memory/MEMORY.md` | `db-dual-env` 索引行同步更新 |

明确**未触碰**的范围（按 ticket §6）：
- `fengyu-staff/cloudbaserc.json`、`fengyu-client/cloudbaserc.json`
- 任何 CloudBase 云函数（无 deploy / fn code update / env 操作）
- 5433 实例本身（保留 1–2 周作为快速回滚窗口，候选 C 单独 ticket）

## 8. 5434 vs 5433 数据差异快照（2026-04-25 关闭参考）

| 维度 | 5434/fengyu（生产） | 5433/fengyu_wxapp（冷备） | 差异 |
|------|---------------------|---------------------------|------|
| `sale_orders` 总数 | 142811 | 142794 | +17 |
| 最新 `sale_orders.created_at` | 2026-04-23 21:23:58 | 2026-03-23 14:04:25 | 5434 领先约 31 天 |
| 近 7 天新增订单 | 10 | 0 | — |
| `client_wechat_users` 总数 | 58803 | 58802 | +1 |
| PG 版本 | 16.11 (Alpine) | 16.13 (Ubuntu) | — |

差异来源：env drift 主动修复（2026-04-24 11:29）之后产生的全部业务写入仅落在 5434。5433 自 2026-03-23 起不再接业务写入，已不可逆。冷备库保留意义仅为快速回滚窗口；如不发生回滚，将于候选 C 单独 ticket 中执行 `~/backups/` 备份后退役。

## 9. 不在范围

- 5433 退役（候选 C）—— 单独 ticket
- ~~backfill 脚本 DEFAULT 替换~~ —— 已并入本 ticket §7，作为小动作完成
- 5433 的灾备同步策略 —— 单独讨论
