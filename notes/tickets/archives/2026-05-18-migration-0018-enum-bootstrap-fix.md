# Ticket: migration 0018 enum-add-then-use 从零 apply 修复（bootstrap 脚本）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待实施 |
| 优先级 | **P2**（不影响生产；仅影响新机器/CI 从零 apply 场景） |
| 端 | db |
| 修复成本 | **S**（bootstrap 脚本 + doc 更新 + 临时 PG 验证） |
| 来源 | Wave 2 J2-b 临时 PG replay 发现（meeting-20260507 B10 ticket follow-up） |
| 关联 migration | `db/migrations/0018_black_madrox.sql:1, 32` |
| 关联 enum | `payment_flow_status` 由 0004 创建，0018 ADD VALUE '待审批' |

---

## 0 一句话背景

`0018_black_madrox.sql` 在同一 drizzle migration（单事务）内：
- L1：`ALTER TYPE payment_flow_status ADD VALUE '待审批' BEFORE '已支付'`
- L32：`CREATE UNIQUE INDEX ... WHERE change_type = '退款' AND status = '待审批'`

PostgreSQL 限制（错误码 `55P04`）：新增的 enum 值必须先 commit 才能在同事务的 WHERE 谓词中使用。drizzle-kit 把整个 migration 文件包在单事务里 → 从零 apply 时 0018 失败。

**影响范围**：
- ✅ 生产 5434 / 冷备 5433：已分批 apply 过 0018（**不受影响**）
- ❌ 新机器从零 apply、CI 从零 PG replay、临时 docker PG 验证：**全部失败**

不能原地改 0018（违反 `db/CLAUDE.md` 红线"禁止在已 merged migration 上原地修改"）。

---

## 1 现状（grep 实证）

### 0004 创建 enum
```
$ grep -n "payment_flow_status" db/migrations/0004_yellow_magma.sql
2:CREATE TYPE "public"."payment_flow_status" AS ENUM('待支付', '已支付', '已作废', '已退款');
```

### 0018 同事务 ADD VALUE + 使用
```
$ sed -n '1p;32p' db/migrations/0018_black_madrox.sql
ALTER TYPE "public"."payment_flow_status" ADD VALUE '待审批' BEFORE '已支付';
CREATE UNIQUE INDEX "uq_sop_status_audit" ON "sale_order_payments" USING btree ("sale_order_id","change_type") WHERE change_type = '退款' AND status = '待审批';
```

### 失败重现（Wave 2 J2-b）
```bash
DATABASE_URL="postgresql://postgres:test@localhost:54399/test" npm run db:migrate
# → error: unsafe use of new value "待审批" of enum type payment_flow_status (55P04)
```

---

## 2 修复方案

### 2.1 新增 `db/scripts/bootstrap-from-zero.sh`

**职责**：在 0018 处特殊处理 — 拆为 2 个事务（ADD VALUE 单独 commit，再 apply 剩余 SQL）。

**核心流程**：
1. 让 drizzle-kit migrate 跑 0001-0017（自然在 0018 失败，状态回滚到 post-0017）
2. 用 psql 单独跑 `ALTER TYPE ... ADD VALUE '待审批';`（独立事务，commit）
3. 用 psql 跑 0018 的 L2~L42（跳过 L1 已 commit 的 ADD VALUE）
4. 手动 insert `drizzle.__drizzle_migrations` 记录 0018（hash + created_at 取自 journal）
5. 再次跑 drizzle-kit migrate 继续 apply 0019+

**关键文件**：
- `db/scripts/bootstrap-from-zero.sh`（新建，~60 行 bash）
- `db/CLAUDE.md` 加 "新机器从零 apply" 章节

### 2.2 不做的事

- ❌ **不改** 0018 内容（违反 baseline reset 规约）
- ❌ **不改** `_journal.json`（仅 bootstrap 脚本在运行时手动 insert drizzle_migrations 表，不动 journal 文件）
- ❌ **不动** 生产 5434 / 冷备 5433（它们已正常 apply 过 0018）
- ❌ **不需要** 写新 migration（0040+ 也救不了 0018 失败，因为新机器从零 apply 时根本到不了 0019）

---

## 3 验收（DoD）

- [ ] bootstrap 脚本存在 `db/scripts/bootstrap-from-zero.sh`，可执行
- [ ] 临时 docker PG 从零跑通：
  ```bash
  docker run -d --name bootstrap-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 54399:5432 postgres:16
  sleep 5
  DATABASE_URL="postgresql://postgres:test@localhost:54399/test" bash db/scripts/bootstrap-from-zero.sh
  # 期望：全部 39 migration 成功 apply（drizzle_migrations 表 39 行）
  docker rm -f bootstrap-test
  ```
