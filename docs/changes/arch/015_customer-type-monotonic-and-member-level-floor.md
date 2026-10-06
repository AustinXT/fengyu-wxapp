---
type: arch
number: "015"
date: 2026-10-06
title: 顾客分类改回只升不降 + 会员客等级下限初钻（#545，推翻 #257）
tags: [customer, membership, caliber-reversal, cross-end]
related: ["arch/013"]
---

# arch/015 顾客分类改回只升不降 + 会员客等级下限初钻

## 背景与动机

2026-09-23 甲方拍板放弃「只升不降」，把 `client_wechat_users.customer_type` 改为按实收口径**双向同步**（issue #257，PR #520，2026-10-06 03:02 起随每日 cron 在生产生效）。2026-10-06 用户推翻该决定，并新增一条规则：**会员客的 `member_level` 不能为 NULL，兜底最低档「初钻」**。

反转的动机是业务侧对「顾客会掉档」的接受度低于预期，且 401 位会员客在顾客档案里没有等级徽章、看起来像数据坏了。

## 决策

设档位序 `rank`：流量客 0 < 体验客 1 < 小美客 2 < 会员客 3。

1. **全量通道一律只升不降**：目标档位 = `max(现值, 计算值)`。口径/算法修正导致的档位下降**不发生**。
2. **退款是唯一放行降档的通道**：#524 第 5 条「已退款订单抹掉达标贡献、按剩余有效订单重算」保留，但落点从「次日 cron」改到**退款审批事务内的即时重算**。
3. **会员客 `member_level` 下限 = 初钻**，不允许 NULL；非会员客仍为 NULL。由此 `new_member_threshold` 不再参与等级判定，只影响 `customer_type` 的入会判定。

### 为什么退款的例外落在事件路径而不是 cron

要在全量重算里区分「退款造成的下降」与「口径修正造成的下降」，需要重建「退款前」的档位。实测 prod 的已退款单据**行级金额已被清零**（`sale_items.received = 0`，只剩订单级 `sale_orders.received`），`is_experience` 也可能被改写，重建不可靠。

改成事件路径后规则是分离的、可守护的：全量 = 单调，退款 = 精确重算。这也恢复了 #257 之前的形态（退款链路曾调用 `recalcCustomerType`，#257 以「只升不降时不产生有效变更、徒增事务时长」为由移除；该理由在只升不降让位于退款例外的口径下已不成立）。

## 影响面

### customer_type（方向反转，4 处）

判据写成「计算值 rank **严格高于**现值才升级」，而非「现值 >= 计算值就保留」。两者在正常数据上等价，但后者在 rank 为 NULL（未知档位）时会落 ELSE 分支、**静默按低档降级**；写成前者则比较结果为 NULL → 保留现值，fail closed。当前 `customer_type` 是闭合 4 值 enum、rank 不可能为 NULL，这是给「将来加第 5 档」留的安全方向。


实时收款 4 条路径（staffApi / clientApi / payNotify / admin orders.ts 的 `recalcCustomerType`）**本来就是只升不降**，未动。改回单向的是：

| 位置 | 改动 |
|---|---|
| `db/scripts/recalc-all-customer-types.js` | `new_type` 取 `max(现值, 计算值)`；恢复 `TYPE_RANK_CASE`；新增只读列 `computed_type` 与 `PREVIEW_PROTECTED_SQL`（回答「若无单调门会有多少人掉档」） |
| `fengyu-admin/src/cron/steps/refresh-customer-types.ts` | `classified` 产出 `computed_type`，新增 `monotonic` CTE 做 max |
| `fengyu-admin/src/lib/recompute-customer-tags.ts` | 恢复 `会员客` 早退；`recomputeCustomerTypeForUser` 增 `allowDowngrade` 入参；新增导出 `recomputeCustomerTypeOnRefund` |
| `db/scripts/sync-workfine.js` | 无代码改动，继承离线脚本 SQL |

`CUSTOMER_TYPE_AMOUNTS_SQL`（金额判定 CTE）刻意不动 —— 它是 admin↔db 逐字 snapshot 守护对象，方向逻辑只加在 CTE 之外。

### 退款通道允许降档（2 处）

- `staffApi/routes/order.js` 的 `approveRefund`：恢复 `recalcCustomerType(..., true)`。
- `fengyu-admin/src/actions/refunds.ts`：新增 `recomputeCustomerTypeOnRefund(tx, userId)`。

