# Ticket: e2e-chains 测试库归属定位（5433 vs 5434）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待决策 |
| 优先级 | **P1**（阻塞自动化测试常态运行）|
| 端 | fengyu-admin（tests/e2e-chains）|
| 修复成本 | **S–M**（取决于决策路径）|
| 来源 | 2026-05-18 e2e-chains 自动化跑批 |
| 关联文件 | `fengyu-admin/tests/e2e-chains/README.md` §0.1 / §0.2 / §0.5 |

---

## 0 一句话背景

跑批时发现 README 与开发现实**互相矛盾**——必须先二选一，否则下一次跑测试还是同样卡顿。

---

## 1 矛盾事实

**README 写**：
- §0.1：测试库 `47.113.202.7:5433/fengyu_wxapp`，主库 5434/fengyu **不要碰**
- §0.2：FY-TEST-* 七账号、fixture 顾客 / 卡 / 券、commission_rate_matrix 全部 "已在 5433 就绪"
- §0.3：`PSQL_TEST="PGPASSWORD=... -p 5433 -U fengyu -d fengyu_wxapp"`
- 全部 31 条 spec 内部硬编码 5433 连接

**用户口述（2026-05-18）**：
> "开发阶段测试都在 5434/fengyu 进行"

**5434 实测现状**（2026-05-18 06:50 抽样）：
```
fixture_client (FY-FIX-CLIENT-01)  → 0 行
test_accounts  (FY-TEST-*)         → 0 行
mgr_role       (FY-TEST-MGR)       → 0 行
fixture_card   (FY-FIX-CARD-01)    → 0 行
```
→ **5434 上跑 spec 第一步登录就会 401**。

---

## 2 决策点（请选一条）

### 选项 A：测试库锁定 5433，README 不动

- **影响**：`.env.local` 跑测试时必须手切 → 5433，跑完手切回 → 5434；dev server 必须重启两次。
- **配套**：补一个 npm script，例如 `bun run test:env:5433` 自动切换 + 重启。
- **代价**：每次跑测试多 ~15 秒环境切换；user 心理负担：忘记切回 5434 会污染日常开发数据。

### 选项 B：测试库迁到 5434，README 更新

- **影响**：把 5433 全部 fixture + FY-TEST-* 七账号迁到 5434；spec 内的连接串改写。
- **代价**：
  - 一次性 DDL/DML 迁移脚本（约 100 行 SQL）
  - 31 条 spec 文件全量替换 `5433/fengyu_wxapp` → `5434/fengyu`
  - 5434 增加了 31 条 spec 的测试残留风险（fixture 顾客的活跃单堵塞 / 储值卡余额污染 / 测试用 promotion 模板等）
  - 需要明确告诉日常开发：**5434 现在是混合库**，不再 "干净生产数据"

### 选项 C：双轨——admin spec 走 5434，cloud-fn spec 走 5433

- **影响**：每个测试套自带 .env.local 子集；admin spec 改写连接串；fengyu-staff e2e 不动。
- **代价**：concept 复杂度上升；维护两套 fixture（容易漂移）。

---

## 3 副决策（如果选项 B）

如果选 B，下面这几条要顺带定：

1. **5433 是否保留**？还是直接 DROP？
2. **FY-TEST-* 七账号 + 全部 FY-FIX-* fixture 怎么迁**？是否需要专门 seed 脚本？
3. **5434 的 fixture 数据是否进 git**（与 5433 的现有 .42cog 拍板逻辑同步）？

---

## 4 我已做的临时操作（不影响最终决策）

| 操作 | 已恢复？ |
|------|---------|
| 把 .env.local 切到 5433/fengyu_wxapp | ✅ 已还原回 5434/fengyu |
| 在 5433 上跑 db:migrate 补 0037 + 0038 | ❌ 未还原（5433 现在 schema 跟 5434 一致）|
| INSERT FY-TEST-MGR manager 角色到 5433.permission_roles | ❌ 未还原（5433 上现状是 7 个测试账号齐了）|
| UPDATE FY-FIX-CARD-01.balance=1000 | ❌ 后续 link-10 跑挂又被污染回 0；现 5433 balance=0 |
| 批量清理 FY-FIX-CLIENT-01 的 11 个活跃 sale_orders + 1 个 service_orders | ❌ 未还原（5433 上现状是干净的）|

→ 5433 上的痕迹是为了让 spec 能跑通；如果未来 5433 弃用，这些痕迹随库一起 DROP；如果 5433 保留作测试库，这些痕迹是"测试基线"。

---

## 5 决策完成后的执行项

由 user 决策定。请回复 "A / B / C" + 副决策答案，我再起对应的实施 ticket。

---

## 实施计划（2026-05-19，决策 = B）

### 已完成（脚本/spec 改动，未对 5434 跑 DDL/DML）

1. **`db/scripts/migrate-fixtures-5433-to-5434.sql`** — 一次性可重跑（全 INSERT ... ON CONFLICT DO NOTHING），覆盖：
   - 8 个 FY-TEST-* 测试员工账号（staff_wechat_users）
   - 8 条 admin_passwords（统一 bcrypt(fengyu2026)，must_change=false）
   - 8 条 permission_roles（admin / 市场 manager / 门店 manager × 2 / finance / hr / product / customer_mgr）
   - 8 条 client_wechat_users 顾客夹具（FY-FIX-CLIENT-01 + FY-TEST-CLIENT-NC02 / OM + FY-TEST-CRON-01~05）
   - 1 张 prepaid_card + 1 条 +1000 充值流水（external_ref='FY-FIX-CARD-01-SEED'）
   - 5 个 coupon_templates + 5 张 user_coupons
   - 3 个 product_skus（trial / bundle-A / bundle-B）+ 1 个 products(FY-FIX-BUNDLE-01) + 2 条 mall_product_skus
   - 前置校验：org_nodes / stores / product_categories / mall_categories 宿主行必须存在

