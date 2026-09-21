# 凤御员工端小程序 — 系统架构规格书

> 仅记录代码中无法推断的架构决策和约束机制。目录结构、API 列表、DB schema 请直接读取代码。
> **依赖文档**: `real.md` v3.1.0 | `cog.md` v4.0.0 | `staff.pr.spec.md` v2.0.0 | `backend.pr.spec.md` v4.0.0

## 1. 架构拓扑

```text
┌─────────────────────────────────────────────┐
│     fengyu-staff 员工端小程序                │
│     appid: wxe3f5d9ee6a94d22d               │
│                                             │
│  ┌─ 主包 ─────────────────────────────────┐ │
│  │ login / workbench / order-create /     │ │
│  │ service / customer-list / profile      │ │
│  └────────────────────────────────────────┘ │
│  ┌─ 分包 ─────────────────────────────────┐ │
│  │ packageOrder / packageCustomer /       │ │
│  │ packageService                         │ │
│  └────────────────────────────────────────┘ │
│           │                                 │
│     wx.cloud.callFunction                   │
│           │                                 │
└───────────┼─────────────────────────────────┘
            ▼
┌─ CloudBase 环境 B ──────────────────────────┐
│  cloud1-9g3ydpg512eecc99                    │
│  ┌──────────┐                               │
│  │ staffApi  │                               │
│  │ (网关)    │                               │
│  └────┬─────┘                               │
└───────┼─────────────────────────────────────┘
        ▼
  PostgreSQL（自托管，共享）
```

**与顾客端的隔离**：
- 独立 CloudBase 环境，云函数互不可见
- 独立 appid → OPENID 互不兼容，`staff_wechat_users` 与 `client_wechat_users` 完全分离
- 唯一共享资源：PG 数据库（同一实例、同一 schema）

## 2. 架构决策

| 决策 | 理由 |
|------|------|
| 单函数多路由（staffApi action 网关） | 减少冷启动次数；员工端所有接口通过 staffApi 统一入口 |
| 云函数用原生 SQL（`pg` 库） | CloudBase 运行时不支持 TS，引入 Drizzle 增加包体积和冷启动时间 |
| 无购物车持久化（仅 Page 内存） | 员工端开单是单次操作流，页面销毁即清空；不需跨页面持久化 |
| devtools 打开 miniprogram/ 而非根目录 | project.config.json 在 miniprogram/ 内，`miniprogramRoot` 未设置 |
| 5 Tab 设计（含开单/护理/顾客独立 Tab） | 高频操作提升为独立 Tab；消息中心归 P2，数据中心移至管理后台 |
| 权限前后端双校验 | 前端 `role-guard` 组件控制 UI 可见性；后端 middleware 拦截越权请求；前端仅做提示，不做安全保障 |
| Mock 模式 | `utils/dev-config.ts` 的 `MOCK_ENABLED` 开关，开发环境可脱离云函数调试 |
| 二维码生成在云端 | `utils/wxacode.js` 调用微信接口生成小程序码，含 orderNo 参数，顾客端扫码后直达支付页 |

## 3. 认证与权限模型

### 3.1 认证流程

```text
app.onLaunch()
  → restoreFromCache() 从 localStorage 恢复 globalData
  → syncLoginState() → auth.login（OPENID 自动注入）
    → 新用户：创建 staff_wechat_users（openid 填入）
    → 已有用户：返回完整信息 + permissions
  → 需手机号绑定（employee_id 为空）
    → getPhoneNumber(CloudID) → auth.bindPhone
    → 匹配 PG 中 phone → 合并行（填入 openid）
    → 返回员工档案 + 角色权限
```

### 3.2 RBAC + Scope 权限模型

**角色体系**（6 种 + 降级态）：

| 角色 | 职责 | 员工端典型操作 |
|------|------|---------------|
| `manager` | 经营管理 | 开单/确认收款/关单/营业额分配/审批解绑 |
| `finance` | 财务只读 | 查看订单/分配/报表 |
| `hr` | 员工管理 | 员工列表/权限分配 |
| `product` | 商品管理 | 商品 CRUD（管理后台为主） |
| `customer_mgr` | 顾客管理 | 顾客详情编辑（需叠加基础角色使用） |
| `staff` | 一线执行 | 仅操作自己的服务单/预约 |
| *无记录降级* | 最低权限 | 等同 `staff`，scope 为所属门店 |