- [ ] bootstrap 脚本幂等：对已 apply 过 0018 的库（5434/5433）跑一次 → 跳过 0018 特殊处理 + 跑普通 db:migrate（无副作用）
- [ ] `db/CLAUDE.md` 更新："新机器从零 apply" 章节指向 bootstrap 脚本
- [ ] ticket 归档至 `notes/tickets/archives/`

---

## 4 风险与回滚

| 风险 | 缓解 |
|------|------|
| bootstrap 脚本 hash 算法与 drizzle 实际不匹配 | 用 `drizzle-orm/node-postgres/migrator` 私有 API 复用 drizzle 内部 hash 函数；或直接复制 drizzle 源码的 hash 计算（sha256(content)）|
| 0018 特殊处理后，drizzle 第二次 migrate 误以为 0018 仍未 apply | drizzle_migrations 表手动 insert 后，drizzle 看到 hash 一致即跳过 |
| 用户对已 apply 过 0018 的库误跑 bootstrap | 脚本第一步检测 `enum_range(payment_flow_status)` 含 '待审批' → 跳过 phase 2，直接走 phase 3 |

**回滚**：bootstrap 脚本失败 → 临时 docker PG 销毁重来；生产库**不受任何影响**（脚本只在 phase 2 INSERT drizzle_migrations 一行，可 DELETE 撤销）。

---

## 5 关联

| 项 | 说明 |
|----|------|
| 来源 | Wave 2 J2-b 验证（B10 ticket follow-up）|
| 关联 migration | 0018_black_madrox.sql |
| 关联 enum | payment_flow_status（0004 创建）|
| 关联铁律 | `db/CLAUDE.md` "禁止在已 merged migration 上原地修改"（本 ticket 不违反，因 bootstrap 是 wrapper 不改 migration 文件）|
| 关联 memory | `project_legacy_product_mapping.md`（Wave 2 时发现此问题）|
| 已 apply 的库 | 5434 生产 + 5433 冷备（均含 0018）|

---

## 完成记录

- **完成日期**：2026-05-19
- **完成 commit**：待 commit（含 bootstrap 脚本 + db/CLAUDE.md 更新 + ticket 归档）
- **实际落地清单**：
  - `db/scripts/bootstrap-from-zero.sh`（新建，166 行）— 纯 psql 全程 apply，对 0018/0023/0028 兜底
  - `db/CLAUDE.md` — 新增 "新机器从零 apply（绕过历史 bug）" 章节
- **额外发现并修复**（超 ticket 范围）：
  - **0023_keen_freak.sql L44-L47**：与 0022 重复 `ADD CONSTRAINT chk_sale_alloc_ratio` 等 4 个约束
    - 根因：生产 5434 baseline reset 时 0022/0023 用手工 INSERT `drizzle_migrations`（hash 字段是 tag 字符串而非真 sha256），实际从未真正 apply 过
    - 兜底：bootstrap apply 0023 前 `DROP CONSTRAINT IF EXISTS` 4 个约束
  - **0028_fine_maelstrom.sql 末尾**：硬编码 `ALTER DATABASE fengyu SET timezone='Asia/Shanghai'`
    - 根因：drizzle-kit 末尾追加段（"防漂移声明，零业务影响"）硬编码生产库名
    - 兜底：bootstrap apply 0028 时 `grep -v "^ALTER DATABASE fengyu"` 跳过该行
- **DoD 核对**：
  - [x] bootstrap 脚本可执行
  - [x] 临时 docker PG 从零 apply 全 40 migration 成功（含 0018/0023/0028 特殊处理）
  - [x] 幂等：再跑一次全 SKIP（0 apply / 40 skip）
  - [x] 与 `npm run db:migrate` 兼容：bootstrap 后 db:migrate 识别 hash 全跳过
  - [x] schema 验证：`待审批` 在 payment_flow_status enum 中、35 张业务表存在、40 行 drizzle_migrations
  - [x] db/CLAUDE.md 新章节指向 bootstrap 脚本
- **未做**：
  - **不**改 0018/0023/0028 文件本身（遵循 baseline reset 规约"禁止原地改 merged migration"）
  - **不**改 `_journal.json`（bootstrap 仅在运行时操作 PG 端 `drizzle.__drizzle_migrations` 表）
  - **不**影响生产 5434 / 冷备 5433（脚本仅用于"从零 apply"场景）
- **关联同批**：Wave 2 J2 验证发现此问题；本 ticket 是 J2 follow-up
- **测试结果**：临时 docker PG postgres:16 从零 apply 通过；幂等 + drizzle migrate 兼容通过
