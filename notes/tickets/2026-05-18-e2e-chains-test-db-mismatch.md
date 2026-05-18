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
