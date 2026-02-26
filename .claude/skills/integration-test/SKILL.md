---
name: integration-test
description: |
  适用于端到端集成测试工作流。按业务流程编排 invokeFunction 调用序列，
  覆盖完整业务链路（下单流→服务流→疗程核销流），自动准备测试数据、
  执行测试、验证结果、清理数据。
  当用户说"跑集成测试"、"测一下整个流程"、"验证端到端"时激活。
argument-hint: '[业务流程名称或 action 列表]'
user-invocable: true
metadata:
  author: fengyu
  version: 1.0.0
  title: 集成测试
  description_zh: 按业务流程编排的端到端集成测试工作流
---

# 集成测试工作流

按业务流程编排 invokeFunction 调用序列，验证多个 API 之间的协作正确性。

## 何时使用

- 完成一组关联 API 开发后，需要验证完整业务链路
- 部署后回归测试核心业务流程
- 排查跨接口数据不一致问题
- 用户说"跑集成测试"、"测一下整个流程"、"端到端验证"

## 使用方法

```bash
/integration-test 下单流
/integration-test staffApi 订单+服务全流程
/integration-test appointment.create → appointment.confirm → appointment.checkin
```

## 不适用

- 单个 API 冒烟测试（用 `implement-api` 的 Step 6 或 `release-check` 的 Step 4）
- 前端 UI 测试（用微信开发者工具手动测试）
- 线上问题排查（用 `debug-production`）

---

## Step 1: 确定测试范围

### 1.1 选择业务流程

项目包含以下核心业务流程，每个流程由多个 action 按顺序串联：

| 流程 | 涉及 API | 关键验证点 |
|------|----------|-----------|
| **员工开单流** | `auth.login` → `store.list` → `product.categories` → `product.skuDetail` → `order.create` → `order.qrcode` | 订单写入 PG、序号生成、WorkFine 价格读取 |
| **顾客支付流** | `auth.login` → `order.list` → `order.confirmOffline` | 支付状态流转、幂等性、营业额自动分配 |
| **服务核销流** | `service.create` → `service.start` → `service.complete` | 疗程次数原子扣减、状态单向推进、幂等 |
| **预约流** | `appointment.list` → `appointment.confirm` → `appointment.checkin` | 状态流转、时间校验 |
| **顾客自助下单** | `auth.login` → `auth.bindPhone` → `product.categories` → `product.spuList` → `product.skuDetail` → `order.create` | 手机号绑定、待支付唯一约束 |
| **客户搜索流** | `customer.search` → `customer.calendar` | WorkFine 数据读取、脱敏 |

### 1.2 确认测试环境

```text
目标环境：[ ] 开发环境  [ ] 生产环境（慎重）
云函数：[ ] clientApi  [ ] staffApi  [ ] 两者
数据库状态：[ ] 已有测试数据  [ ] 需要初始化（用 seed-data）
```

> **注意：** envId 从 `cloudbaserc.json` 或 `.claude/mcp.json` 中获取。

---

## Step 2: 准备测试数据

### 2.1 检查前置数据

集成测试需要以下基础数据存在：

| 数据类型 | 来源 | 检查方式 |
|----------|------|----------|
| 门店列表 | WorkFine `UDT_M_219`（只读） | `store.list` 返回非空 |
| 员工列表 | WorkFine `UDT_S_287`（只读） | `staff.list` 返回非空 |
| 商品分类 | PG `product_spu` + WorkFine 价格 | `product.categories` 返回非空 |
| SKU 映射 | PG `product_spu_sku_map` | `product.skuDetail` 返回价格 |
| 测试用户 | PG `client_wechat_users` / `staff_wechat_users` | `auth.login` 成功 |

### 2.2 前置数据初始化

如果缺少 PG 侧测试数据，使用 `seed-data` 技能初始化：

```text
/seed-data 初始化测试数据
```

### 2.3 记录测试上下文

在执行测试序列前，记录关键 ID 以便后续步骤引用：

```text
测试上下文：
  storeId/storeName: [从 store.list 获取]
  staffWfId: [从 staff.list 获取]
  spuId: [从 product.categories 获取]
  skuId: [从 product.skuDetail 获取]
  clientUserId: [从 auth.login 获取]
```

---

## Step 3: 执行测试序列

### 3.1 通用调用模板

每个测试步骤使用 invokeFunction MCP 工具：

```json
{
  "tool": "invokeFunction",
  "envId": "<ENV_ID>",
  "functionName": "staffApi 或 clientApi",
  "params": {
    "action": "module.method",
    "payload": { /* 参数 */ }
  }
}
```

### 3.2 员工开单 + 服务核销全流程

这是最核心的业务链路，覆盖从开单到服务完成的完整生命周期：

