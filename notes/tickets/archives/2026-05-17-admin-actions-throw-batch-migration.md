# Ticket-10c: admin actions/* 33 处野生前缀批量替换为 ApiError [已归档]

> 生成日期：2026-05-17
> 归档日期：2026-05-17
> 实施状态：✅ **已完成（已归档）**
> 实施日期：2026-05-17
> 严重级别：**P2**（admin Server Action 内 33 处野生前缀 throw 命中 `runWithApiResponse` 兜底 → 前端拿到 `{code:-1, errorType:null, message:'服务器内部错误'}`，无法按业务前缀路由 UI 分支；前端硬编码 `err.message.indexOf('CARD_NOT_FOUND')` 老前缀的 UI 分支永远走不到）
> 端：fengyu-admin
> 修复成本：**M**（实际：1 天，4 个 commit 分批落地）
> 来源：[主 ticket §4.3 / §5 L7 拆出的 follow-up](archives/2026-05-17-error-code-prefix-whitelist-and-admin-throw.md)

---

## 实施小结（2026-05-17）

**4 个 commit 完成 33 处全量迁移**：

| Commit | 内容 |
|--------|------|
| `41ea65f` | `actions/lib` 抛错统一改用 ApiError —— services / service-commissions / pickup-records 各 1 处 + orders/refunds 大部分 |
| `8269452` | refunds 补漏 `PAYMENT_INSERT_FAILED` → ApiError + 修正 system-config mock 路径 |
| `5ec823f` | refunds.approveRefund 内剩余 throw 收敛到 ApiError |
| `efa3218` | refunds 错误码 sentinel 匹配改 includes + rejectRefund 同步迁移 |
| `f424816` | orders/refunds 裸前缀 throw 收尾迁移 ApiError + **snapshot 基线 33 → 0** |

**最终归并映射**（与主 ticket §4.3 对齐）：
- `CARD_*` 系列 9 处 → `NOT_FOUND: 充值卡不存在` / `INVALID_STATE: 充值卡 <原因>` / `CONFLICT:` / `INVALID_PARAMS:`
- `ORDER_ID_GEN_FAILED` / `REF_ORDER_NOT_FOUND` → `INVALID_STATE:` / `NOT_FOUND:`
- `CONCURRENT_CHANGED` / `CARD_CONCURRENT_CHANGED` → `CONFLICT: 数据已被其他操作修改，请刷新`
- `INSUFFICIENT_SESSIONS` / `INSUFFICIENT_BALANCE:${...}` → `INSUFFICIENT_BALANCE:`
- `OVERPAY:${...}` / `OVER_QUANTITY` → `INVALID_STATE:`
- `SKU_NOT_FOUND:${...}` → `NOT_FOUND:`
- `PREPAID_CARD_UPSERT_FAILED` / `PAYMENT_INSERT_FAILED` / `CARD_UPSERT_FAILED` → `CONFLICT:`
- `CLIENT_NOT_REGISTERED` → 保留（已在 9 项白名单内）
- 9 处中文裸抛 → 全部加 `INVALID_STATE:` / `INVALID_PARAMS:` 前缀

**验证（最终态）**：
- 反向 grep `grep -rn "throw new Error" fengyu-admin/src/actions/ | grep -v <9 白名单>` → stdout 空（**0 违规**）
- snapshot 守护 `cross-end-error-codes-snapshot.test.js:166` 已从 `toBeLessThanOrEqual(33)` 收紧到 `toBe(0)`（commit `f424816`）
- `bun run test src/actions/orders.test.ts` → 108/108 全绿
- 配套 fix：refunds.ts 一处 sentinel 匹配从 `err.message === '前缀'` 改为 `includes`，兼容 ApiError 包装后的 `'前缀: 中文消息'` 完整 message

**未做**（明确为可选/范围外）：
- 前端硬编码 `err.message.indexOf('CARD_NOT_FOUND')` 老前缀检测（主 ticket §7.1 列出的风险）—— grep 后未发现残留，无需修改

---

## 0 一句话背景

主 ticket 完成 9 项白名单 + `ApiError` class + `runWithApiResponse` HOF 后，admin 只在 `employees.ts` 1 处示范替换（`'员工编号生成失败'` → `ApiError('INVALID_STATE', ...)`）以验证 Next.js 15 SWC 编译 OK；剩 33 处野生前缀（`CARD_NOT_FOUND` / `ORDER_ID_GEN_FAILED` / `CONCURRENT_CHANGED` / `OVERPAY:${...}` / `SKU_NOT_FOUND:${...}` 及 9 处纯中文裸抛）由本 ticket 全量迁移。

