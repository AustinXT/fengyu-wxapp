---
ticket: 2026-05-17-l0-schema-checks-and-timezone.md Phase 1 dry-run
date: 2026-05-17
db: 5434 fengyu (PG 16.0.13)
mode: 只读 SELECT，零写入
---

## 摘要

| 检查 | 结果 | 后续 |
|------|------|------|
| 0a PG timezone | **`Asia/Shanghai`** ✅ | ALTER DATABASE 退化为防漂移声明，零业务影响 |
| 0a 库列表 | 5434 上仅 `fengyu` + `postgres`；**5433/fengyu_wxapp 在独立实例** | Phase 7 需另起 psql 连 5433 |
| b 手机号违例（ticket 原正则 `[0-9]{8}` 10 位） | staff 2766 / client 24529 | ❌ **正则 typo**：中国手机号是 11 位 |
| b 手机号违例（**修正正则 `[0-9]{9}` 11 位**） | staff **9** / client **202** | < 20 staff 手工评估；client 走兜底清洗 |
| c card_transactions 符号违例 | **0** ✅ | 直接 VALIDATE，零清洗 |
| d point_transactions type 分布 | 仅 **1 行**（`消费赠送` +5） | CHECK 表达式需考虑未来负值 type |
| e prepaid_cards.balance < 0 | **0** ✅ | 直接 VALIDATE |
| f bigint 升级紧迫度 | pt.amount MAX=5 / points_balance MAX=5 | 长尾防御性升级，秒级 ALTER |

---

## 🔴 ticket 正则 typo

ticket 全篇用 `'^1[3-9][0-9]{8}$'`（= 10 位手机号），但中国大陆手机号是 **11 位**（`1` + `[3-9]` + 9 位）。正确正则应为：

```regex
^1[3-9][0-9]{9}$
```

本 dry-run 已用修正后正则；schema.ts + migration 必须用修正后正则，否则全表 2.7 万合法号都会被 CHECK 阻断。

---

## 0a PG timezone

```
   TimeZone    
---------------
 Asia/Shanghai
```

| tz | now_local | now_shanghai | today |
|----|-----------|--------------|-------|
| Asia/Shanghai | 2026-05-17 21:45:32.581942+08 | 2026-05-17 21:45:32.581942 | 2026-05-17 |

库列表（5434）：
| datname | encoding |
|---------|----------|
| fengyu | UTF8 |
| postgres | UTF8 |

> 5434 上没有 fengyu_wxapp（它在 5433 独立实例）；Phase 7 需另起 psql 连 5433。

---

## b 手机号违例

### ticket 原正则（10 位，错误）

| realm | bad_rows |
|-------|----------|
| staff | 2766 |
| client | 24529 |

### 修正正则 `^1[3-9][0-9]{9}$`（11 位）

| realm | bad_rows |
|-------|----------|
| staff | **9** |
| client | **202** |

### staff 全部 9 行违例（全部 length=11 但伪号）

| employee_id | name | phone | is_resigned |
|-------------|------|-------|-------------|
| FY-221118010 | 高燕婷 | 11111111111 | f |
| FY-241209002 | 吴别美 | 12222222222 | f |
| FY-250711002 | 杨洋 | 11112222223 | f |
| FY-250908002 | 邵荣英 | 12343232323 | f |
| FY-250912002 | 万鹏齐 | 12342342322 | f |
| FY-251103001 | 余清明 | 11122223334 | f |
| FY-251122001 | 高洁 | 11112222334 | f |
| FY-260105001 | 陶芸芸 | 12255557777 | f |
| FY-260311006 | 张艳红 | 10000000000 | f |

**特征**：所有 9 行均为占位号（开头不是 13-19）；都是在职员工。

### client 202 行违例按长度分布

| len | count | first3 样本 |
|-----|-------|-------------|
| 1 | 3 | `.`, `0`, `1` |
| 2 | 2 | `18`, `空号` |
| 3 | 1 | 中文名 `方青秀` |
| 8 | 1 | `155` |
| 9 | 1 | `159` |
| 10 | 36 | `122,137,138,139,147,150,151,152,155,156,157,158,159,170,177,178,181,183,184,189,198,309` |
| **11** | **123** | `111,112,116,118,120,121,122,123,124,125,126,128,131,482`（伪号开头） |
| 12 | 32 | `013,122,131,133,135,136,138,147,150,151,153,158,178,182,188,189,191,195,197,217` |
| 13 | 1 | `153` |
| 15 | 1 | `130` |
| 23 | 1 | `135`（疑似 `13530986989/15907907823` 双号） |

