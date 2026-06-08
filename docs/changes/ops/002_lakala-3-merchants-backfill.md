---
type: ops
number: "002"
date: 2026-05-30
title: 凤御 3 个拉卡拉商户 legacy 行手抄入库 + admin 加「反查开户状态」按钮
tags: [lakala, legacy-backfill, ip-whitelist, queryWxConfig]
related: ["fix/001", "arch/003", "arch/009"]
---

# ops/002 凤御 3 个拉卡拉商户 legacy 行手抄入库 + admin 加「反查开户状态」按钮

## 执行概述

- 时间：2026-05-30
- 执行人：NightVoyager（dougxieting4@gmail.com）
- 环境：5434/fengyu（dev）+ 5433/fengyu_wxapp（prod）
- 上下文：DB 中 lakala_merchants 表只有 1 条 legacy 行（南昌蓝茉店），实际拉卡拉侧已完成 3 家进件，凤御要看完整商户清单。

## 3 个商户（拉卡拉后台截图手抄）

同一归属合作方 `24583784`（"美丫丫"）/ 同一联系人张凯（136****6903）：

| # | merchant_no (merCupNo) | merInnerNo | 拉卡拉经营名称 | 接入小程序业务 |
|---|---|---|---|---|
| 1 | `82242107230052U` | `4002026052532607913` | 南昌县象湖燕美御生活美容馆 | ✓ 接入 stores `store-1779809820771`「南昌象湖店」|
| 2 | `82242107230052S` | `4002026052582608078` | 南昌县蓝茉美容院 | ✓ 接入 stores `store-1779333287626`「南昌蓝茉店」|
| 3 | `82242107230052R` | `4002026052552607045` | 南昌县凤仪韵美容美体馆 | ✗ 拉卡拉侧入网，不接入小程序业务 |

## 步骤一：拉卡拉接口能力调研

| 拉卡拉 query 接口 | 查询键 | 反查 3 商户可用？ |
|---|---|---|
| `queryMerchant` | orderNo + orgCode + contractId | ✗ 需要进件流水号 + 电签合同号，legacy 行的 `out_org_code='legacy-{storeId}'` 是占位符 |
| `queryContract` / `submitAppeal` / `queryWxRealname` 等 | orderNo + orgCode + (contractId/merInnerNo) | ✗ 同上依赖进件上下文 |
| **`queryWxConfig`** | tradeMode + merchantNo + subMerchantId | ✅ **唯一不依赖进件上下文的接口**，但只返开户状态 |

经营名称、注册名称、法人等信息**截图就有**，不需要拉卡拉接口反查；只剩开户状态需要反查。

## 步骤二：SIT 连通性 smoke 实测（IP 白名单阻塞）

新写 `fengyu-admin/tests/e2e-actions/sit-lakala-query-3-merchants.mjs`，6 次 queryWxConfig 调用（3 商户 × WECHAT/ALIPAY）。

**实测结果（本地开发出口 IP 5.34.216.45）**：

```
🚧 全部 6 次返 GW0004：访问授权不通过！【禁止外网访问！】
```

证实 arch/009 第 126 行记录的"SIT IP 白名单最阻塞"再次复现：代码层、签名层、网络层全通，**纯粹是拉卡拉网关 IP 白名单拒绝**。

**后续动作**：业务方联系拉卡拉客户经理，把开发出口 IP（5.34.216.45）和 prod 服务器出口 IP（47.113.202.7）分别加入 SIT / prod 网关白名单。

## 步骤三：Phase 1 一次性 SQL 入库（双库）

`db/scripts/seed-legacy-lakala-3.sql`：

```sql
-- 1. UPDATE 蓝茉 form_data（已有 legacy 行，merchant_name 改为拉卡拉注册全名）
-- 2. INSERT 象湖 lakala_merchants + UPDATE stores 连 FK
-- 3. INSERT 凤仪韵 lakala_merchants（孤立行，不接入小程序）
```

双库实测：

```bash
PGPASSWORD=*** psql -h 47.113.202.7 -p 5434 -U fengyu -d fengyu \
  -f db/scripts/seed-legacy-lakala-3.sql
# BEGIN / UPDATE 1 / INSERT 0 1 / UPDATE 1 / INSERT 0 1 / COMMIT

PGPASSWORD=*** psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp \
  -f db/scripts/seed-legacy-lakala-3.sql
# 同上
```