---

## 1 现状（grep 实证 2026-05-17）

### 1.1 33 处违规按文件分布

```bash
grep -rn "throw new Error" fengyu-admin/src/actions/ \
  | grep -vE "__tests__|\.test\.ts" \
  | grep -vE "throw new Error\(['\"\`]?(UNAUTHORIZED|PHONE_REQUIRED|INVALID_PARAMS|PERMISSION_DENIED|NOT_FOUND|INSUFFICIENT_BALANCE|CONFLICT|INVALID_STATE|CLIENT_NOT_REGISTERED):" \
  | awk -F: '{print $1}' | sort | uniq -c | sort -rn
```

| 文件 | 违规数 |
|------|--------|
| `fengyu-admin/src/actions/orders.ts` | 25 |
| `fengyu-admin/src/actions/refunds.ts` | 5 |
| `fengyu-admin/src/actions/services.ts` | 1 |
| `fengyu-admin/src/actions/service-commissions.ts` | 1 |
| `fengyu-admin/src/actions/pickup-records.ts` | 1 |
| **总计** | **33** |

### 1.2 orders.ts 内 25 处野生前缀类别（抽样）

| 类别 | 抛错示例 | 推荐归并到 |
|------|---------|-----------|
| `CARD_*` 充值卡专属（约 9 处） | `CARD_NOT_FOUND` / `CARD_STORE_MISMATCH` / `CARD_OWNER_MISMATCH` / `CARD_DIRECTION_INVALID` / `CARD_ORDER_STATUS_INVALID` / `CARD_EXHAUSTED` / `CARD_TYPE_INVALID` / `CARD_CONCURRENT_CHANGED` / `CARD_UPSERT_FAILED` | `NOT_FOUND: 充值卡不存在` / `CONFLICT: 充值卡数据并发冲突` / `INVALID_STATE: 充值卡 <具体原因>` / `INVALID_PARAMS: 充值卡类型不合法` |
| `ORDER_ID_GEN_FAILED` | line 1585 | `INVALID_STATE: 订单号生成失败` |
| `SKU_NOT_FOUND:${...}` | line 1559 | `NOT_FOUND: SKU 不存在 (${id})` |
| 纯中文裸抛 | line 1148 `'订单号生成失败'`、line 1163 `'该顾客已有待支付订单 ...'`、line 1224 `'优惠券已被使用，请刷新后重试'` | 全加前缀：`INVALID_STATE:` / `CONFLICT:` / `CONFLICT:` |
| `[applyRechargeOnOrderPaid] prepaid_cards UPSERT 失败` | line 105 | `CONFLICT: 充值卡数据写入冲突，请重试` |
| 多行 throw（含 `\n`） | line 80 | 按 message 内容分类 |

### 1.3 主 ticket §4.3 已给出的归并映射表

直接复用，34 处 → 33 处（已扣除 employees.ts 1 处）：

| 类别 | 数量 | 归并 |
|------|------|------|
| `CARD_*` 系列 | 9 | 按 message 分到 `INVALID_STATE` / `NOT_FOUND` / `CONFLICT` |
| `ORDER_*` / `REF_ORDER_NOT_FOUND` | 3 | `INVALID_STATE:` / `NOT_FOUND:` |
| 业务状态/并发（`CONCURRENT_CHANGED` / `OVERPAY:${...}` / `INSUFFICIENT_SESSIONS` / `OVER_QUANTITY` / `PREPAID_CARD_UPSERT_FAILED` / `PAYMENT_INSERT_FAILED` / `SKU_NOT_FOUND:${...}` ) | 11 | `CONFLICT:` / `INVALID_STATE:` / `INSUFFICIENT_BALANCE:` / `NOT_FOUND:` |
| 9 处中文裸抛 | 9 | `INVALID_STATE:` 或 `INVALID_PARAMS:` |
| `CLIENT_NOT_REGISTERED` | 1 | **保留原前缀**（已在 9 项白名单内） |

> 主 ticket §4.3 表格为权威映射，本 ticket 实施时直接对照。

---

## 2 迁移设计

### 2.1 单 throw 替换模式

```diff
- if (!cardRow) throw new Error('CARD_NOT_FOUND')
+ if (!cardRow) throw new ApiError('NOT_FOUND', '充值卡不存在')
```

### 2.2 Server Action 返回 shape 兼容性

admin Server Action 当前两种写法并存：
- (a) `return { success:false, message:'...' }` — 业务校验失败
- (b) `throw new Error(...)` — 异常路径（被 Next.js 转 500）

