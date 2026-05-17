# L3 业务场景 E2E — 已知问题（基线 2026-05-17）

> 完整跑一次 `./fengyu-staff/tests/run-staff-l3.sh --scenarios` 后固化的状态。
>
> **最终：4/9 PASS, 5/9 FAIL**（2026-05-17 BS-04 修复扩 login hook 后，BS-07/BS-09 跟着活）。
>
> 每个失败都有具体的 page-internal 数据字段名 / 文案 / 路由权限不匹配 — 不是基建坏了，是 spec 假设
> 跟实际页面/接口对不上。逐条修正本文档里的"修正指引"即可对应解锁。

## 当前 PASS / FAIL 矩阵

| Spec | 状态 | 失败点（一句话） |
|---|---|---|
| bs01-order-flow | FAIL | step2: order-create 普通商品 Tab `categories=[]`（shopInit EXISTS 过滤） |
| bs02-refund-approve | FAIL | step4: refund-detail waitForData 超时（saleOrderId vs paymentId 接口契约 mismatch） |
| bs03-service-lifecycle | FAIL | step3: tap `.van-button text=确认完成` 未命中（真实文案/选择器不对） |
| **bs04-allocation** | **PASS ✓** | 2026-05-17 修复，详见下方"BS-04 修复纪要" |
| bs05-appt-to-service | FAIL | step3: service-create `paidOrders=[]`（fixture 订单不符 loadPaidOrders 过滤） |
| bs06-role-visibility | FAIL | manager workbench 4 条文案断言均 0 匹配（wxml 真实文案 ≠ spec MATRIX） |
| **bs07-customer-assign** | **PASS ✓** | 2026-05-17 跟 BS-04 hook 修复一起活 |
| **bs08-conversion-panel** | **PASS ✓** | — |
| **bs09-card-recharge** | **PASS ✓** | 2026-05-17 跟 BS-04 hook 修复一起活 |

---

## 基建已就位（不需要再动）

- `helpers/automator.mjs` — `tap / tapByText / waitForData / navigateToTab / assertElement{Visible,Hidden}`
- `helpers/toast.mjs` — `installToastHook / assertToast / clearToasts / autoConfirmModal`
- `helpers/login.mjs` — `loginStaffWithTestOpenid` + 全局 `wx.cloud.callFunction` hook 自动注入 `_testOpenid`（**关键**：让页面内部 `callStaffApi` 也走对的 scope）
- `helpers/screenshot.mjs` — `snapshot / dumpRecentSnapshots / resetSnapshots`
- `helpers/pg.mjs` — `pgPoll` 异步副作用轮询
- `helpers/fixtures.mjs` — `cleanupL3TestData` 三趟 + 自防御（FK 依赖图全闭合）
- `run-scenarios.mjs` — 独立 runner，已加 **5 分钟 per-spec 看门狗**（防 `finally { await disconnect/closePool }` 死锁，下次再卡可自动 SIGKILL）
- `run-staff-l3.sh --scenarios` — 一键脚本，自动切 staff appid + 重启 IDE + 跑 scenarios

---

## 失败原因 + 修正指引

### BS-01 order-flow — shopInit 默认 kind categories=[]
- **现象**：`step2_assertDefaultKind` 断言 `data.categories.length ≥ 1` 失败
- **根因**：staffApi `product.shopInit` 用 `EXISTS (SELECT 1 FROM product_skus WHERE ...)` 过滤分类，L3 fixture 建的"测试品类"下 SKU 可能没满足 EXISTS 条件（如 `is_on_sale=false` / 有效期外）
- **修正指引**：检查 `fengyu-staff/cloudfunctions/staffApi/routes/product.js` 的 `shopInit` SQL → 把 fixture builder（`createTestProduct` / `createTestSku`）对齐 EXISTS 必要字段

### BS-02 refund-approve — refund-list waitForData 超时
- **现象**：店长在 refund-list 等 `data.list` 含 fixture refund 8s 超时
- **根因**：spec 监听字段名跟页面 `data.list` 实际字段不一致，**或** `order.createRefund` 接口走完后 `pendingRefunds` 列表 cache 未刷新
- **修正指引**：先 `evaluate(() => getCurrentPages().slice(-1)[0].data)` 抓 refund-list 实际 data shape，对齐 spec 的 waitForData 谓词

### BS-03 service-lifecycle — `确认完成` 按钮找不到
- **现象**：`tap('.van-button', text='确认完成')` 在 service-detail 不命中
- **根因**：service-detail wxml 真实按钮文案可能是"完成服务" / "结束" / 用图标而非文字
- **修正指引**：Read `fengyu-staff/miniprogram/pages*/service-detail/service-detail.wxml` 看真实按钮 → 对应改 spec text 参数；或直接 `page.callMethod('onCompleteService')` 绕过 UI tap

### BS-04 allocation — ✓ PASS（2026-05-17 修复）
见下方"BS-04 修复纪要"。

### BS-05 appt-to-service — ws timeout @ step1
- **现象**：跟 BS-04 同款 ws timeout，发生在 navigateTo appointment-detail 后
- **根因**：appointment-detail `onLoad` 里某个云函数报错抛 modal/dialog（之前讨论过 alert 会冻结 ws），或者拿 `options.id` 跟 spec 传参方式（已用 `?id=`）不匹配导致页面 404 + 抛错
- **修正指引**：用 chrome devtools / `mp.evaluate(() => getCurrentPages().slice(-1)[0].route)` 看到底跳到哪个页面，对齐 URL 参数名

### BS-06 role-visibility — 14 条矩阵失败 4 条
- **现象**：以下 4 条 manager 端 workbench 文案断言"期望可见，实际 0 匹配"：
  - `门店今日营收` / `待确认收款` / `待审批退款` / `待审批解绑申请`
