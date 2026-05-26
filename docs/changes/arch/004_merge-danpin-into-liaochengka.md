---
type: arch
number: "004"
date: 2026-05-21
title: 单品合并入疗程卡（product_type 枚举 3→2 值）
tags: [product_type, enum, refund, conversion, schema-migration]
related: []
---

# arch/004 单品合并入疗程卡（product_type 枚举 3→2 值）

## 背景与动机

`product_type` 是控制商品"核销流程"的 PG 枚举，原为 3 值 `[疗程卡, 单品, 家居产品]`。

调研发现 **疗程卡与单品在底层是同一种东西**——都走"按次核销"（`remaining_sessions`），
`service.complete()` 扣次数的 SQL 对两者零分支。单品本质就是 `session_count=1` 的疗程卡。
两者的差异全部是后天围绕字面量 `'单品'` 长出的特殊分支（1 年有效期、退款口径、转换抵扣），
其中退款/转换还把单品当"实物按件"（quantity − picked_up）处理，与持卡/核销把它当"卡按次"
（remaining_sessions）处理自相矛盾——单品同时挂了两套追踪字段，语义混乱。

决策：删除枚举值 `单品`，统一为 `[疗程卡, 家居产品]`，消除语义重复与分支特例。

## 决策与口径取舍（用户拍板）

| 维度 | 合并后行为 |
|------|-----------|
| 数据归并 | 原 session_count=1 的单品 → 疗程卡（次数=1）；原实物零售单品（session_count=null，如精华液/礼盒）→ 家居产品 |
| 退款 | 统一按 `remaining_sessions`（疗程卡）；家居产品仍按 `quantity − picked_up_quantity` |
| 转换抵扣 | **放开**：原单品不再要求 `is_experience=true`，只要 `remaining_sessions>0` 即可抵 |
| 1 年有效期 | **移除**：原"单品支付后 expire_date=paid+1年"自动赋值全部删除（staff/client/payNotify） |
| 开单拆行 | 原单品 qty>1 现按疗程卡逻辑拆成 N 行（接受此后果） |

历史数据上线前会清空（[[project_pre_launch_data_wipe]]），故 migration 内的存量 UPDATE 仅为开发库/测试一致性。

## 数据模型

- `db/schema/enums.ts`：`productTypeEnum` 从 3 值改为 `["疗程卡", "家居产品"]`
- migration `0050_green_tyrannus.sql`：旧枚举下先 `UPDATE 单品→疗程卡` + `session_count` 回填（补 1），
  再走 drizzle 生成的"列转 text → DROP TYPE → 重建 2 值 → cast 回"重建块。
  数据 UPDATE 必须先于 cast-back，否则 cast 撞到残留 '单品' 失败。
- 双库部署（[[project_db_dual_env]]）：5434 + 5433 上线前都须迁。

## 架构设计

- **跨端独立副本一致性**（[[feedback_no_shared_cloudfunctions]]）：staffApi / clientApi / payNotify / admin
  四端各自改副本，同步删除 `'单品'` 分支；refund 逻辑（`if 疗程卡 → remaining_sessions; else 家居产品 → quantity`）
  结构未变，仅原单品自动归入疗程卡分支，注释更新。
- 转换抵扣：staff `customerHeldCards` / admin `getCustomerHeldCards` 的 CASE/WHERE 删除 `单品 AND is_experience` 子句，
  只留 `疗程卡 AND remaining_sessions>0`；`createConversion` 删除 `单品 picked_up` 标记分支。
- `IN ('疗程卡','单品')` 查询统一收敛为 `= '疗程卡'`（mgmt-product 持卡统计、可预约项、可用服务项目）。
- admin `orders.ts:631` 的 expire_date UPDATE 为无条件赋值（非单品专属，既有疗程卡行为），本次未动——
  标注 staff（仅原单品设有效期）vs admin（全行设有效期）的既存跨端不一致，留作后续决策。

## 相关文件

- `db/schema/enums.ts`、`db/migrations/0050_green_tyrannus.sql`
- `db/scripts/{sync-products-from-workfine,sync-workfine,migrate-history-orders}.js` — 上游"单品"映射改输出疗程卡+session_count=1
- `fengyu-admin/src/actions/{cards,orders,products,services}.ts`、`src/lib/{refund,refund-cascade,types,schemas}.ts`、`src/db/seed.ts`
- `fengyu-staff/cloudfunctions/staffApi/routes/{order,mgmt-product}.js`、`utils/refund.js`
- `fengyu-client/cloudfunctions/clientApi/routes/order.js`、`payNotify/index.js`
- 各端小程序 wxml/ts + `.42cog/` spec + `docs/管理后台使用手册.md`

## 验证

- admin：`bun run test` 全绿（1200 用例），`tsc --noEmit` 0 错。
- staff/client：受影响单测 + 跨端 snapshot 跑批，相对改前基线**零新增失败**（既有 19 项 staff + 9 项 client 失败均为
  无关的 is_recharge_card / recharge.ts 文案 / 优惠券失效等先存问题）。
- migration 0050 在空库 `bootstrap-from-zero.sh` 从零 apply 通过，枚举落地为 2 值。
- grep 闸门：运行时代码零 `'单品'` 字面量分支（仅余记录变更的解释性注释）。

## 相关变更记录

- 无（独立架构变更）