**ApiError 替换不改 try/catch 包装**：现有 catch 块如果只是 `catch (err: any) { ...; throw err }`，ApiError 会冒泡到 Next.js Server Action runtime，前端 fetch 收到 500 + serialize 后的 error message。

**推荐策略**（与 employees.ts 示范一致）：
- 不强制把所有 action 包到 `runWithApiResponse`（避免触发 Next.js 15 "Server Action must be async function declaration" 错误）
- 只把 `throw new Error('<野生前缀>')` 改为 `throw new ApiError('<9项白名单前缀>', '<中文消息>')`
- 上层 catch 块需要时再补 `if (err instanceof ApiError) return { success:false, message: err.message, errorType: err.prefix }`

### 2.3 分批顺序（按依赖度从小到大）

| 批次 | 文件 | 违规数 | 备注 |
|------|------|--------|------|
| 1 | `pickup-records.ts` | 1 | 最小，验证模式可行 |
| 2 | `service-commissions.ts` | 1 | 同上 |
| 3 | `services.ts` | 1 | 同上 |
| 4 | `refunds.ts` | 5 | 中等，跑 `refunds.test.ts` 验证 |
| 5 | `orders.ts` | 25 | 最大，分子批：CARD_* (9) → ORDER_*/SKU_* (4) → 业务状态 (8) → 中文裸抛 (4) |

每批迁完：
1. 跑对应模块单元测试：`bun run test src/actions/<file>.test.ts`
2. 同步下调 snapshot 基线：`cross-end-error-codes-snapshot.test.js:166` 的 `toBeLessThanOrEqual(33)` → `... (33-N)`
3. 单批独立 commit，便于回滚

最终基线：`toBeLessThanOrEqual(0)`。

---

## 3 风险与守护

### 3.1 前端硬编码老前缀

主 ticket §7.1 已警示。本 ticket 执行前先 grep 一次：
```bash
grep -rn "indexOf\\(['\"]\\(CARD_\\|ORDER_\\|OVERPAY\\|SKU_NOT_FOUND\\)" fengyu-admin/src/ fengyu-staff/miniprogram/ fengyu-client/miniprogram/
```
若有残留，本 ticket 同 PR 修复（改为 `err.errorType === '<NEW_PREFIX>'`）。

### 3.2 admin Server Action 测试

跑 `bun run test src/actions/` 全量，目标零回归。注意 `orders.test.ts` 当前 108/108 全绿（用户已对齐文案中文化的断言），本 ticket 改 throw 不应破坏这些断言（throw 不在 Server Action 早 return 路径上的拒单分支，是真正异常路径）。

### 3.3 跨端 SQL snapshot 不受影响

`cross-end-sql-snapshot.test.js` 守护 SQL 字面量，与 throw 改动无关联。

---

## 4 验证

```bash
cd /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin && bun run test
# 预期：全绿

cd /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi && \
  bun --bun ./node_modules/.bin/vitest run __tests__/routes/cross-end-error-codes-snapshot.test.js
# 预期：14/14（含基线断言下调）

grep -rn "throw new Error" /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/ \
  | grep -vE "__tests__|\.test\.ts" \
  | grep -vE "throw new Error\(['\"\`]?(UNAUTHORIZED|PHONE_REQUIRED|INVALID_PARAMS|PERMISSION_DENIED|NOT_FOUND|INSUFFICIENT_BALANCE|CONFLICT|INVALID_STATE|CLIENT_NOT_REGISTERED):" \
  | wc -l
# 预期：0
```

---

## 5 关联

| 项 | 说明 |
|----|------|
| **主 ticket** | [2026-05-17-error-code-prefix-whitelist-and-admin-throw.md](2026-05-17-error-code-prefix-whitelist-and-admin-throw.md) §4.3（归并映射表权威）+ §5 L7（示范文件路径） |
| **依赖** | `fengyu-admin/src/lib/api-error.ts`（`ApiError` class，已就位） |
| **配套 follow-up** | [ticket-10b admin lib/* 2 处](2026-05-17-admin-lib-throw-to-apierror.md) |
| **可能冲突** | [ticket-10d admin with-permission 迁移补齐](2026-05-17-admin-with-permission-completion.md) — orders.ts / refunds.ts / services.ts 在 10d 范围内有 `getSession/requirePermission` 旧调用待迁；本 ticket 与 10d 同时改这 3 文件时需协调 PR 顺序（建议 10d 先做，10c 在 10d 完成后跟进） |
| **守护测试** | `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js` 基线随迁移下调 |
