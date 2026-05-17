# Ticket: 跨表 OPENID 唯一约束 — 决策记录（已作废）

> 生成日期：2026-05-17
> 实施状态：📜 决策记录（D-Q2-2026-04-26 作废，不实施）
> 严重级别：P0 → **P2 文档化**
> 端：db / fengyu-client / fengyu-staff
> 来源：[SUMMARY v3 §2 #12](../../docs/audit/SUMMARY.md)
> 关联 audit：[audit-01-auth.md](../../docs/audit/audit-01-auth.md)（P0-SPLIT-04 → P2）

---

## 0 一句话背景

audit-01-auth.md v1 提出的 P0-SPLIT-04 主张："`client_wechat_users.openid` 与 `staff_wechat_users.openid`
应建跨表全局唯一约束，防止同一微信 OPENID 同时落两端"。
2026-04-26 用户决策 D-Q2 把该项**作废**，原因是：**两端使用不同 appid，OPENID 不可能重叠**，
约束失去物理意义。本 ticket 把该决策落档为审计追溯记录。

---

## 1 决策内容（D-Q2-2026-04-26）

| 项 | 内容 |
|----|------|
| **决策日期** | 2026-04-26 |
| **决策人** | 用户（NightVoyager） |
| **结论** | 跨表 OPENID 唯一约束**作废**，不实施 |
| **原因** | 客户端 appid `wx811eb4ded3dfba3f`、员工端 appid `wxe3f5d9ee6a94d22d`；微信 OPENID 是 appid-scoped，两端各自的 OPENID 命名空间物理隔离 |
| **降级** | audit-01-auth.md P0-SPLIT-04 → **P2 文档化**（不再纳入 P0 修复 roadmap） |

---

## 2 物理依据

微信开放平台 OPENID 规范（参考微信官方文档）：

> OPENID 是用户对**同一应用**唯一的标识符；同一用户在不同应用中具有不同的 OPENID。

因此：

- 顾客微信扫码授权 `wx811eb4ded3dfba3f`（fengyu-client）→ 生成 OPENID_A
- 同一手机的同一用户扫码授权 `wxe3f5d9ee6a94d22d`（fengyu-staff）→ 生成 OPENID_B
- OPENID_A 和 OPENID_B **由微信侧保证不相同**，不需要 DB 层兜底

跨端身份关联通过 **phone 号**（两端都强制 bindPhone）实现，而非 OPENID。

---

## 3 仍保留的单表唯一索引

跨表唯一约束作废后，两表内部仍各自保留 partial unique（baseline migration 0000）：

```sql
-- client_wechat_users（migration 0000_baseline.sql:580）
CREATE UNIQUE INDEX "uq_client_users_openid" ON "client_wechat_users" USING btree ("openid") WHERE openid IS NOT NULL;

-- staff_wechat_users（migration 0000_baseline.sql:584）
CREATE UNIQUE INDEX "uq_staff_users_openid" ON "staff_wechat_users" USING btree ("openid") WHERE openid IS NOT NULL;
```

这两条索引确保各自表内 OPENID 不重复，已足够。

---

## 4 后续：不需要任何代码改动

- ❌ 不创建跨表 trigger
- ❌ 不创建 view + unique constraint
- ❌ 不修改 staff/client 任何 bindPhone 路径
- ✅ 在 audit-01-auth.md 标注 P0-SPLIT-04 → P2（已在 v3 完成）
- ✅ 在 SUMMARY.md §5.1 决策表 D-Q2 已记录（已在 v3 完成）

本 ticket 仅作"为什么 SUMMARY Top 10 之外的高敏列表里这条不动"的索引参照。

---

## 5 关联

- [SUMMARY v3 §2 #12](../../docs/audit/SUMMARY.md) — 列表中以"已作废"标注
- [SUMMARY v3 §5.1 D-Q2](../../docs/audit/SUMMARY.md#5.1-用户已决策2026-04-26) — 决策原文
- audit-01-auth.md P0-SPLIT-04（v3 降为 P2）
- L0 P0 列表 — 已从"剩余 13 项"中划掉