**特征**：均为 WorkFine 历史导入脏数据 — 占位符 / 中文 / 缺位 / 多位 / 双号合并 / 加 +86。

合法 phone 行（11 位且符合正则）：client 24483 / staff 2757。

---

## c card_transactions 符号违例

```
 bad_card_tx 
-------------
           0
```

✅ 零违例，直接 VALIDATE。

---

## d point_transactions type 分布

| type | row_count | min | max | neg | pos | zero |
|------|-----------|-----|-----|-----|-----|------|
| 消费赠送 | 1 | 5 | 5 | 0 | 1 | 0 |

仅 1 行；积分系统当前生产数据极少。

**已知 type（来自 admin/actions/points.ts 顶部注释）**：
- `'等级升级奖励'`（正）— cronTask 会员升级发放
- `'消费赠送'`（正）— 订单净额增加自动发放
- `'消费冲销'`（负）— 退款冲销
- 未来潜在：手工调整 / 过期扣减等

**CHECK 表达式设计选项**（待用户决策）：
- 严格：`(type='消费冲销' AND amount<0) OR (type<>'消费冲销' AND amount>0)` — 新加负值 type 必须新 migration
- 半严格（**推荐**）：`(amount<0 AND type='消费冲销') OR amount>0` — 已知负值 type 严格守，正值兼容未来扩展
- 宽松：`amount <> 0` — 仅禁 0，失符号守护

---

## e prepaid_cards.balance < 0

```
 neg_balance_rows 
------------------
                0
```

✅ 零违例（虽然 ticket §3.2 误描述 D4 trigger 已守 balance —— 实际 0020 是 `trg_check_no_mixed_recharge` 防混合充值卡 —— 但应用层未扣穿，可直接加 CHECK 兜底）。

---

## f bigint 升级紧迫度

### point_transactions.amount

| min | max | sum | rows |
|-----|-----|-----|------|
| 5 | 5 | 5 | 1 |

### client_wechat_users.points_balance

| min | max | sum | rows |
|-----|-----|-----|------|
| 0 | 5 | 5 | 58804 |

**评估**：当前体量微不足道；bigint 升级是**长期防御**（防 int4 21 亿溢出，特别是未来积分活动加大或错误回放）。ALTER COLUMN TYPE 在 5.8 万行 client_wechat_users 上预计 < 1 秒；point_transactions 1 行更快。零业务风险窗口。

---

## 清洗策略候选

### staff 9 行（占位伪号）

候选 1：**UPDATE phone = NULL**（推荐）
- 这些员工需要重新走 bindPhone 流程绑定真实号
- 客户端上员工身份是 employee_id PK，phone 仅用于 OPENID 关联映射，置 NULL 不影响登录/查询

候选 2：**手工修正**
- 需要逐个联系员工拿真实号 — 不实际

候选 3：**临时放宽 CHECK 表达式**
- 加 `OR phone IN ('11111111111', ...)` 白名单 — 不推荐，污染 schema

### client 202 行（WorkFine 脏数据）

候选 1：**导出 CSV 后批量 UPDATE NULL**（推荐）
- 备份 `docs/migrations/2026-05-17-phone-cleanup-backup.csv`
- 顾客重新通过客户端 bindPhone 自动覆盖

候选 2：**算法清洗**（缺/多 1 位 → 补/砍）
- 风险高，可能写错号

候选 3：**保留 phone 但加 CHECK exclusion**
- 同上不推荐

---

## 建议总结

| 决策 | 推荐 |
|------|------|
| ticket 正则 typo | 全部改 `^1[3-9][0-9]{9}$` |
| staff 9 行 | UPDATE NULL（迁移末尾追加 UPDATE） |
| client 202 行 | 导出 CSV → UPDATE NULL（迁移末尾追加 UPDATE） |
| `chk_pt_amount_sign` 表达式 | 半严格：`(amount<0 AND type='消费冲销') OR amount>0` |
| `card_transactions` | 零违例，直接 ADD CONSTRAINT |
| `prepaid_cards` | 零违例，直接 ADD CONSTRAINT |
| bigint 升级 | 直接 ALTER COLUMN TYPE（数据量小，秒级） |
| timezone | ALTER DATABASE 防漂移（已是 Asia/Shanghai，零业务影响） |