**域级别**（3 层）：

| 级别 | 数据范围 | SQL 过滤 |
|------|---------|---------|
| `总部` | 全局无过滤 | 无 WHERE 限制 |
| `市场` | 市场下所有门店 | `WHERE store_id IN (市场子门店列表)` |
| `门店` | 单门店 | `WHERE store_id = ?` |

**一人多角色 + 一角色多域**：`permission_roles` 表每条 `(employee_id, role, scope_id)` 组合独立记录，登录时聚合所有角色和权限。

### 3.3 auth 上下文（ctx.auth）

登录时预解析，注入每次请求：

```text
ctx.auth = {
  userId, openid, phone, employeeId, position,
  storeName, marketName, departmentNodeId, departmentName,
  roles: [{ role, scope: { type, nodeId, nodeName, marketName } }, ...],
  scopeStoreIds: [],           // 预解析所有可访问门店
  permissions: { actions: [] },  // 扁平数组如 ['sale_order:create', ...]
  hasPermission(module, action),
  getMaxScope(),
  isManager(),
}
```

### 3.4 域过滤与行级过滤

**域过滤（buildScopeWhere）**：所有查询统一通过此函数生成 `store_id` 过滤条件。`scopeStoreIds` 登录时预解析，多域取并集。

**行级过滤（buildStaffFilter）**：仅 `staff` 角色追加行级限定：
- 服务单: `+ AND assigned_employee_id = ?`
- 预约: `+ AND employee_id = ?`
- 订单: `+ AND preferred_employee_id = ?`

管理角色（manager/finance/hr/customer_mgr）不追加行级过滤。

### 3.5 前端权限下发

```text
auth.login 返回:
  permissions: {
    roles: [{ role, scopeType, scopeName }],
    actions: ['sale_order:create', 'customer:search', ...]
  }
```

前端 `utils/role.ts` 提供判断方法，`components/role-guard` 组件控制 UI 可见性。

## 4. 前端状态管理

| 状态类型 | 存储位置 | 说明 |
|---------|---------|------|
| 认证信息 | `app.globalData` + localStorage | `restoreFromCache()` → `syncLoginState()` |
| 权限信息 | `app.globalData.permissions` | login 返回后写入，role-guard 读取 |
| 开单购物车 | Page 级 `data.cartItems` | 仅 order-create 页面内存，页面销毁即清空 |
| 门店绑定 | `app.globalData.boundStoreId` + localStorage | 切换门店需重新请求数据 |
| 服务单预加载 | `app.globalData._serviceCreatePreload` | 顾客详情勾选项目 → 传递到服务单创建页 |

**核心工具模块**：
- `utils/auth.ts` — 认证状态管理
- `utils/cloud.ts` — 云函数调用封装
- `utils/role.ts` — 角色判断工具
- `utils/dev-config.ts` — 开发配置 / Mock 开关
- `utils/mock-api.ts` — Mock 数据源
- `utils/realtime.ts` — 实时更新（日历推送等）

## 5. 云函数中间件链

```text
staffApi 请求处理流程：

event { action, payload }
  → index.js: 解析 action → require(`./routes/${module}`)
  → middleware/auth.js:
    → OPENID → 查 staff_wechat_users → employee_id
    → 查 permission_roles → 聚合角色/域/权限 → ctx.auth
    → 无 employee_id → UNAUTHORIZED（需绑定手机号）
    → （auth.login / auth.bindPhone 跳过完整认证）
  → middleware/validate.js: 参数校验
  → routes/[module].[method](payload, ctx)
    → 业务层调用 buildScopeWhere(ctx.auth) + buildStaffFilter(ctx.auth, column)
  → 响应: { code: 0, message, data } 或 { code: -1/-400/-401/-403, message }
```

**错误码体系**（9 项官方白名单，单源：`cloudfunctions/staffApi/utils/error-codes.js`）：
- `0` — 成功
- `-1` — 通用错误（非白名单前缀降级）
- `-400` — 参数错误 / 状态机阻塞 / 余额不足 / 顾客未注册（前缀 `INVALID_PARAMS:` / `INVALID_STATE:` / `INSUFFICIENT_BALANCE:` / `CLIENT_NOT_REGISTERED:`，**按 `errorType` 区分**）
- `-401` — 未认证（`UNAUTHORIZED:` 前缀）
- `-403` — 手机号未绑定 / 权限不足（`PHONE_REQUIRED:` 或 `PERMISSION_DENIED:`，**按 `errorType` 区分**）
- `-404` — 资源不存在（`NOT_FOUND:` 前缀）
- `-409` — 并发冲突（`CONFLICT:` 前缀）

