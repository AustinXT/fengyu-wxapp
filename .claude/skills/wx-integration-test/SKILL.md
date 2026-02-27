---
name: wx-integration-test
description: |
  微信小程序 + CloudBase 项目的端到端集成测试框架。通过 invokeFunction 编排
  云函数调用序列，覆盖完整业务链路，自动准备测试数据、执行测试、验证结果。
  当用户说"跑集成测试"、"测一下整个流程"、"验证端到端"时激活。
argument-hint: '[业务流程名称或 action 列表]'
user-invocable: true
metadata:
  author: nvoyager
  title: 微信小程序集成测试框架
  version: 1.0.1
  description_zh: 微信小程序 + CloudBase 项目通用端到端集成测试工作流
---

# 集成测试工作流

通用框架：按业务流程编排 invokeFunction 调用序列，验证多个云函数 API 之间的协作正确性。
适用于任何微信小程序 + CloudBase 项目。

## 何时使用

- 完成一组关联 API 开发后，需要验证完整业务链路
- 部署后回归测试核心业务流程
- 排查跨接口数据不一致问题
- 用户说"跑集成测试"、"测一下整个流程"、"端到端验证"

## 使用方法

```bash
/integration-test 用户注册→下单→支付全流程
/integration-test myCloudFn 订单模块全流程
/integration-test order.create → order.pay → order.complete
```

## 不适用

- 单个 API 冒烟测试（用 `implement-api` 的验证步骤或 `release-check`）
- 前端 UI 测试（用微信开发者工具手动测试）
- 线上问题排查（用 `debug-production`）

---

## Step 1: 确定测试范围

### 1.1 识别业务流程

从项目的路由文件和需求文档中识别核心业务流程。每个流程是一组按顺序串联的 action 调用。

**识别方法：**

1. **查看路由注册文件** -- 找到所有 action 定义，按模块分组
2. **查看需求文档** -- 识别用户故事中的操作序列
3. **查看数据库 schema** -- 识别状态流转字段（如 status enum），推导出状态机链路

**流程定义模板：**

```text
流程名称：[业务流程名称]
涉及云函数：[cloudFn1, cloudFn2, ...]
涉及 action 序列：[module1.method1] → [module1.method2] → [module2.method1]
关键验证点：[数据写入、状态流转、幂等性、权限控制 等]
```

**示例 -- 电商下单流（典型）：**

| 流程 | 涉及 action | 关键验证点 |
|------|------------|-----------|
| 用户下单流 | `auth.login` → `product.list` → `order.create` → `order.pay` | 订单创建、库存扣减、支付状态流转 |
| 订单履约流 | `order.ship` → `order.confirm` → `order.review` | 物流状态推进、评价写入 |
| 退款流 | `refund.apply` → `refund.approve` → `refund.complete` | 退款金额校验、库存回补、状态逆转 |

**示例 -- 预约服务流（典型）：**

| 流程 | 涉及 action | 关键验证点 |
|------|------------|-----------|
| 预约流 | `appointment.create` → `appointment.confirm` → `appointment.checkin` | 时间冲突检测、状态单向推进 |
| 服务流 | `service.create` → `service.start` → `service.complete` | 次数扣减、幂等完成 |

**示例 -- 内容社区流（典型）：**

| 流程 | 涉及 action | 关键验证点 |
|------|------------|-----------|
| 发布流 | `auth.login` → `post.create` → `post.publish` | 内容审核、发布状态 |
| 互动流 | `post.like` → `post.comment` → `notification.list` | 计数一致性、通知触发 |

### 1.2 确认测试环境

```text
目标环境：[ ] 开发环境  [ ] 生产环境（慎重）
云函数：[列出需要测试的云函数名称]
数据库状态：[ ] 已有测试数据  [ ] 需要初始化
```

> **envId 获取：** 从 `cloudbaserc.json` 或 `.claude/mcp.json` 中读取。

---

## Step 2: 准备测试数据

### 2.1 前置数据检查框架

集成测试依赖基础数据。按以下框架梳理并检查：

**梳理步骤：**

1. 从测试流程的第一个 action 出发，确认它需要的入参从何而来
2. 逐步追溯：哪些数据是前序 action 产生的，哪些需要预先存在
3. 将"需要预先存在"的数据整理为前置数据清单

**前置数据检查模板：**

| 数据类型 | 数据来源 | 检查方式 | 状态 |
|----------|----------|----------|------|
| 测试用户 | 用户表 | `auth.login` 返回成功 | [ ] |
| [业务基础数据1] | [数据库表/外部系统] | [调用某 action 返回非空] | [ ] |
| [业务基础数据2] | [数据库表/外部系统] | [调用某 action 返回非空] | [ ] |

**常见前置数据类型：**

- **认证数据** -- 测试用户账号（通过 `auth.login` 验证）
- **配置数据** -- 分类、标签、地区等系统配置
- **业务主数据** -- 商品、门店、员工等业务实体
- **外部系统数据** -- 第三方只读数据源（确认可访问即可）

