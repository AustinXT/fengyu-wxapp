> **✅ 2026-05-18 R1 闭合**
> - **S3 staff 裸抛**：grep 实证 service.js:386 + order.js:1027 已自然带 `INVALID_PARAMS:` 前缀（ticket §3.1 描述的旧行号 367/988 已无效），无需修。staff routes 仅剩 2 处内部 helper assertion（`generateOrderNo / generateServiceOrderId: client is required`）— 事务上下文不变量守护，不属用户面错误，保留。
> - **S2 CI 接入**：`.github/workflows/lint.yml` 新增 `cross-end-snapshots-staff` + `cross-end-snapshots-admin` 两 job，跑 cross-end-error-codes-snapshot.test.js + cross-end-sql-snapshot.test.js + admin error-codes-cross-end.test.ts。
> - **S4 文档校对**：audit-CC5-error-code.md 顶部加 v4 闭合 banner；SUMMARY.md L212 `4 项约定` → `9 项白名单已统一`；audit_plan.md L264/L425 同步。其他历史 docs/audit/* 不动（语义由 audit-CC5 banner 总括覆盖）。
> - **附带修复**：cross-end-sql-snapshot.test.js L216/223/230 三处 regex stale（假设 `export async function` 形态，实际 admin orders.ts 已用 `export const ... = withPermission(...)` 包装）—— 兼容 regex 两形态后 81/81 全绿。
> - **反向守护扩展**（admin lib/* + client routes，0 violations 实测）按用户决策本批不做，未来如再审计可单独 ticket 启用。
>
> 生成日期：2026-05-18
> 严重级别：P1（**降级** — Top10 #10 实质 80% 已闭合；本 ticket 是收尾守护 + CI 监控）
> 端：**三端 + admin + payNotify**（fengyu-admin / fengyu-staff / fengyu-client / payNotify）
> 影响面：
> - 四端 error-codes：现状已对齐 9 项白名单（grep 实证 2026-05-18），本 ticket 仅做"反向守护 + CI 监控"，不改 production 代码
> - cross-end snapshot：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js` 已存在（169 行）+ `fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts` 已存在
> - admin lib/* 裸 throw：grep 实证 2026-05-18 **lib/* 已 100% 用前缀 throw**（refund.ts/recharge.ts/permissions.ts/scope-assert.ts 共 12 处，全部规范），**Top10 #10 admin lib/* 部分实质已关闭**
> - staff routes 2 处历史裸抛（audit-CC5 P2-04/05）：service.js:367 全角冒号、order.js:988 方括号前缀 — 本 ticket 顺手收尾
> - CI 增量：把现有 snapshot 测试接入 PR gate（与 lint:cas-guards 一致路径）
> 修复成本：S（半周 — 主要是 CI 接入 + 2 处裸抛修正 + 文档对齐）
> 前置：snapshot 测试已存在（grep 实证）；admin api-error.ts 已存在
> 来源：Top10 #10（SUMMARY v4 §2）+ audit-CC5-error-code.md + SUMMARY v4 §6.3 中期

**一句话目标**：把 Top10 #10「错误前缀 4→8 项白名单未抽 + admin 裸 throw 未统一」收尾——经 2026-05-18 grep 复核 admin lib/* 已 100% 规范 + 三端 error-codes 已对齐 9 项 + cross-end snapshot 已就绪；剩余工作只是 (1) CI 接入 snapshot 测试 (2) 修 staff routes 2 处历史裸抛 (3) 校对文档把"4 项"全部改为"9 项"。

---

## 0 一句话背景

audit-CC5（2026-04-26 合并版）总结全栈"4 项约定规范率"：staff 92.4% / client 94.4% / admin 17% / payNotify 0%。**2026-05-17~05-18 v3→v4 期间已完成**：

1. ✅ 三端 error-codes.js / admin api-error.ts 单源 9 项白名单（grep 实证 2026-05-18，三端 ERROR_PREFIXES 数组字节同义）
2. ✅ admin api-error.ts + runWithApiResponse 已落地（ticket archives/2026-05-17-admin-lib-throw-to-apierror.md）
3. ✅ admin actions/* 33 处野生前缀 throw → ApiError（snapshot test L148 反向断言 violationCount=0）
4. ✅ cross-end-error-codes-snapshot.test.js + admin 同款 .test.ts 双端守护

剩余的 audit-CC5 P2 项（grep 实证 2026-05-18）：

| audit-CC5 编号 | 项 | 现状 |
|---|---|---|
| P2-CC5-04 | service.js:367 全角中文冒号 → 等同裸抛 | ❌ 未修 |
| P2-CC5-05 | order.js:988 方括号前缀 → 等同裸抛 | ❌ 未修 |
| P2-CC5-06 | admin 17% 规范率 | ✅ ticket archives/2026-05-17-admin-lib-throw-to-apierror.md 已关闭 |
| P2-CC5-07 | sanitizeErrorMessage 60 字符截断 | ❌ 未修（小 UX 影响）|
| P2-CC5-08 | 三端 sanitize 规则差异 | ❌ 未修（小 UX 影响）|
| P1-CC5-01/03 | staff callStaffApi 丢 errorType | ❌ 未修（mgmt-customer-detail 单一受影响点）|
| P1-CC5-02 | PHONE_REQUIRED / PERMISSION_DENIED 共用 -403 | ✅ 决策文档化（前端按 errorType 区分；CLAUDE.md / api-error.ts L11 已注明）|

本 ticket 只做"**Top10 #10 真正闭合**"的收尾 3 件事：

- (a) CI 接入 cross-end-error-codes snapshot
- (b) 修 staff routes 2 处历史裸抛（P2-CC5-04/05）
- (c) 文档校对：grep 全仓"4 项约定" / "4 项白名单"出现处，全部改为"9 项"

> P1-CC5-01/03 callStaffApi 丢 errorType + P2-CC5-07/08 sanitize 阈值 → **独立 P2 ticket**（受影响范围仅 mgmt-customer-detail 一处，UX 体验问题非合规）

---

## 1 现状盘点

### 1.1 4 端 error-codes 对齐情况（grep 实证 2026-05-18）

| 端 | 文件 | ERROR_PREFIXES 数组 | CODE_MAP |
|---|---|---|---|
| admin | `fengyu-admin/src/lib/api-error.ts:31-41` | 9 项 freeze | ✅ |
| staff | `fengyu-staff/cloudfunctions/staffApi/utils/error-codes.js:25-35` | 9 项 freeze | ✅ |
| client | `fengyu-client/cloudfunctions/clientApi/utils/error-codes.js:25-35` | 9 项 freeze | ✅ |
| payNotify | `fengyu-client/cloudfunctions/payNotify/error-codes.js`（存在，未读，按 snapshot test L31 引用）| 9 项 | ✅ |

四端 ERROR_PREFIXES 完全一致（snapshot test 守护）：

```
UNAUTHORIZED / PHONE_REQUIRED / INVALID_PARAMS / PERMISSION_DENIED /
NOT_FOUND / INSUFFICIENT_BALANCE / CONFLICT / INVALID_STATE / CLIENT_NOT_REGISTERED
```

CODE_MAP 也一致：

```
-401: UNAUTHORIZED
-403: PHONE_REQUIRED / PERMISSION_DENIED (共用)
-400: INVALID_PARAMS / INSUFFICIENT_BALANCE / INVALID_STATE / CLIENT_NOT_REGISTERED
-404: NOT_FOUND
-409: CONFLICT
```

### 1.2 cross-end snapshot 测试现状（grep 实证 2026-05-18）

`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js`（169 行）覆盖：

- describe '9 项官方白名单' — 4 端 ERROR_PREFIXES === 期望排序后数组（4 test）
- describe '两两镜像比对' — staff vs client / staff vs payNotify / staff vs admin TS（3 test）
- describe 'CODE_MAP 一致性' — staff vs client / staff vs payNotify / PHONE_REQUIRED=-403 / 4 项 -400（4 test）
- describe 'Snapshot 兜底' — staff ERROR_PREFIXES toMatchSnapshot（1 test）
- describe 'admin actions/ 范围 0 处非白名单裸 throw' — grep 反向断言 violationCount === 0（1 test）

合计 **13 test**。snapshot 文件位于 `__snapshots__/cross-end-error-codes-snapshot.test.js.snap`。

admin 侧对称守护：`fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts` 已存在（按 api-error.ts L7 引用）。

### 1.3 admin lib/* 裸 throw grep 实证（2026-05-18）

```bash
grep -rEn "throw new Error\(" fengyu-admin/src/lib/ \
  | grep -v "__tests__\|api-error.ts\|test.ts" \
  | grep -vE "throw new Error\(['\"\`](UNAUTHORIZED|PHONE_REQUIRED|INVALID_PARAMS|PERMISSION_DENIED|NOT_FOUND|INSUFFICIENT_BALANCE|CONFLICT|INVALID_STATE|CLIENT_NOT_REGISTERED):"
# 输出：0 行
```

实际 throw 分布（全部规范）：

| 文件:行 | 前缀 |
|---|---|
| `lib/refund.ts:84` | `INVALID_PARAMS:` |
| `lib/refund.ts:90` | `INVALID_PARAMS:` |
| `lib/refund.ts:93` | `INVALID_STATE:` |
| `lib/recharge.ts:43/47/50/53` | `INVALID_PARAMS:` × 4 |
| `lib/permissions.ts:236/256` | `PERMISSION_DENIED:` × 2 |
| `lib/scope-assert.ts:35/42/47/64/71/76/93/100/105` | `INVALID_PARAMS:` × 4 + `PERMISSION_DENIED:` × 5 |

**结论**：**admin lib/* Top10 #10 部分已 100% 闭合**。本 ticket 仅守护"未来不增"，不需修 production 代码。

### 1.4 admin actions/* 裸 throw（snapshot test 反向守护）

`cross-end-error-codes-snapshot.test.js:148-168` 通过 grep + `expect(violationCount).toBe(0)` 守护。**2026-05-18 grep 实测**仅 4 处不在白名单内：

```
fengyu-admin/src/actions/auth.test.ts:430 — throw new Error('NEXT_REDIRECT:/login?expired=1')
fengyu-admin/src/actions/auth.test.ts:535 — 同上
fengyu-admin/src/actions/logs.test.ts:40 — throw new Error('NO_SESSION')
fengyu-admin/src/actions/messages.test.ts:127 — throw new Error(`db.select called more times than mocked (index=${i - 1})`)
```

全部在 **test 文件**（`.test.ts`）— snapshot test grep 已用 `| grep -vE "__tests__|\.test\.ts"` 排除，所以仍是 violationCount=0。✅

### 1.5 staff routes 2 处历史裸抛

`audit-CC5-error-code.md` §2.3 列：

| 文件:行 | 错误信息 | 问题 |
|---|---|---|
| `staffApi/routes/service.js:367` | `次数不足：订单行 ${item.sale_item_id} 剩余次数不足 ${item.session_used}` | 全角冒号 U+FF1A，正则 `^[A-Z_]+:\s*` 不匹配 → 等同裸抛 |
| `staffApi/routes/order.js:988` | `[confirmOffline] 充值订单 product_name 无法解析面值: ${row.product_name}` | 方括号前缀 → 同上 |

修复（按 audit-CC5 §3 P2）：

```js
// service.js:367
throw new Error('INVALID_PARAMS: 次数不足，订单行 ' + item.sale_item_id + ' 剩余次数不足')
// order.js:988
throw new Error('INVALID_PARAMS: 充值卡面值解析异常，请重新录入')
```

### 1.6 CI 接入现状

参考 `SUMMARY.md` v4 §6.1 #A：`bun run lint:cas-guards` **尚未接入** GitHub workflow，cross-end snapshot 同样未接入。两者应一并通过 PR gate。

| 检查 | 当前 | 期望 |
|---|---|---|
| `bun run lint:cas-guards` | 本地手动 | GitHub workflow PR gate |
| `cross-end-error-codes-snapshot.test.js` | bun test 本地手动 | 同上 |
| `cross-end-sql-snapshot.test.js` | 同 | 同 |
| admin `error-codes-cross-end.test.ts` | 同 | 同 |
| `cross-end-pii-snapshot.test.js`（新增，见 ticket 3）| — | 同 |

### 1.7 文档"4 项" / "9 项"残留 grep

```bash
grep -rn "4 项约定\|4 项白名单\|4 项官方" CLAUDE.md fengyu-admin/ fengyu-staff/ fengyu-client/ .42cog/ 2>/dev/null
```

预期残留点（实施时实际 grep 产出）：

| 文件 | 待校对 |
|---|---|
| `CLAUDE.md` 全局规范 §错误前缀约定 | ✅ 已是 9 项（grep 实证：列了 UNAUTHORIZED/PHONE_REQUIRED/INVALID_PARAMS/PERMISSION_DENIED/NOT_FOUND/INSUFFICIENT_BALANCE/CONFLICT/INVALID_STATE/CLIENT_NOT_REGISTERED + 二级前缀说明 + snapshot 守护 + 9 项白名单引用），无需改 |
| `fengyu-admin/CLAUDE.md` | 未发现 4 项残留（实际 grep 验证）|
| `fengyu-staff/CLAUDE.md` 错误前缀约定 | ✅ 已是 9 项 |
| `fengyu-client/CLAUDE.md` 错误前缀约定 | ✅ 已是 9 项 |
| `.42cog/dev/sys.spec.md` 等 spec | 待 grep — 如有 "4 项" 改为 "9 项 + 二级前缀语法" |
| `docs/audit/audit-CC5-error-code.md` § / 附录 | 可保留（历史审计文档；用 banner 标记"v3 已升级 9 项"）|

---

## 2 关键架构决策

### 2.1 不引入新功能，仅做收尾

本 ticket **不**：
- 新建 lib / helper（已全部就绪）
- 改三端 error-codes.js（已对齐）
- 改 admin actions /* (已 100% 走 ApiError + runWithApiResponse)
- 改 admin lib/* (已 100% 规范前缀)

仅做：
- 修 2 处 staff 裸抛
- CI 接入现有 snapshot 测试
- 文档"4 项"→"9 项"残留 grep + 改

### 2.2 CI 接入路径选择（与 SUMMARY v4 §6.1 #A 一致）

| 选项 | 路径 |
|---|---|
| **A** | 加到 `.github/workflows/claude-code-review.yml` 既有 lint step 后 |
| B | 新建 `.husky/pre-commit` hook |

**推荐 A**（与 admin ESLint AST 规则同路径，PR gate 一致）。

具体 step：

```yaml
- name: cross-end snapshot guards
  run: |
    cd fengyu-staff/cloudfunctions/staffApi
    bun test __tests__/routes/cross-end-error-codes-snapshot.test.js
    bun test __tests__/routes/cross-end-sql-snapshot.test.js
- name: admin cross-end error-codes guard
  run: |
    cd fengyu-admin
    bun test src/lib/__tests__/error-codes-cross-end.test.ts
- name: cas-guards lint
  run: bun run lint:cas-guards
```

### 2.3 staff 裸抛修复语义

- `service.js:367` 当前业务条件"剩余次数不足"。审计 P2-CC5-04 指出同文件 service.js:115 已用 `INVALID_PARAMS:`，本 ticket 保持一致前缀。
  - 备选：用 `INSUFFICIENT_BALANCE:`（"次数等价物"语义对齐 audit-15 储值卡余额不足）。但语义模糊（"次数"≠"余额"）— 决策保持 `INVALID_PARAMS:`，与同文件惯例一致。
- `order.js:988` 充值卡面值解析失败属于"输入异常" → `INVALID_PARAMS:`

### 2.4 4 项 → 9 项的文档校对

`CLAUDE.md` 全局规范已升级（grep 验证 2026-05-18 本 ticket 开头列出的 9 项白名单 + 二级前缀语法 + snapshot 守护说明）。本 ticket 仅需 grep 余下 spec 文件 + 历史 audit 报告的"4 项"残留 + 改正或加 banner。

---

## 3 设计目标

### 3.1 staff 裸抛修复

| 文件:行 | before | after |
|---|---|---|
| `staffApi/routes/service.js:367` | `` `throw new Error(\`次数不足：订单行 ${item.sale_item_id} 剩余次数不足 ${item.session_used}\`)` `` | `` `throw new Error(\`INVALID_PARAMS: 次数不足，订单行 ${item.sale_item_id} 剩余次数不足\`)` `` |
| `staffApi/routes/order.js:988` | `` `throw new Error(\`[confirmOffline] 充值订单 product_name 无法解析面值: ${row.product_name}\`)` `` | `` `throw new Error(\`INVALID_PARAMS: 充值卡面值解析异常，请重新录入\`)` `` |

### 3.2 CI workflow patch（`.github/workflows/claude-code-review.yml` 或对应 PR check）

详见 §2.2。

### 3.3 文档校对 patch list

待实施时 grep 实际产出。已知确定校对点：

- `.42cog/dev/sys.spec.md` — 若有"4 项"段，改"9 项 + 二级前缀 [A-Z_]+ 不计白名单"段
- `.42cog/pm/*.pr.spec.md` — 同
- `docs/audit/audit-CC5-error-code.md` — 顶部加 banner：

  > ✅ 2026-05-18 v4 闭合：四端 error-codes 已对齐 9 项 + cross-end snapshot 已守护 + admin lib/* / actions/* 0 处裸抛。本报告以下"4 项约定"段为历史背景，最新约定见 CLAUDE.md §错误前缀约定。

### 3.4 反向守护增强（可选）

snapshot test 当前覆盖"actions/* 范围"。可选增量：扩到 lib/* 同样反向断言：

```js
// 新增 describe block
describe('audit-CC5 反向断言：lib/* 范围 0 处非白名单裸 throw', () => {
  test('grep lib/* 不在 9 项的 throw new Error', () => {
    const escaped = EXPECTED_PREFIXES.join('|')
    let stdout = ''
    try {
      stdout = execSync(
        `grep -rn "throw new Error" fengyu-admin/src/lib/ ` +
          `| grep -vE "__tests__|\\.test\\.ts|api-error.ts" ` +
          `| grep -vE "throw new Error\\([\\'\\"\\\`]?(${escaped}):"`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      )
    } catch (err) {
      stdout = (err.stdout && err.stdout.toString()) || ''
    }
    const violationCount = stdout.split('\n').filter((line) => line.trim()).length
    expect(violationCount).toBe(0)
  })
})
```

类似可加 staff routes / client routes 反向断言（但 staff 已有 19 + 2 处"扩展前缀 / 裸抛"现状，未 0；需先把本 ticket §3.1 两处修完 → 然后才能加守护）。

---

## 4 详细变更清单（按层）

### 4.1 L3 — staff routes 2 处裸抛

| 文件:行 | 修改 |
|---|---|
| `fengyu-staff/cloudfunctions/staffApi/routes/service.js:367` | 改 INVALID_PARAMS 前缀 |
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js:988` | 改 INVALID_PARAMS 前缀 |

### 4.2 L9 — snapshot 反向守护（可选增量）

`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js` 增 describe 块：

- 'lib/* 0 裸抛' — admin/src/lib 反向 grep
- 'staff routes/* 0 裸抛'（修完 §4.1 后启用）
- 'client routes/* 0 裸抛'（client 现状 0，可直接启用）

### 4.3 L9 — CI workflow

新增/修改 `.github/workflows/*.yml`（具体文件名取决于现有 admin lint step 位置）：

详见 §2.2。

### 4.4 L9 — 文档校对

待实施时 grep 实际产出 patch list。已知点：

- `docs/audit/audit-CC5-error-code.md` 头部加 banner

### 4.5 tests

- [ ] staff: `__tests__/routes/service.test.js` 验证 INVALID_PARAMS 前缀正常被 buildErrorResponse 解析
- [ ] staff: `__tests__/routes/order.test.js` 同
- [ ] snapshot 测试本身（已存在）跑过

---

## 5 迁移策略（按 Stage）

| Stage | 内容 | 工期 |
|---|---|---|
| **S1（裸抛修复）** | service.js:367 + order.js:988 改 INVALID_PARAMS 前缀 + 各 1 个单测 case | 0.25 天 |
| **S2（CI workflow）** | 加 GitHub workflow step：cross-end snapshot + lint:cas-guards | 0.5 天 |
| **S3（lib/* 反向守护扩展）** | snapshot test 增 describe block；本地跑通 | 0.25 天 |
| **S4（文档校对）** | grep 全仓 "4 项约定" / "4 项白名单"；audit-CC5 加 banner；spec 校对 | 0.5 天 |

**总工期：1.5 天**

---

## 6 验证 Checklist

### 6.1 staff routes 裸抛修复

- [ ] `bun fengyu-staff/cloudfunctions/staffApi/__tests__/...` 单测全绿
- [ ] 手工：触发 service.complete 次数不足场景 → 前端 errorType === 'INVALID_PARAMS'（修复前为 null）
- [ ] 手工：触发 order.confirmOffline 充值卡面值异常 → 同

### 6.2 snapshot 守护

- [ ] `bun test fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js` 13 test 全绿
- [ ] `bun test fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts` 全绿
- [ ] 故意删 client error-codes.js 1 个前缀 → snapshot 立即报错（演练）
- [ ] 故意在 fengyu-admin/src/lib/refund.ts 加 `throw new Error('foo')` → 反向断言报错（如 §4.2 启用）

### 6.3 CI 接入

- [ ] PR 触发 GitHub workflow → cross-end snapshot step 跑 + 红绿可见
- [ ] PR 触发 lint:cas-guards step（v4 §6.1 #A 并入本批）
- [ ] PR 故意改 admin api-error.ts ERROR_PREFIXES 顺序 → workflow 失败

### 6.4 文档校对

- [ ] `grep -rn "4 项约定" CLAUDE.md docs/ .42cog/ fengyu-*/` 0 处残留
- [ ] `grep -rn "4 项白名单" 同上` 0 处残留
- [ ] audit-CC5-error-code.md 顶部 banner 已加

### 6.5 admin lib/* / actions/* 反向守护

- [ ] `bun run test --filter cross-end-error-codes` 全绿（含 actions/* + lib/* 0 裸抛断言）
- [ ] grep 全仓 admin `throw new Error` 不在白名单 → 仅剩 4 处 test 文件假抛

---

## 7 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| **CI 接入后 PR 流量增加 1-2 个 step 时间** | PR turnaround +30s | 接受 — snapshot 跑很快 |
| **staff 裸抛修复后前端 toast 文案微变** | 极小 UX 差异 | 验证 mgmt-customer-detail 等关心 errorType 的页面行为 |
| **lib/* 反向守护后续新增 throw 强制要求前缀** | 开发学习成本 | CLAUDE.md 已写约定 + ApiError class 可用，无成本 |
| **staff/client routes 反向守护现状未 0 → 启用即破** | 不可立即启用 | 仅在裸抛清零后启用；staff 还有 19 处扩展前缀（已在 knownTypes 内）+ 2 处裸抛（本 ticket 修） — 修完后启用 |
| **历史 audit 报告 banner 误导**（读者认为整个报告作废）| 文档准确度 | banner 措辞精确：仅 4→9 项升级，其他 P0/P1/P2 仍可参考 |

**回滚策略**：
- §4.1 裸抛修复回滚 → 单 commit revert（不影响业务）
- §4.2 snapshot 反向守护回滚 → 删 describe block
- §4.3 CI 回滚 → workflow yaml revert
- §4.4 文档回滚 → 不影响代码

---

## 8 关联

- **审计来源**：
  - `docs/audit/SUMMARY.md` Top10 #10 + §6.3 中期
  - `docs/audit/audit-CC5-error-code.md` 合并版（残留 P2-CC5-04/05）
  - `notes/tickets/archives/2026-05-17-admin-lib-throw-to-apierror.md`（admin lib/* 已闭合）
- **既有蓝本**：
  - `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js`（169 行，13 test）— 反向断言模板
  - `fengyu-admin/src/lib/api-error.ts`（155 行）— ApiError class + runWithApiResponse + ERROR_PREFIXES
  - SUMMARY v4 §6.1 #A — 同批接 CI 的 lint:cas-guards
- **不在范围**：
  - P1-CC5-01/03 staff callStaffApi 透 errorType（独立 P2 ticket，受影响仅 mgmt-customer-detail 一处）
  - P2-CC5-07 sanitizeErrorMessage 60→100 字符（独立小 ticket）
  - P2-CC5-08 三端 sanitize 规则差异（同上）
  - payNotify 解锁与签名（与 E1 epic 同批 — 见 SUMMARY v4 §6.2）
- **相关 memory**：
  - feedback `no-shared-cloudfunctions`（三端 error-codes 各自 1 副本 + snapshot 守护，已落地）
  - feedback `no-legacy-compat`（无历史兼容；删 4 项段直接换 9 项）

---

## 9 复核反馈区（R1 待填）

> 实施前/中由 code reviewer 在此追加反馈块。重点复核：
>
> 1. grep 实际"4 项约定"残留点列表（spec / docs / migration / readme 全扫）
> 2. staff service.js:367 修完是否要顺便看 `__tests__/routes/service.test.js` 的反向锁死 case
> 3. CI workflow 是否要一并加 cross-end-sql-snapshot.test.js（refund-cascade / settlePoints / face_value_override / scope helper / dashboard 一致性 5 套）— 推荐加，与本 ticket 同批
> 4. lib/* 反向断言加上后，未来新增 lib/ 文件需在 CLAUDE.md 显式提醒"throw 必带 9 项前缀"
> 5. staff routes 0 裸抛守护启用前是否要先修完 audit-CC5 P2-CC5-04/05 之外的其他"19 处扩展前缀"（实际它们都在 knownTypes 内，是合规的）