两处的 UPDATE 都追加 `OR (<allowDowngrade>::boolean AND customer_type IS DISTINCT FROM <new>)`；默认分支的 `<` rank 守卫字面不变，跨端 5 副本继续逐字一致，只有 staffApi 副本带救命口。

### member_level 下限（5 个函数副本 + 1 处内联 SQL）

`db/utils/member-level.ts`、`fengyu-admin/src/cron/lib/member-level.ts`、staffApi/clientApi/payNotify 三份 `utils/member-level.js`（字节一致）、`db/scripts/recalc-all-customer-types.js` 的内联 SQL、`db/scripts/verify-member-level-cron.js`。调用点已全部按 `customer_type='会员客'` 门控，非会员客不会被误伤；`spending_tier` 与会员价资格（只看 customer_type）均解耦。

## 顺带修掉的缺陷（R1）
`processDowngrade` 也会写 `member_level_upgraded_at`，而「等级未变」分支靠「近 36h 内升级过」给会员**补发升级礼包**。此前降档终点是 NULL、被 `if (newLevel && …)` 短路；下限改初钻后降档终点是真值，**次日 cron 会给刚被降档的会员补发「恭喜升级到初钻」的消息/积分/券**。同类问题在 黑钻→金钻 这类非空降档上早已存在。

修法：`shouldRetryUnchangedUpgradeBenefits` 增加「上次跃迁是降档（`old_member_level` 高于现值）则跳过」守卫，并补回归用例。

## 评审轮修掉的缺陷（P1）：两条退款通道的阈值可用性语义相反

PR 前的三视角扫描发现：`customer_type` 重算在「会员门槛配置不可用」时，各通道行为不一致，而两条**退款**通道恰好是相反的两个方向。

- admin `recomputeCustomerTypeOnRefund`：`getCustomerTypeThreshold` 抛 `CUSTOMER_TYPE_THRESHOLD_UNAVAILABLE` 被捕获 → `return null` → 退款成功但**静默放弃本次降档**。退款是唯一降档通道，这次机会一过，顾客会带着会员客身份长期停留。
- staffApi `recalcCustomerType`：走 `utils/config.js` 的 `getMemberThreshold`，该函数**从不抛错**，配置缺失/非法时兜底 `FALLBACK_THRESHOLD`（硬编码 1980）→ 用与真实门槛无关的数重算并**写出不可逆的错误降档**（降档会立刻收走会员价与权益）。

修法：新增 `getMemberThresholdStrict()`（缺失/非法/查询失败一律抛错，不兜底），`recalcCustomerType` 在 `allowDowngrade` 分支改用它，捕获后跳过本次分类重算、不阻断退款审批本身 —— 与 admin 侧同语义。两端注释都写着「与对方保持一致」，此前与实现不符。

方向取舍：**漏降**优于**错降**。兜底阈值在只升不降的收款链路上无害（最坏漏升，次日 cron 会用正确阈值纠正），但在唯一放行降档的退款通道上方向不可控，故取 fail-closed。

## 生产数据现状（2026-10-06 实测）

- 5 位被降级的真实顾客（另有 1 位甲方测试账号「谢廷(测试)」）其达标单 `is_membership_upgrade` **全部为已退款**、存活达标单数为 0，**无一例由口径修正造成**。按退款例外，他们全部保持非会员客 —— 本单不产生 `customer_type` 行变更，规则只在将来生效。
- **401 位会员客** `member_level` 为 NULL：301 人近 12 月净消费为 0、69 人在 (0,1000)、31 人在 [1000,1990)，需补初钻。
- 非会员客 3764 人等级全为 NULL，本次不变。

## 相关文件

- `db/scripts/recalc-all-customer-types.js` — 离线全量分类 + 等级/入会时间补空
- `fengyu-admin/src/cron/steps/refresh-customer-types.ts` / `refresh-member-levels.ts` — 每日 STEP
- `fengyu-admin/src/lib/recompute-customer-tags.ts` — 单顾客重算（历史审核 / 退款）
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js` — 退款审批即时重算
- `fengyu-admin/src/actions/refunds.ts` — admin 退款审批即时重算
- `db/utils/member-level.ts` 及 4 份副本 — 等级判定权威与镜像

## 相关变更记录

- arch/013 — 服务单人员口径变更（同为跨端口径反转，含副本清单范式）
- `db/rollout/prod.md` — 生产数据回补执行登记