### 2.2 前置数据初始化

如果缺少测试数据：

1. **使用种子数据工具**（如项目有 `seed-data` 技能）
2. **通过 API 创建** -- 调用相关 create action 生成测试数据
3. **直接写入数据库** -- 使用 SQL 或 ORM 工具插入

### 2.3 记录测试上下文

在执行测试序列前，记录关键 ID 以便后续步骤引用：

```text
测试上下文：
  userId: [从 auth.login 获取]
  [关键实体1 ID]: [从 xxx.list/xxx.create 获取]
  [关键实体2 ID]: [从 xxx.list/xxx.create 获取]
  ...
```

> **重要：** 每个测试步骤的输出 ID 会成为后续步骤的输入。务必记录所有跨步骤传递的数据。

---

## Step 3: 执行测试序列

### 3.1 invokeFunction 调用模板

每个测试步骤通过 CloudBase MCP 的 invokeFunction 工具执行：

```json
{
  "tool": "invokeFunction",
  "envId": "<ENV_ID>",
  "functionName": "<云函数名称>",
  "params": {
    "action": "module.method",
    "payload": { }
  }
}
```

> **约定：** 微信小程序 + CloudBase 项目通常使用 action 路由模式，
> 一个云函数内通过 `action` 字段分派到不同处理函数。
> 如果项目使用其他路由模式，请相应调整 `params` 结构。

### 3.2 测试序列编排原则

按以下原则将 action 编排为测试序列：

**原则一：按业务流程串联**

将同一业务流中的 action 按实际发生顺序排列，前一步的输出作为后一步的输入。

**原则二：一个序列测一条完整路径**

每个测试序列应覆盖一条从起点到终点的完整业务路径，不要将不同流程混在一起。

**原则三：先正向后异常**

先测试正常流程（happy path），再测试异常分支。

### 3.3 测试序列模板

```text
=== 测试序列：[流程名称] ===

[T1] <云函数名> <action> → 获取 <什么>
     payload: { ... }
     断言：code=0, <具体验证条件>
     记录：<需要传递给后续步骤的字段>

[T2] <云函数名> <action> → <做什么>
     payload: { <使用 T1 输出的字段> }
     断言：code=0, <具体验证条件>
     记录：<需要传递给后续步骤的字段>

[T3] <云函数名> <action> → <做什么>
     payload: { <使用 T1/T2 输出的字段> }
     断言：code=0, <具体验证条件>

... 直到流程终点 ...

[TN] 终态验证
     通过查询 action 确认最终数据状态符合预期
```

**编排示例 -- CRUD 资源生命周期：**

```text
=== 测试序列：资源 CRUD 生命周期 ===

[T1] myApi resource.create → 创建资源
     payload: { name: "测试资源", type: "typeA" }
     断言：code=0, 返回 resourceId
     记录：resourceId

[T2] myApi resource.detail → 查询刚创建的资源
     payload: { resourceId }（来自 T1）
     断言：code=0, name="测试资源", status="active"

[T3] myApi resource.update → 更新资源
     payload: { resourceId, name: "更新后的名称" }（resourceId 来自 T1）
     断言：code=0

[T4] myApi resource.detail → 验证更新生效
     payload: { resourceId }
     断言：code=0, name="更新后的名称"

[T5] myApi resource.delete → 删除资源
     payload: { resourceId }
     断言：code=0

[T6] myApi resource.detail → 验证已删除
     payload: { resourceId }
     断言：code 非 0 或返回空
```

**编排示例 -- 状态机流转：**

```text
=== 测试序列：订单状态机 ===

[T1] myApi order.create → 创建订单（状态：待支付）
     payload: { items: [...], amount: 100 }
     断言：code=0, status="pending"
     记录：orderId

[T2] myApi order.pay → 支付（状态：待支付 → 已支付）
     payload: { orderId, paymentMethod: "wechat" }
     断言：code=0, status="paid"

[T3] myApi order.ship → 发货（状态：已支付 → 已发货）
     payload: { orderId, trackingNo: "SF123456" }
     断言：code=0, status="shipped"

[T4] myApi order.confirm → 确认收货（状态：已发货 → 已完成）
     payload: { orderId }
     断言：code=0, status="completed"

[T5] myApi order.confirm → 重复确认（幂等性测试）
     payload: { orderId }
     断言：code=0（幂等通过），状态仍为"completed"
```

### 3.4 异常路径测试

在正向流程之后，针对以下类别编排异常测试：