校验后两库 lakala_merchants 都有 3 行，stores 蓝茉 + 象湖都连了 `lakala_merchant_id`。

## 步骤四：Phase 2 admin 加「从拉卡拉反查开户状态」按钮

新增 Server Action `fengyu-admin/src/actions/lakala-onboarding.ts` 的 `refreshMerchantStatusFromLakala(merchantId)`：

- 调 `queryWxConfig` × 2（tradeMode WECHAT + ALIPAY）
- `subMerchantId` 优先取 `form_data.merInnerNo`，fallback `merchantNo`
- 状态码映射（IP 白名单通后实测确认）：
  - `AUTHED` / `SUCCESS` / `OPEN` → `success`
  - `FAIL` / `REJECTED` / `CLOSED` → `fail`
  - `PENDING` / `MODIFYING` → `modifying`
  - `SUBMITTED` → `submitted`
  - 其他 → 不动 DB（保守）

UI：`fengyu-admin/src/app/(main)/lakala-onboarding/[id]/_components/refresh-status-button.tsx`，client component，在详情页「交付物信息」卡片下方新增「开户状态」卡片，按钮 + 反查结果 toast。

GW0004 时按钮显示警告引导业务方加白名单。

## 步骤五：单元测试

`refreshMerchantStatusFromLakala` 4 case 全绿：

- legacy 行：subMerchantId 用 merInnerNo，AUTHED 映射 success
- merchant_no 缺失：返回 false，不调拉卡拉
- GW0004 网关拒：success=true 但无 mapped，不动 DB
- subMerchantId fallback：form_data 无 merInnerNo → 用 merchantNo

admin 全套 vitest 17/17（lakala-onboarding 文件）全绿，tsc 26 个 baseline drizzle 错误无新增。

## 坑记录

### 现有 SIT smoke 的字段名 bug

`sit-lakala-onboarding-14step.mjs:99` 调用：
```js
client.queryWxConfig({ merNo: SIT_MERCHANT })   // 错误字段名
```
而 TS 类型签名是 `{ tradeMode, subMerchantId, merchantNo }`，实际拼到 reqData 的全是 undefined。

**未修**（与本任务正交，且对 GW0004 这条阻塞链上无影响）。新写的 `sit-lakala-query-3-merchants.mjs` 用正确字段名。

### lakala_realname_status 枚举只有 5 值

`db/schema/enums.ts:244` 定义 `not_submitted | submitted | success | fail | modifying`，没有 `verified` 之类。映射时按这 5 值写。

## 后续 TODO

- [ ] 业务方联系拉卡拉客户经理加 IP 白名单（开发 5.34.216.45 + prod 47.113.202.7）
- [ ] IP 通后跑 `bun fengyu-admin/tests/e2e-actions/sit-lakala-query-3-merchants.mjs`，记录拉卡拉响应字段真实名称和取值
- [ ] 据实测响应回来修 `refreshMerchantStatusFromLakala` 的状态映射表（当前是宽容多键 + 推测取值）
- [ ] prod 部署 admin（v0.14.X），按钮才能在线上点

## 相关变更记录

- `fix/001` stores 删除冗余 `lakala_sub_appid` 列（本任务的前置）
- `arch/003` 拉卡拉支付接入（4 个 lakala 列首次引入）
- `arch/009` 拉卡拉商户入网（14 步流程 + IP 白名单坑）

## 相关文件

- `db/scripts/seed-legacy-lakala-3.sql` — Phase 1 一次性 SQL
- `fengyu-admin/tests/e2e-actions/sit-lakala-query-3-merchants.mjs` — Phase 0 SIT smoke
- `fengyu-admin/src/actions/lakala-onboarding.ts` `refreshMerchantStatusFromLakala` — Phase 2 action
- `fengyu-admin/src/app/(main)/lakala-onboarding/[id]/_components/refresh-status-button.tsx` — Phase 2 UI
- `fengyu-admin/src/actions/__tests__/lakala-onboarding.test.ts` — Phase 2 单测