2. **spec / README 连接串切 5434**：
   - `fengyu-admin/tests/e2e-chains/README.md`（§0.1 / §0.2 / §0.3 / §0.5 + seed 命令 + 顶部更新日期）
   - `fengyu-admin/tests/e2e-chains/test-fixtures.json` `_meta.db` + `_cleanup.description`
   - `fengyu-admin/tests/e2e-chains/_helpers/scope-helpers.ts` `psql()` + 注释
   - `fengyu-admin/tests/e2e-chains/_helpers/cleanup.ts` 注释
   - 35 条 `link-*.spec.ts` 内 `psql -h ... -p 5433 -U fengyu -d fengyu_wxapp` → `-p 5434 -U fengyu -d fengyu`
   - 注释里 "5433 上有/已就绪/冷备库 5433" 等语义指代同步更新

3. **DRY RUN 验证**（2026-05-19）：脚本在 5434 上整体 BEGIN/COMMIT 跑通，写入 8/8/8/8/1/1/5/5/3/1/2 行；执行后立即用 FK 反向 DELETE 清理（恢复零 fixture 状态）。SQL 语法已实证可执行，5434 当前仍为零 fixture。

### 5434 冲突盘点（2026-05-19）

| 命名空间 | 5433 已有 | 5434 已有 | 冲突 |
|---------|----------|----------|------|
| staff_wechat_users.FY-TEST-* | 8 | 0 | 无 |
| admin_passwords.FY-TEST-* | 8 | 0 | 无 |
| permission_roles.FY-TEST-* | 8 | 0 | 无 |
| client_wechat_users (FY-FIX / FY-TEST-CLIENT / FY-TEST-CRON) | 8 | 0 | 无 |
| prepaid_cards.FY-FIX-* | 1 | 0 | 无 |
| coupon_templates.FY-FIX-* | 5 | 0 | 无 |
| user_coupons.FY-FIX-* | 5 | 0 | 无 |
| product_skus.FY-FIX-* | 3 | 0 | 无 |
| products.FY-FIX-* | 1 | 0 | 无 |
| mall_product_skus.FY-FIX-* | 2 | 0 | 无 |

宿主基础数据（org_nodes / stores / product_categories / mall_categories / commission_rate_matrix / system_configs）在 5434 上均已齐全且更丰富（commission_rate_matrix 5434 有 39 行 vs 5433 仅 15 行），脚本依赖它们存在。

### 待执行项

- [x] 用户授权后跑 SQL 脚本到 5434（2026-05-19 by user）→ 11 条 check 全部 n≥1：
  - staff_wechat_users.FY-TEST-* = 8, admin_passwords = 8, permission_roles = 8
  - client_wechat_users fixtures = 8
  - prepaid_cards.FY-FIX-* = 1, card_transactions = 1
  - coupon_templates.FY-FIX-* = 5, user_coupons = 5
  - product_skus.FY-FIX-* = 3, products.FY-FIX-* = 1, mall_product_skus.FY-FIX-* = 2
- [ ] 单跑 link-1 验证（建议下一会话或下次本地 dev 启动后跑一轮）
- [ ] 全套 35 条 spec 跑批一轮
- [x] 5433 保留作冷备 1–2 周，到期单开 ticket 退役（见副决策）
- [x] 归档本 ticket — 2026-05-19

### 副决策

#### 5433 弃用？

**建议：保留 5433 作冷备 1–2 周（直到 5434 spec 全套跑通至少一轮）**。理由：
1. 5433 上已有完整 fixture + 测试残留，可作为"已知好基线"作为对照
2. 即便 5434 跑批失败也能快速 fallback 回 5433（spec 内连接串改回去即可）
3. 项目记忆里已记录"5433 自 2026-04-24 起退为冷备"，本次不主动废弃只是延后一轮

后续若 5434 全套跑通且稳定 ≥2 周，可由独立 ticket 走 5433 退役流程（`db/CLAUDE.md` 已注明"预计 1–2 周后彻底退役"）。

#### fixture 数据是否进 git？

**建议：不进 git，只 SQL 脚本入 git**。已采纳：`db/scripts/migrate-fixtures-5433-to-5434.sql` 入 git，全部行数据用 INSERT ON CONFLICT 表达；运行时从该脚本灌入。理由：
1. fixture 数据含具体时间戳 / bcrypt hash 等运行时副作用，dump 进 git 难维护
2. SQL 脚本可读、可 review、可重跑，比 .sql.gz dump 更友好
3. 与 `db/migrations/` 的做法保持一致（schema 进 git，数据不进 git）

---

## 历史临时操作复盘

§4 的「已做的临时操作」中 5433 上的痕迹（FY-TEST-MGR manager 角色 / FY-FIX-CLIENT-01 活跃单清理 / FY-FIX-CARD-01 balance 改动 等）已与 5433 现状一并保留；在 5434 上**只灌脚本里定义的"静息态"**（member_level=NULL、points_balance=0、card balance=1000、coupons 全 "未使用"），不复制 5433 运行时残留。
