# fengyu-staff e2e 全量跑批报告 — 2026-05-22

跑批范围：`fengyu-staff/tests/` 三层 e2e 全套。

## 结果总览

| 层 | 套件 | 结果 | 备注 |
|----|------|------|------|
| L2 | e2e-cloudfn（51 smoke） | ✅ **51/51 PASS** | 修复前 36/51；15 个失败全部因同一陈旧夹具 bug |
| L2 | scope-isolation（4 spec / 21 check） | ✅ **4/4 PASS** | 依赖 admin seed fixtures，已就位 |
| L3 | e2e-miniprogram scenarios（12） | ⚠️ **7/12 PASS**（首跑代表值） | 5 个失败为已知 spec/夹具/automator 不匹配 |

## 已直接修复（无需决策的明显 bug）

### 1. 陈旧枚举 `product_type='单品'`（migration 0050 已于 2026-05-21 移除该值）

`product_type` 枚举 2026-05-21 由 3 值收敛为 2 值（`疗程卡`/`家居产品`），`单品` 并入 `疗程卡`
（session_count=1）。但 e2e 夹具仍写入 `'单品'`，导致 PG `invalid input value for enum product_type: "单品"`。

**L2（15 个 smoke 全挂在此）**：把夹具 `productType` 值 `单品 → 疗程卡`
- `tests/e2e-cloudfn/helpers/fixtures.mjs`（createTestSaleOrder / createTestSaleItem 默认值）
- 10 个 smoke-*.mjs 的显式 `productType: '单品'`

**L3**：把 SQL `VALUES` 里的 `'单品'` 改为 `'疗程卡'`
- `scenarios/bs08-conversion-panel.spec.mjs`、`bs12-cross-store-deny.spec.mjs`、`bs01-order-flow.spec.mjs`
- `helpers/fixtures.mjs`

### 2. 退款可退数量为 0（连带 bug，因 #1 改动暴露）

`utils/refund.js:calculateUnusedQuantity` 对 `疗程卡` 取 `remaining_sessions`；夹具改成 `疗程卡` 后
未设 session_count → remaining_sessions=0 → `INVALID_STATE: 可退数量 0 不足 1`。
按 migration 语义（原单品=1 次卡）补 `session_count=1 / remaining_sessions=1`：
- `tests/e2e-cloudfn/smoke-order-refund.mjs`（已验证 PASS）
- `tests/e2e-miniprogram/helpers/fixtures.mjs` createTestPendingOfflineOrder（L3 bs02 用）

## 待决策（请统一处理，未改动）

均为 L3 scenarios 的 spec/夹具/UI 文案不匹配，与 `KNOWN-ISSUES-2026-05-17.md` 基本一致：

| 编号 | 失败点 | 性质 | 需要的决策 |
|------|--------|------|-----------|
| **bs01** | step3 加 SKU 时 automator 抛 `Function(...) is not a function`（Connection.js） | automator/tap 基建报错（categories 已能加载到 10，比基线前进） | 是否改 tap 实现 / 换 callMethod 绕过 Vant tap |
| **bs02** | login 偶发 `无权访问该门店`（可退数量 bug 已修） | 跨 spec globalData.currentStoreId 泄漏 | 是否在 login hook / 夹具强制对齐 currentStoreId=bound_store_id |
| **bs03** | tap `.van-button text="确认完成"` 未命中 | service-detail 真实按钮文案 ≠ spec | 确认真实文案后改 spec，或用 callMethod 绕过 |
| **bs05** | service-create `paidOrders=[]` 不含夹具单 | 夹具订单不符 loadPaidOrders 过滤条件 | 对齐 loadPaidOrders 过滤（状态/门店/可服务项） |
| **bs06** | 矩阵 2/12：`门店今日营收`/`分配列表` 在 manager workbench/profile 期望可见实际 0 | workbench/profile 真实文案 ≠ spec MATRIX | 贴齐真实 wxml 文案到 MATRIX |

### L3 跑批不稳定性（环境，非测试代码 bug）

- 全套连跑两次结果不同（7/12 → 3/12）。第二次 **bs08 卡死 300s 触发 SIGKILL**，遗留 IDE
  globalData 污染后续 bs04/07/09 → `无权访问该门店`。
- 这正是 `KNOWN-ISSUES` 建议「修一条 → 单跑确认 → 再修下一条」、不要全跑等结果的原因。
- IDE automation 模式（IPv6 ws @9420）启动有偶然性，本次首启卡在仅 IPv4，clean 重启后才起 IPv6。

## 2026-05-23 跟进：5 个 L3 待决策项已按批准方案改完（待验证）

