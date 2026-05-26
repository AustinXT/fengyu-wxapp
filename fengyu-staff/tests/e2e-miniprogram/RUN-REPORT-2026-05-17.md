# L3 miniprogram 全套首跑报告（2026-05-17）

跑法：`bun fengyu-staff/tests/e2e-miniprogram/run-all.mjs`，IDE 装载 staff 项目（appId `wxe3f5d9ee6a94d22d`），9420 ws server 就绪。

## 结果

| # | smoke | 结果 | 备注 |
|---|-------|------|------|
| 1 | smoke-staff-allocation-save | ✅ PASS | 跑在 confirm-offline 之前；cleanup 链还没受污染 |
| 2 | smoke-staff-appt-to-service | ✅ PASS | 同上 |
| 3 | smoke-staff-confirm-offline | ✅ PASS | 测试本身 PASS，**但 finally 中 cleanup 静默失败，留下 orphan**（详见下方 Issue A） |
| 4 | smoke-staff-conversion-order | ❌ FAIL | cleanup 抛错 |
| 5 | smoke-staff-create-sales-order | ❌ FAIL | cleanup 抛错 |
| 6 | smoke-staff-customer-360 | ❌ FAIL | cleanup 抛错 |
| 7 | smoke-staff-login-tab | ❌ FAIL | cleanup 抛错 |
| 8 | smoke-staff-refund-approve | ❌ FAIL | cleanup 抛错 |
| 9 | smoke-staff-service-lifecycle | ❌ FAIL | cleanup 抛错 |
| 10 | smoke-staff-workbench-render | ❌ FAIL | cleanup 抛错 |

**3 PASS / 7 FAIL**。7 FAIL 同一根因，单点修复后预计全 PASS。

---

## Issue A — L3 cleanupL3TestData 缺 point_transactions 删除（致命，阻断 70%）

**复现链**：
1. smoke-staff-confirm-offline 测试 PASS：
   - fixture 写 sale_order(待支付) + sale_item
   - 调 order.confirmOffline → 转 '已支付' + INSERT point_transactions(ref_order_id=该 sale_order)
2. confirm-offline 的 `finally` 调 cleanupL3TestData()：
   - cleanup 顺序：sale_allocations → sale_order_payments → card_transactions → sale_items → **sale_orders**
   - **缺少 point_transactions DELETE** → sale_orders DELETE 撞 FK `point_transactions_ref_order_id_fkey` → 抛错
   - confirm-offline 的 finally 包了 try/catch，仅 warn，smoke 仍 PASS
   - **残留状态**：sale_orders + sale_items + point_transactions 留在库里
3. 下一个 smoke 启动 → `await cleanupL3TestData()`（**没有 try/catch 包装**）撞同样 FK → 抛错 → smoke FAIL
4. 之后所有 7 个 smoke 全部 FAIL（每次启动 cleanup 都撞同样 FK）

**报错原文**：
```
error: update or delete on table "sale_orders" violates foreign key constraint
  "point_transactions_ref_order_id_fkey" on table "point_transactions"
```

**修复方案**（`fengyu-staff/tests/e2e-miniprogram/helpers/fixtures.mjs`）：

在 `cleanupL3TestData` 内，**在 sale_orders DELETE 之前**插入：

```js
// point_transactions（confirmOffline / approveRefund 副作用）
await query(
  `DELETE FROM point_transactions
     WHERE ref_order_id LIKE $1
        OR user_id LIKE $2`,
  [`${TEST_ORDER_PREFIX}%`, `${NAMESPACE}%`],
);
```

同时把 sale_orders 的 DELETE 扩展为按 client_user_id / opened_by 兜底（因为 order.create 生成的 sale_order_id 是 `FY-XSD-WX-{YYMMDD}{4}` 格式，不带 L3 命名空间前缀，会漂出 LIKE 范围）：

```js
await query(
  `DELETE FROM sale_orders
     WHERE sale_order_id LIKE $1
        OR client_user_id LIKE $2
        OR opened_by LIKE $2`,
  [`${TEST_ORDER_PREFIX}%`, `${NAMESPACE}%`],
);
```

L2 fixtures.mjs 已有同样的兜底逻辑（参考 `cleanupTestData`），可借鉴。

---

## Issue B — 个别 smoke 的启动 cleanup 未包 try/catch（半致命）

L3 smoke 模板有两类：
- `smoke-staff-confirm-offline.mjs`：`run()` 内调 `await cleanupL3TestData()`，**finally 中也调一次**，且 finally 的调用包了 try/catch
- 新写的 9 个 smoke：仅在 `run()` 开头调 `await cleanupL3TestData()`，**没有 try/catch**

**影响**：哪怕 Issue A 修了，未来又出现新的 FK 问题，整套 smoke 又会全 FAIL。

**修复**：把 start-cleanup 也包 try/catch，至少 warn 不阻断：
```js
try { await cleanupL3TestData(); } catch (e) { console.warn('[cleanup-start]', e.message); }
```
或者：把 cleanupL3TestData 自身改为 try/catch 每条 DELETE（与 L2 `cleanupTestData` 一致），从根本上不再 throw。

---

## Issue C — 部分新 smoke 的 UI 断言过浅（设计问题）

只验证 `currentPage().path` 和 setData keys，没真正点 UI、没穿过云函数。如：
- smoke-staff-allocation-save：navigate 到页面后断言 `page.path` 包含路径就 PASS — 没点 "智能分配"、没保存、没 PG 校验
- smoke-staff-refund-approve：同上
- smoke-staff-service-lifecycle：仅验证 Tab 切换不崩，service start/complete 路径完全没覆盖（part 因为已知 prod bug）

**影响**：这些 smoke 的"PASS"信号很弱，回归保护薄。

**修复优先级**：低。L2 已经覆盖了对应 action 的写路径；L3 价值在 UI 路径，但完整 UI tap 需要 `tapByText` helper 更鲁棒（当前实现遍历所有 view/button/text，慢且脆）。建议未来按 link-N 风格（参考 admin manual-e2e）补全 UI tap。

---

## Issue D — IDE 切换破坏用户会话（基建问题）

跑 L3 必须 IDE 装 staff 项目，但用户日常可能装 client。run-all.mjs 当前的 SKIP 策略合理（不自动切换），但**切换流程是 cli quit + pkill + cli auto**，会丢失用户 IDE 当前的调试上下文。

**当前体验**：用户改 client 端代码 → 想验证 staff 不受影响 → 必须手动切 IDE → 跑完再切回来。心智成本高。

**潜在改进**：
- 提供 `tests/run-staff-l3.sh` 一键脚本（自动切 IDE → 跑 run-all → 切回原项目）
- 或：双 IDE 实例（不同 user-data-dir + 不同端口），互不影响

**修复优先级**：中等。日常单 smoke 用 `bun smoke-staff-X.mjs` 可以接受手动切；CI 化或频繁回归才需要。

---

## 操作历史

- 跑前 IDE 装的是 client（appId wx811eb4ded3dfba3f）→ 10 全 SKIP
- 切到 staff（quit + pkill + cli auto staff/miniprogram --port 9420，等 IPv6 listener）
- 跑全套 → 3 PASS / 7 FAIL（上述）
- 跑后切回 client（恢复用户原状）

---

## 推荐下次行动

1. **立即修 Issue A**（5 分钟）：补 point_transactions DELETE + sale_orders 兜底 → 预计 7→0 FAIL
2. **修 Issue B**（10 分钟）：start cleanup 包 try/catch
3. 重跑全套验证 10 PASS
4. 后续按 link-N 风格深化 UI 断言（中长期）