```text
=== 测试序列：员工开单 + 服务核销 ===

[T1] staffApi auth.login → 获取 staffUserId
     断言：code=0, 返回员工信息

[T2] staffApi store.list → 获取 storeName, marketName
     断言：code=0, 列表非空

[T3] staffApi product.categories → 获取可用分类
     payload: { storeId }
     断言：code=0, 分类非空

[T4] staffApi product.skuDetail → 获取 SKU 价格和次数
     payload: { spuId }（从 T3 选取）
     断言：code=0, 返回 price/sessionCount

[T5] staffApi order.create → 创建订单
     payload: {
       storeName, marketName,
       items: [{ skuId, quantity: 1, unitPrice, saleAmount, receivable, received }],
       clientPhone: "测试手机号",
       customerName: "测试顾客",
       paymentMethod: "offline",
       preferredStaffWfId: staffWfId
     }
     断言：code=0, 返回 orderNo
     记录：orderNo, itemFlowNo

[T6] staffApi order.confirmOffline → 确认线下收款
     payload: { orderNo }
     断言：code=0, 订单状态变为"已支付"

[T7] staffApi service.create → 创建护理单
     payload: {
       storeName, marketName,
       assignedStaffWfId: staffWfId,
       items: [{ itemFlowNo, skuId, sessionUsed: 1, employeeId: staffWfId }],
       clientUserId（如有）
     }
     断言：code=0, 返回 serviceOrderNo

[T8] staffApi service.start → 开始服务
     payload: { serviceOrderNo }
     断言：code=0, 状态变为"服务中"

[T9] staffApi service.complete → 完成服务
     payload: { serviceOrderNo }
     断言：code=0, 状态变为"已完成"
     验证：remainingSessions 已扣减

[T10] staffApi service.complete → 重复完成（幂等测试）
      payload: { serviceOrderNo }
      断言：code=0（幂等），次数不重复扣减
```

### 3.3 预约流测试序列

```text
=== 测试序列：预约流 ===

[T1] staffApi appointment.list → 查询现有预约
     payload: { storeId }
     断言：code=0

[T2] clientApi 创建预约（如有此 action）
     断言：code=0, 返回 appointmentId

[T3] staffApi appointment.confirm → 确认预约
     payload: { appointmentId }
     断言：code=0, 状态变为"已确认"

[T4] staffApi appointment.checkin → 签到
     payload: { appointmentId }
     断言：code=0, 状态变为"已完成"
```

### 3.4 异常路径测试

在正向流程之后，测试关键异常路径：

```text
=== 异常路径 ===

[E1] 缺少必填参数
     action: order.create, payload: {}
     断言：code=-400

[E2] 权限不足（非店长操作店长接口）
     断言：code=-403

[E3] 重复创建待支付订单（唯一约束）
     断言：code 非 0，返回明确错误消息

[E4] 疗程次数不足时核销
     断言：code 非 0，remainingSessions 未变

[E5] 已完成订单尝试再次确认收款（幂等/状态机）
     断言：code=0（幂等通过）或明确拒绝

[E6] 已关闭订单尝试操作
     断言：code 非 0，拒绝逆向状态变更
```

---

## Step 4: 验证结果

### 4.1 逐步记录

每个测试步骤记录：

```text
[PASS/FAIL] T1 auth.login
  请求：{ action: "auth.login", payload: {} }
  响应：{ code: 0, data: { userId: "xxx" } }
  耗时：xxxms
```

### 4.2 数据一致性验证

测试序列完成后，通过查询验证数据状态：

```text
数据一致性检查：
  [ ] 订单状态：待支付 → 已支付（T5→T6）
  [ ] 服务单状态：待服务 → 服务中 → 已完成（T7→T8→T9）
  [ ] 疗程次数：sessionCount - sessionUsed = remainingSessions
  [ ] 营业额分配：preferredStaffWfId 已自动创建分配记录
  [ ] 幂等性：重复操作不产生副作用
```

### 4.3 WorkFine 约束验证

```text
WorkFine 约束：
  [ ] 所有 WorkFine 查询均为 SELECT（review 代码确认）
  [ ] 价格数据正确从 WorkFine 读取（与 product.skuDetail 返回一致）
  [ ] 员工/门店数据与 WorkFine 一致
```

---

## Step 5: 失败处理

### 5.1 测试失败分类

| 失败类型 | 处理方式 |
|----------|----------|
| **参数错误** | 检查 payload 构造，对照路由文件确认参数名 |
| **数据缺失** | 用 `seed-data` 补充前置数据 |
| **状态不正确** | 检查前序步骤是否成功执行 |
| **超时** | 用 `debug-production` 查看云函数日志 |
| **未部署** | 用 `cloudbase-deploy` 重新部署 |

### 5.2 失败后恢复

如果测试中途失败，可能产生脏数据（如半完成的订单）。处理策略：

1. **记录脏数据 ID**（orderNo、serviceOrderNo 等）
2. 修复问题后，**从失败步骤重新开始**，不需要重头开始
3. 如果数据状态无法继续，使用 `order.close` 关闭脏订单后重新创建

---

## Step 6: 输出测试报告

```text
=== 集成测试报告 ===

日期：YYYY-MM-DD
测试流程：[流程名称]
测试环境：[envId]

测试结果：X/Y 通过

通过项：
  [PASS] T1 auth.login — 登录成功
  [PASS] T2 store.list — 返回 3 家门店
  ...

失败项：
  [FAIL] T5 order.create — code: -400, message: "INVALID_PARAMS: skuId is required"
    根因：payload 中 skuId 字段名不匹配
    修复：将 sku_id 改为 skuId

数据一致性：
  [PASS] 订单状态流转正确
  [PASS] 疗程次数扣减正确
  [FAIL] 营业额分配缺失 — 需排查 order.confirmOffline 逻辑

异常路径：
  [PASS] E1 参数校验 — 返回 -400
  [PASS] E2 权限校验 — 返回 -403
  [SKIP] E3 重复订单 — 前序步骤失败，跳过

覆盖率：
  - clientApi actions: X/Y 已测试
  - staffApi actions: X/Y 已测试
  - 核心业务流程: X/Y 已验证

后续建议：
  - [需要修复的问题]
  - [需要补充的测试]
```