用户批准后，5 项已全部落代码（语法已校验通过），但**无法运行验证**——微信开发者工具
登录态过期（`需要重新登录 code 10` / cloud 调用 `access_token missing`），需用户在 IDE GUI
扫码重新登录后才能跑 L3。

| 编号 | 改动 | 文件 |
|------|------|------|
| bs01 | `callPage` 用 `new Function` 重建函数源码（mp 运行时禁 eval → `Function is not a function`），改用 automator 原生 `page.callMethod/setData/data`（同 bs04） | `scenarios/bs01-order-flow.spec.mjs` |
| bs02 | 退款夹具补 `session_count=1`（疗程卡可退数量取 remaining_sessions） | `helpers/fixtures.mjs` `createTestPendingOfflineOrder` |
| bs03 | `确认完成` van-button slot 文字 automator 读不到，改 `callMethod('onCompleteService', {dataset.id})` | `scenarios/bs03-service-lifecycle.spec.mjs` |
| bs05 | 夹具补 `paid_sessions=5`（loadPaidOrders 可消费次数=min(remaining, paid-used)，paid=0 被全过滤） | `scenarios/bs05-appt-to-service.spec.mjs` |
| bs06 | ①MATRIX 文案 `分配列表→营业额分配`（真实 van-cell title）；②可见性 setData 补 `loading:false`（主体在 `<block wx:else>` 内，loading=true 时不渲染） | `scenarios/bs06-role-visibility.spec.mjs` |

**bs01 验证进展**：callMethod 改造已让它越过原 `Function is not a function`，跑到真正的 cloud
调用才被 `access_token missing` 拦住——证明改造方向正确，待 IDE 重新登录后复跑确认。

### 2026-05-23 IDE 重新登录后复跑结果

cloud auth 恢复（bs10 canary PASS）。5 项逐个单跑：

| 编号 | 我改的失败点 | 验证 | 复跑后新状态 |
|------|------------|------|-------------|
| **bs06** | 文案 + loading 渲染 | ✅ **PASS 12/12** | 完全通过 |
| **bs01** | callMethod 改造 | ✅ 已验证（复跑过 step3/4/5 全用 callMethod） | 推进到 step6「搜索选顾客」waitForData 超时（新下游问题） |
| **bs03** | callMethod onCompleteService | ✅ 已验证（首跑完整跑完 start→complete，remaining 5→4 + tab 迁移全 ✓） | 推进到 step4「navigate customer-detail」automator 超时（新下游） |
| **bs02** | 夹具 session_count=1 | ✅ 已验证（退款创建成功、越过「可退数量」bug、refund-list 含待审批） | 推进到 step4 refund-detail 契约不符（已知 KNOWN-ISSUE，非本批） |
| **bs05** | 夹具 paid_sessions=5 | ⚠️ 未能触达 | step1「navigate appointment-detail」**确定性**超时（2 次复现，已知 KNOWN-ISSUE），跑不到我改的 step3 |

**结论**：5 项里 4 项（bs01/bs02/bs03/bs06）的目标失败点已修复并验证；bs05 的修复方案
（与 bs02 同构，按 migration 语义补 paid_sessions）正确，但因 step1 appointment-detail 导航确定性
超时跑不到。bs01/bs02/bs03 修好后各自推进到了**新的下游失败点**（超出本批 5 项），其中 bs02 step4
是早有记录的 refund-detail 契约问题。

**L3 环境仍偶发不稳定**：bs01 的 `categories` 两次复跑 0/10 漂移、bs03 失败点在 step1↔step4 间漂移。

> 复跑：`bun fengyu-staff/tests/e2e-miniprogram/run-scenarios.mjs --filter bs06`（稳定 PASS）；
> 其余单跑偶发受 IDE/automator 导航超时影响。

### 新浮现的下游失败点（超出本批 5 项，待你定夺是否继续）

- bs01 step6：`onSearchCustomer` 后 `customerInfo.id` 未等到（顾客搜索结果/契约）
- bs02 step4：refund-detail 传 `saleOrderId` 但后端 schema 是 `paymentId`（已知）
- bs03 step4：navigate customer-detail automator 超时（疑似页面 onLoad 卡）
- bs05 step1：navigate appointment-detail 确定性超时（已知，疑似页面 onLoad 云函数卡/弹窗）

## 环境说明

- DB：`5434/fengyu`（开发库），L2=`TE2L2_*`、L3=`TEST_E2E_L3_*`、scope=`FY-TEST-*` 命名空间隔离
- 跑 L3 时把微信开发者工具切到了 staff 项目的 automation 模式（端口 9420），跑批结束后 IDE 仍在该状态。