- **根因**：workbench.wxml 实际文案跟 spec 假设不一致（如"今日营收"vs"门店今日营收"），或显示 `block wx:if` 因为 fixture 没造数据导致整块未渲染
- **修正指引**：Read `fengyu-staff/miniprogram/pages/workbench/workbench.wxml` → 把 MATRIX 14 条文本贴齐实际文案
- **附加发现**：登录 hook 已正确 → `roles=["manager","admin"] staffLevel=headquarters`，scope/权限链路通

### BS-07 customer-assign — 无权访问该门店
- **现象**：assign 调用 `customer.assign` 返回 toast `"无权访问该门店"`
- **根因**：spec 用 globalData hack 把 `staffLevel='store_manager'` 改了，但后端 `customer.assign` 重新查 PG `staff_wechat_users.current_store_id` → fixture manager 的 `current_store_id` / `bound_store_id` 没设置或不等于目标顾客的 `bound_store_id`
- **修正指引**：fixture builder 写入 manager 时确保 `current_store_id = bound_store_id = 顾客的 bound_store_id`

### BS-09 card-recharge — tiers 为空
- **现象**：card-recharge 页 `data.tiers.length === 0`
- **根因**：staffApi 充值卡 SKU 路由（可能是 `product.skuList` 用 `is_recharge_card=true` 过滤）查不到 fixture 写入的卡 SKU，可能 `is_recharge_card` 列未置 true
- **修正指引**：fixture `createTestRechargeSku` 显式 `is_recharge_card=true` + `is_on_sale=true` + 有效期内；或直接读 `mall_product_skus.is_recharge_card` 真实列名

---

## BS-04 修复纪要（2026-05-17）

修复路径上踩到 3 个独立 bug，逐层穿透：

1. **L3 测试基建：login hook 没注入 scope 切换字段**
   - `helpers/login.mjs`：扩 `loginStaffWithTestOpenid(mp, openid, currentStoreId)` 第三参数；hook 内同时注入 `_currentStoreId / _loginLevel` 到 staffApi 调用
   - 副作用：`utils/cloud.ts` 会从 `app.globalData.currentStoreId` 注入 payload，IDE 真账号的 globalData 会让所有 fixture 用户调用都 throw `无权访问该门店`。修这一条对所有 fixture-driven L3 spec 都受益（BS-02 / BS-07 / BS-09 可能跟着活）。

2. **L3 测试基建：spec 字段名错配 + 兜底缺失**
   - `scenarios/bs04-allocation.spec.mjs`：
     - step 4 监听 `displayItems[*].allocLines`（不是 `items` — items 是原始 OrderItem）
     - step 1 加 globalData 兜底（staffWfId / scopedStores / boundStoreName），防 `workbench.onShow` 触发 reLaunch 到 login
     - step 5 跳过 picker 时手动 setData 写入 `allocationRatio=1.00`（suggest 后端不填 ratio，UI 设计意图是用户用 picker 选 10%-100%）
     - step 6 加 `autoConfirmModal` 兜底 + allocLines 诊断打印

3. **🚨 生产前端 bug（线上"保存分配方案"等价于"标记无需分配"）**
   - 文件：`fengyu-staff/miniprogram/packageOrder/revenue-allocation/revenue-allocation.ts:424` `onSave()`
   - 旧代码：`if (l.staffWfId && l.department)` 校验 `l.department`
   - 实际：P2-14 PR 之后 `department/departmentName` 已 deprecated，`allocation.suggest` 后端 `routes/allocation.js:462` 明确 `departmentName: null`。`roleType` 才是身份载体
   - 后果：suggest 自动填的 allocLine 永远 `department=undefined` → effectiveLines 永远为空 → 永远走 `onSkipAllocation` → 弹 modal → toast `已标记为无需分配`
   - 修复：校验改为 `l.staffWfId && l.roleType`；payload 映射 `departmentName: line.department || null`
   - 影响范围：上线后所有店长在"营业额分配"页面点"保存"实际上都被静默转成"无需分配"，sale_allocations 表零写入。需 PM/QA 回归确认线上数据有无遗漏

## L3 跑过程中顺带发现的 5 个生产 bug（独立于 spec 修正）

1. **`miniprogram/pages*/customer-list/customer-list.ts:207`** — `staff.list` 返回 `{staffList:[...]}` 但前端当数组用 → 长按"客户分配" employee picker 永远空
2. **`miniprogram/packageOrder/refund-list/refund-list.wxml`** — `data-id` 用 `sale_order_id` 但 detail 页要 `ref_sale_order_id`
3. **`miniprogram/packageOrder/refund-detail/refund-detail.ts`** — 传 `saleOrderId` 给 `order.refundDetail`，但后端 schema 是 `paymentId`
4. **`cloudfunctions/staffApi/routes/service.js:207`** —（已知）`INSERT INTO service_items` 列里有 `sku_id`，但 `db/schema/service.ts` 的 `service_items` 表无此列 → 服务单提交必抛 `column "sku_id" of relation "service_items" does not exist`
5. **`cloudfunctions/staffApi/routes/service.js:439`** —（已知）`ON CONFLICT ON CONSTRAINT` 跟 partial unique index 不兼容

---

## 复跑建议

```bash
# 单 spec 快速迭代（5 分钟看门狗，不会再卡死）
bun fengyu-staff/tests/e2e-miniprogram/run-scenarios.mjs --filter bs03

# 全部（约 3 分钟正常完成 / 最坏 45 分钟受看门狗硬限）
./fengyu-staff/tests/run-staff-l3.sh --scenarios
```

修一条 spec → 单跑确认 PASS → 再修下一条，不要全跑等结果。每修一条更新本文档"当前 PASS/FAIL 矩阵"那一行。