跨端一致性由 `__tests__/routes/cross-end-error-codes-snapshot.test.js` snapshot 守护，任一端漂移立即报错。

## 6. 约束保障机制

| real.md 约束 | 员工端实现 |
|-------------|-----------|
| 次数防超卖 | `service.complete`: `UPDATE sale_items SET remaining_sessions = remaining_sessions - $n WHERE sale_item_id = $1 AND remaining_sessions >= $n`，rowCount=0 即次数不足 |
| 价格快照不可变 | `order.create` 时从 `product_skus.price` 快照到 `sale_items.unit_price`；后续不可 UPDATE 价格字段 |
| 支付幂等 | `order.confirmOffline`: `WHERE sale_order_id=$1 AND status='待确认收款'`，rowCount=0 跳过；`service.complete` 按 service_order_id 幂等 |
| 状态单向推进 | 所有状态变更 `WHERE status = $current_status`；唯一例外：`order.resetFailed`（支付失败→待支付） |
| 后端统一鉴权 | middleware/auth.js 从 OPENID → employee_id → permission_roles 聚合；PERMISSION_MATRIX 代码常量校验 `module:action`；前端 role-guard 仅做提示 |
| 组织域数据隔离 | `buildScopeWhere(ctx.auth)` 按 scopeStoreIds 过滤 + `buildStaffFilter` 行级限定 |
| 待支付订单唯一 | `order.create` 时 PG 部分唯一索引；未注册顾客按 `(client_phone, store_id) WHERE status='待支付'` 唯一 |

## 7. 跨模块业务流

### 7.1 员工开单 → 顾客扫码支付

```text
order.create(store_id, client_phone, cart_items, preferred_employee_id,
             useCard?, prepaidCardAmount?)
  → 查 client_wechat_users.phone → 填入 client_user_id（可为 null）
  → 若 useCard: 事务内 SELECT balance FROM prepaid_cards WHERE user_id=$1
    （注意：无 FOR UPDATE，因为不写；仅做基础预选余额校验）
  → PG 写入 sale_orders(待支付) + sale_items(价格快照)
    + 预选字段: pending_prepaid_card_amount / payable_amount / payment_method
      - prepaid_card_amount 仅保存已结算储值卡实付净额
  → **balance 不动、card_transactions 不写入**（纯预选）
  → 返回 sale_order_id

order.qrcode(sale_order_id)
  → utils/wxacode.js → 微信接口生成小程序码
  → 参数: orderNo / path → 顾客端扫码解析

顾客端扫码链路（真正扣卡发生在此处，见 client.sys.spec.md §7.2）:
  → 顾客可调整预选方案(clientApi.order.scanAdjust)
  → 顾客确认支付:
    → paid=0 → clientApi.order.confirmPrepaidFull（扣卡）
    → paid>0 + 微信 → payNotify 扣卡
    → paid>0 + 线下 → 转待确认收款 → staffApi.order.confirmOffline 扣卡

  → 已支付 + preferred_employee_id → 自动创建 sale_allocations
```

**重要行为契约**：`staffApi.order.create` 是**预选**，不扣卡。单测须断言 create 返回后 `prepaid_cards.balance` 未变、`card_transactions` 无新行。

### 7.2 营业额分配

```text
订单进入已支付 → allocation_status: null → 待分配

店长操作:
allocation.save(sale_order_id, allocations[])
  → 按 sale_item 级写入 sale_allocations(employee_id, ratio, amount)
  → allocation_status: 待分配 → 已分配

allocation.deleteAllocation(sale_order_id)
  → 标记 is_void = true → allocation_status: 已分配 → 待分配

特殊场景:
  - 指定美容师 + 顾客端支付 → 系统自动 100% 分配
  - 未指定美容师 + 顾客端支付 → 待分配 等待店长手动分配
  - 订单关闭/支付失败 → sale_allocations.is_void = true

锁定规则:
  - 开单后、顾客未扫码 → 可修改
  - 顾客扫码后 → 锁定，修改须作废重开
```

### 7.3 服务核销完整流程

