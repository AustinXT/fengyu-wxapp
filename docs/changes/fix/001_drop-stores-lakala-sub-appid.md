---
type: fix
number: "001"
date: 2026-05-30
title: stores 删除冗余 lakala_sub_appid 列
tags: [lakala, schema, stores, redundancy]
related: ["arch/003", "arch/009"]
---

# fix/001 stores 删除冗余 lakala_sub_appid 列

## 事件概述

- **发现时间**：2026-05-30，code review 询问"每店都一样的字段为什么要进表"时暴露
- **影响范围**：`stores.lakala_sub_appid` 列 + admin types/actions/tests/e2e 共 ~12 处代码引用
- **严重程度**：低（无线上故障，纯设计冗余 + 双源风险），但属于 schema 层面的预防性清理

## 根因分析

### 直接表现

`stores` 表的 `lakala_sub_appid` 列从未在运行时被读取：

- `fengyu-client/cloudfunctions/clientApi/utils/lakala-config.js:63` 直接 `process.env.LAKALA_SUB_APPID || 'wx811eb4ded3dfba3f'`
- `fengyu-client/cloudfunctions/payNotify/utils/lakala-config.js:63` 同样从 env 读
- `clientApi/routes/order.js:24-41` 的 `resolveLakalaMerchant(storeId)` 只 SELECT `lakala_merchant_no, lakala_term_no, lakala_enabled`，**不读 sub_appid**

而 admin 端 `linkStoreToMerchant` / `_internalApplyLakalaLink` / `syncStoreSnapshots` 等 6 处会把 `lakala_merchants.wx_sub_appid` 快照写回 `stores.lakala_sub_appid`——**写了从不读**。

### 根本原因

`arch/003`（拉卡拉支付接入）建表时按"通用预留"加了 `lakala_sub_appid` 列作为占位符。`arch/009`（商户入网）扩展该列为"商户主表派生的快照"，但同期云函数侧已直接从 env 读取——没有任何业务场景需要 stores 行级 sub_appid 差异化：

- 凤御只有**一个客户端小程序** `wx811eb4ded3dfba3f`，跨 dev/prod 一致
- 拉卡拉聚合主扫协议（trans_type=71）的 `sub_appid` 只识别**接入主体的微信小程序**，不支持按门店动态切换
- 即使一个公司主体下接入多个不同 sub_appid 的小程序，那也是商户主表 `lakala_merchants.wx_sub_appid` 维度的事，与门店无关

形成"列存在 + 写入路径维护 + 读取路径完全旁路"的设计冗余，**双源即风险**：一旦 env 与表里某行不一致，排障时容易追到错误源头。

## 修复方案

### 删除字段

| 层 | 文件 | 改动 |
|---|---|---|
| **schema** | `db/schema/org.ts:71` | 删 `lakalaSubAppid: text('lakala_sub_appid')` 列定义；更新表注释 |
| **migration** | `db/migrations/0059_aromatic_loki.sql` | 新增 `ALTER TABLE "stores" DROP COLUMN "lakala_sub_appid";`（drizzle-kit 自动生成） |
| **admin types** | `fengyu-admin/src/lib/types.ts` | 删 `Store.lakalaSubAppid` 字段 |
| **admin action** | `fengyu-admin/src/actions/stores.ts` | 删 SELECT 返回字段、`updateStore` 入参类型、strip 行 |
| **admin action** | `fengyu-admin/src/actions/lakala-onboarding.ts` | `syncStoreSnapshots` / `linkStoreToMerchant` / `unlinkStoreFromMerchant` / `cancelOnboarding` / `_internalApplyLakalaLink` 共 6 处不再写快照 |
| **admin 单测** | `src/actions/__tests__/lakala-onboarding.test.ts` | 删 4 处 `lakalaSubAppid` 断言 + 表镜像字段 |
| **admin e2e smoke** | `tests/e2e-actions/smoke-lakala-onboarding.impl.mjs` | STEP9/10 删 sub_appid 校验 |
| **admin e2e chain** | `tests/e2e-chains/link-54-store-lakala-config-edit.spec.ts` | 重写为只测 `lakala_term_no` + `lakala_enabled` 持久化 + 审计日志（原 spec 测的 4 字段中 `lakala_sub_appid` 已删、`lakala_merchant_no` 表单已 disabled，只剩这两项 admin UI 仍可编辑） |
| **历史文档** | `docs/changes/arch/003` / `arch/009` | 加脚注标注列已移除 |
| **云函数** | 无 | client/payNotify 已 100% 走 env，无需改 |

### 留存的 4 个 lakala 列语义

```
stores.lakala_merchant_no  ← lakala_merchants.merchant_no 派生快照（仍保留：业务热路径，省一次 join）
stores.lakala_term_no      ← store 级独立编辑（终端号）
stores.lakala_enabled      ← store 级开关
stores.lakala_merchant_id  ← FK → lakala_merchants.id，N:1 商户路由权威
```

`sub_appid` 唯一权威 = 云函数 env `LAKALA_SUB_APPID`（默认硬编码 `wx811eb4ded3dfba3f`）。

### 本地验证

- bootstrap docker PG 从零 apply 全部 59 个 migration 通过
- `\d stores` 确认 lakala 列只剩 4 个，无 `lakala_sub_appid`
- admin 单测 `lakala-onboarding.test.ts` 13/13 全绿
- TypeScript 编译通过

## 预防措施

- [ ] **schema 占位列规则**：未来新增"预留字段"必须在 schema 注释里写明**预期消费方**；如果半年内没有任何代码 SELECT 该列，cron 检查告警
- [ ] **双源识别清单**：拉卡拉相关配置可能存在的双源风险点同步检查：
  - `LAKALA_SUB_APPID` env vs ~~`stores.lakala_sub_appid`~~（本次修复）
  - `LAKALA_API_BASE` env vs cloudbaserc 占位符（未发现风险）
  - `lakala_merchants.merchant_no` vs `stores.lakala_merchant_no`（仍是双源，但 admin UI 已 disabled 防手填，由 `syncStoreSnapshots` 单向派生）

## 部署 checklist

1. **dev**：5434/fengyu 跑 `npm run db:migrate` → apply 0059
2. **prod**：5433/fengyu_wxapp 跑 `npm run db:migrate` → apply 0059
3. **不可逆**：`DROP COLUMN` 是不可逆操作，上线前再确认一次该列在生产无业务依赖（已确认云函数路径无引用）
4. **云函数**：无需重新部署（clientApi/payNotify 路径无改动）
5. **admin**：重新 build/部署即可（用 deploy-admin.sh）

## 相关变更记录

- `arch/003` 拉卡拉支付接入（列首次引入）
- `arch/009` 拉卡拉商户入网（列被"派生快照化"）