```text
=== 异常路径 ===

[E1] 缺少必填参数
     action: <任意需要参数的 action>, payload: {}
     断言：返回参数校验错误（如 code=-400）

[E2] 权限不足
     用无权限的用户身份调用受限 action
     断言：返回权限错误（如 code=-403）

[E3] 唯一约束冲突
     重复创建同一资源（如重复下单、重复注册）
     断言：返回冲突错误，数据库无脏数据

[E4] 前置条件不满足
     跳过前序步骤直接调用后续 action（如未支付直接发货）
     断言：返回状态错误，拒绝操作

[E5] 幂等性验证
     对已完成的操作重复调用
     断言：幂等通过（返回成功但无副作用）或明确拒绝

[E6] 逆向状态变更
     尝试将资源回退到之前的状态（如已完成→已支付）
     断言：返回错误，拒绝逆向状态变更

[E7] 并发竞争（如适用）
     模拟同一资源被并发操作（如同时扣库存）
     断言：只有一个成功，或两者均正确处理
```

> **提示：** 异常路径的具体错误码取决于项目的错误处理约定。
> 测试前先查阅项目的错误码定义或云函数的错误处理模块。

---

## Step 4: 验证结果

### 4.1 逐步记录

每个测试步骤按以下格式记录结果：

```text
[PASS/FAIL] T1 module.method
  请求：{ action: "module.method", payload: { ... } }
  响应：{ code: 0, data: { ... } }
  耗时：xxxms
```

### 4.2 数据一致性验证

测试序列完成后，验证数据层面的正确性：

```text
数据一致性检查：
  [ ] 状态流转：每一步的状态变更符合预期（如 pending → paid → shipped → completed）
  [ ] 数量一致：涉及数量变更的字段正确增减（如库存、余额、次数）
  [ ] 关联数据：主表与关联表数据一致（如订单与订单明细、用户与角色）
  [ ] 幂等性：重复操作不产生副作用（不重复扣减、不重复创建）
  [ ] 时间戳：created_at / updated_at 等时间字段正确更新
```

**验证方法：**

1. 通过查询类 action（如 `xxx.detail`、`xxx.list`）读取最终状态
2. 如有数据库 MCP 工具，可直接查询数据库验证
3. 对比测试前后的数据快照

### 4.3 外部系统约束验证（如适用）

如果项目依赖外部数据源（如只读数据库、第三方 API），验证：

```text
外部系统约束：
  [ ] 所有外部查询均为只读操作（review 代码确认）
  [ ] 外部数据正确读取并映射到业务字段
  [ ] 外部系统不可用时有合理的降级/错误处理
```

---

## Step 5: 失败处理

### 5.1 测试失败分类

| 失败类型 | 症状 | 处理方式 |
|----------|------|----------|
| **参数错误** | 返回参数校验错误码 | 检查 payload 构造，对照路由文件确认参数名和类型 |
| **数据缺失** | 返回"未找到"类错误 | 补充前置数据（Step 2）|
| **状态不正确** | 返回状态校验错误 | 检查前序步骤是否成功执行，确认状态机定义 |
| **权限错误** | 返回 403 类错误 | 确认测试用户身份和权限配置 |
| **超时/网络错误** | 无响应或超时 | 检查云函数部署状态，查看云函数日志 |
| **未部署** | 函数不存在错误 | 部署云函数后重试（用 `cloudbase-deploy`）|
| **数据库错误** | 返回数据库错误信息 | 检查 schema 迁移状态、连接配置、SQL 语法 |

### 5.2 失败后恢复

测试中途失败可能产生脏数据（如半完成的订单、已扣减但未完成的库存）。处理策略：

1. **记录脏数据 ID** -- 记录失败时已创建的所有资源 ID
2. **从失败步骤重试** -- 修复问题后，从失败的步骤重新开始，不需要从头开始
3. **清理脏数据** -- 如果数据状态无法继续：
   - 通过 close/cancel/delete 类 action 清理
   - 或直接通过数据库工具删除测试数据
4. **重新初始化** -- 如果脏数据影响范围大，重新执行 Step 2 初始化测试数据

> **建议：** 为测试数据使用可识别的标记（如名称前缀 `[TEST]`），便于批量清理。

---

## Step 6: 输出测试报告

```text
=== 集成测试报告 ===

日期：YYYY-MM-DD
测试流程：[流程名称]
测试环境：[envId]
云函数：[cloudFn1, cloudFn2, ...]

测试结果：X/Y 通过

正向流程：
  [PASS] T1 auth.login — 登录成功
  [PASS] T2 resource.create — 资源创建成功，返回 resourceId
  [FAIL] T3 resource.update — code: -400, message: "INVALID_PARAMS: name is required"
    根因：payload 中缺少 name 字段
    修复建议：补充 name 参数后重试
  ...

异常路径：
  [PASS] E1 参数校验 — 空 payload 返回 -400
  [PASS] E2 权限校验 — 无权限用户返回 -403
  [SKIP] E3 唯一约束 — 前序步骤失败，跳过
  ...

数据一致性：
  [PASS] 状态流转正确
  [PASS] 数量增减正确
  [FAIL] 关联数据不一致 — 详细说明

覆盖率：
  - [云函数1] actions: X/Y 已测试
  - [云函数2] actions: X/Y 已测试
  - 核心业务流程: X/Y 已验证

后续建议：
  - [需要修复的问题]
  - [需要补充的测试]
  - [发现的潜在风险]
```