```text
预约路径:
  appointment.confirm(员工确认)
  → appointment.checkin(记录 checkin_at，不改状态)
  → service.create(关联 appointment_id + sale_item_ids)

直接创建路径:
  service.create(store_id, client_user_id, sale_item_ids, assigned_employee_id)

服务推进:
  service.start → 待服务→服务中
  service.complete → 服务中→待客户确认（员工标记完成，仅记 staff_completed_at，无副作用）
  service.confirm → 待客户确认→已完成（店长代确认；顾客本人走 clientApi.service.confirm；后台走 admin.confirmServiceOrder）
    → finalize 原子: UPDATE sale_items SET remaining_sessions = remaining_sessions - session_used
      WHERE sale_item_id = $1 AND remaining_sessions >= session_used
    → rowCount=0 → 次数不足，回滚
    → 计算并写入 service_commissions（双字段模型，缺率写 operation_logs）
    → 会员到店积分：售后单 + 至少一个非零价项目 + 非寄存退款备注
      → point_transactions(type='到店赠送') + points_balance 同步增量
      → external_ref=visit-points:{client_user_id}:{service_date}，同客同日幂等
      → 发放失败写 points.visitGrantFailed，不阻断服务完成；夜间任务补偿
    → 状态翻转 WHERE status='待客户确认'（并发锁定，rowCount=0 视为已被其它入口确认 → 幂等）
    → 归零检查:
      → remaining_sessions = 0 → 关闭关联的待确认/已确认预约
      → 订单所有行归零 → sale_orders.status → 已完成
    → finalize SQL 在 staffApi/clientApi 双端独立副本，cross-end-sql-snapshot.test.js 守护
  service.cancel → 不扣次数（待服务/服务中/待客户确认 可取消）

权限:
  - 店长：可代创建（指定美容师），可操作本店任意服务单
  - 美容师：仅创建自己的，仅操作 assigned_employee_id = self 的服务单
```

### 7.4 工作台数据聚合

```text
staff.todayCommission
  → 今日分成/本月累计/上月累计（含订单数/服务单数）
  → 店长额外: 门店今日营收

staff.monthlyCalendar
  → 7×6 网格，每日分配金额汇总
  → 金额 ≥1000 显示为 k 格式

staff.todoList → 6 种待办:
  1. 预约待确认 → appointment-detail
  2. 服务单待推进 → service-detail
  3. 待确认收款 → order-list(presetStatus=pendingOffline)
  4. 待确认订单 → order-list(presetStatus=pendingCreate)
  5. 待提成分配 → allocation-list
  6. 待审批解绑 → unbind-requests
```

### 7.5 体验单流程

```text
店长选大类: 销售单 → 子类型: 体验单
  → 仅可选体验卡商品
  → order.create(sale_order_type='体验')
  → 支付 → 营业额分配（不计入普通业绩统计）
  → 创建服务单(service_order_type 由顾客 customer_type 自动判定)
  → 服务完成 → 扣次
```

## 8. 外部集成

| 外部系统 | 集成方式 | 触发点 |
|---------|---------|--------|
| 微信身份 | `cloud.getWXContext()` 零代码注入 | 每次云函数调用 |
| CloudID 手机号 | `getPhoneNumber` → 云端解密 | `auth.bindPhone` |
| 微信小程序码 | `utils/wxacode.js` 调用微信接口 | `order.qrcode` |
| CloudBase 云存储 | 商品封面图/门店环境图 URL | 前端 image 组件引用 |
| 顾客端 clientApi | 独立环境，无直接调用 | 共享 PG 数据间接协作 |

**环境变量**：
- `PG_CONNECTION_STRING` — PostgreSQL 连接串
- `CLIENT_SECRET` — 内部接口密钥（预留）
- `WXACODE_ENV_VERSION` — 小程序码环境版本（`develop`/`trial`/`release`）

## 9. 实时性保障

**消费日历实时更新**：
- 目标：订单已支付后 **5 秒内** 日历出现标记
- `utils/realtime.ts` 管理推送/轮询策略
- WebSocket 断开时：轮询 **30 秒内** 保证一致
- 幂等：同一订单仅计入一次

## 10. 开单子类型矩阵

| 大类 | 子类型 | sale_order_type | 价格规则 | 特殊约束 |
|------|--------|----------------|---------|---------|
| 销售单 | 普通单 | `普通` | `product_skus.price` | — |
| 销售单 | 体验单 | `体验` | `product_skus.price` | 限选体验卡；不计普通业绩 |
| 销售单 | 内部单 | `内部` | `price × 0.5` | 不算顾客数/会员等级 |
| 销售单 | 福利活动 | `福利活动` | 方案内价格 | 方案内项目不可增删 |
| 回款单 | — | `回款` | 回款金额 | `ref_sale_order_id` 必填；P2 |
| 转换单 | — | `转换` | 补差价 | `ref_sale_order_id` 必填；P2 |

## 10.1 储值卡抵扣集成（员工端视角）

**数据模型**：`prepaid_cards` 一户一账户（`UNIQUE(user_id)`，**无 `store_id` 列**），余额跨店共享。`paymentMethodEnum` 扩展为 4 值：`['微信', '支付宝', '线下', '无']`；`paid_amount = 0` ⇔ `payment_method = '无'`（应用层双向蕴含校验）。

**扣卡契约**：

| 触发点 | 场景 | 动作 |
|--------|------|------|
| `order.create` / `order.createConversion` | 充值卡全额覆盖应付 | 创建事务内 `FOR UPDATE` + 二次校验 + 扣 balance + INSERT `card_transactions(type='扣款')` + 置已支付 |
| `order.confirmOffline` | 顾客扫码选线下 → 店长确认收款 | 事务内 `FOR UPDATE` + 二次校验 + 扣 balance + INSERT `card_transactions(type='扣款')` + 置已支付 |
| `order.approveRefund` | 退款审批通过 | 按比例 `refundByCard = floor(prepaid/total × refund, 2)`、`refundByOrigin = refund - refundByCard`；储值卡部分 INSERT `type='充值'` 回冲 balance |

**不扣卡的关键路径**（预选 / 转交客户端扣）：

- `order.create`：部分抵扣仅写入预选值（`pending_prepaid_card_amount` / `payable_amount` / `payment_method`），`balance` 不动
- `order.createConversion` 正差额部分抵扣 / `order.createRepayment`：沿用"店长开单 → 顾客扫码确认"链路，balance 由 clientApi / payNotify / confirmOffline 处理
- `order.createConversion` 负差额（多退给客户）：保留现有"充入储值卡"逻辑，UPSERT 维度改为 `ON CONFLICT (user_id)`，INSERT 列集不含 `store_id`

**充值卡金额约束**：普通销售单、内部单和转换单的页面初始值均为 `0.00`。前端输入上限为 `min(应付金额, prepaid_cards.balance)`；普通/内部单对挂账还须不超过本次逐行实付合计。服务端不得信任前端钳制：非负且有限、不得超过应付上限，并在金额大于零时读取实时余额复核；全额抵扣仍由既有 `FOR UPDATE` 扣卡流程二次校验。

**余额查询**：`customer.customerBalance({customerUserId})` — 跨店统一余额；`requireManager()` 权限校验。

## 11. 不包含（员工端不实现）

| 能力 | 归属 |
|------|------|
| 自助下单/支付 | 顾客端 |
| 预约创建/取消 | 顾客端 |
| 支付接口集成 | 顾客端 payNotify |
| 商品 CRUD | 管理后台 |
| 完整报表/数据中心 | 管理后台 |
| 券模板管理/发放 | 管理后台 |
| 权限细粒度配置 UI | 管理后台（员工端仅查看） |
| WorkFine 数据同步 | db/scripts 离线脚本 |
| 转换单/退款单/回款单/取货单 | P2 |
| 消息推送/排班 | 暂不实现 |

> 历史勘误：「库存」曾列为暂不实现，已被进销存 v3 推翻（见
> `docs/changes/arch/011_inventory-domain-v3.md`）。现状：`routes/inventory.js` 提供
> 11 个 action（stockList / reportableSkuOptions / storeOptions / docOrgOptions /
> docList / docDetail / createDoc / confirmReceive / approveDoc / rejectDoc 等），
> 仅门店层主体（`buildInventoryLocationScope` 按 source/target_org_node_id 双端点
> org 树过滤）；写操作要求动作与 scope 来自同一角色绑定；响应与入参均不含金额字段
> （`assertNoStaffMoneyFields`）；与 admin 的一致性由
> `__tests__/routes/cross-end-inventory-snapshot.test.js` 守护。
