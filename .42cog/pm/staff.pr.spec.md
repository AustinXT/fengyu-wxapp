# 凤御双美容院 — 员工端小程序产品需求规格书

> **文档版本**: 1.0.0
> **端口**: 员工端小程序（B端，appid: wxe3f5d9ee6a94d22d）
> **约束文档**: `.42cog/real.md` v2.0.0 | `.42cog/cog.md` v2.0.0
> **日期**: 2026-03-09

---

## 1. 产品概述

**名称**: 凤御美业员工端小程序
**标语**: 门店经营与服务管理一站式工作平台
**目标用户**: 凤御双美容院的门店员工（店长、美容师）、市场管理层和总部管理层

**核心价值**:
1. 店长快速开单（正式/体验/福利活动），扫码收款，完成营业额分配
2. 管理预约、推进服务单、完成疗程核销
3. 查看顾客档案与消费日历，掌握经营数据

**色彩方案**:
- 角色标识：粉红/珊瑚色渐变
- 金额数据：红色高亮
- 状态标签：蓝色（预约中）、绿色（已确认）、灰色（已完成）、橙色（待确认）
- 职级标签：橙色

---

## 2. 核心用户旅程

### 旅程 A：员工开单 → 扫码收款

```
搜索顾客 → 选择开单模式（商品目录/福利活动/体验单）→ 添加项目 → 营业额分配 → 生成二维码 → 顾客扫码支付 / 确认线下收款
```

### 旅程 B：顾客端下单后员工端联动

```
收到顾客线下付款申请 → 确认线下收款 → 进入顾客档案日历 → 查看实时消费标记
```

### 旅程 C：预约 → 到店签到 → 服务完成

```
收到预约通知 → 确认预约 → 顾客到店签到 → 创建服务单（关联预约）→ 开始服务 → 完成服务（扣减次数）
```

### 旅程 D：散客到店 → 创建体验单 → 服务

```
顾客到店（无订单）→ 店长创建体验单 → 支付确认 → 营业额分配 → 创建服务单 → 完成服务
```

### 旅程 E：营业额分配

```
订单支付完成 → 进入分配页面 → 选择部门/员工 → 按提成比例分配 → 保存（锁定后不可修改）
```

---

## 3. 功能需求

### P0 — MVP 核心功能

#### 3.1 认证与身份绑定

**实现状态**: 已实现

| ID | 需求 | 说明 |
|----|------|------|
| AUTH-01 | 微信登录 | 调用 `wx.login` → 换取 openid；自动创建 `staff_wechat_users` 记录；从 PG `employees` 查询职位信息（店长/美容师） |
| AUTH-02 | 手机号绑定 | 通过 `getPhoneNumber` 获取手机号；自动关联 PG `employees` 员工档案（`employee_id`）；清除认证缓存 |

**角色判定**:
- PG `employees.position_name = '门店经理'` 或 `permission_roles.role = 'manager'` → 店长
- 其他职位 → 美容师

**约束**:
- 员工必须在 PG `employees` 有在职档案才能完成绑定
- 两端 appid 不同，openid 相互独立（员工端 vs 客户端）

**API**: `auth.login` / `auth.bindPhone`

---

#### 3.2 门店选择

**实现状态**: 已实现

| ID | 需求 | 说明 |
|----|------|------|
| STORE-01 | 门店列表 | 从 PG `stores` + `org_nodes` 查询营业中门店 |
| STORE-02 | 切换工作门店 | 验证门店存在性，返回门店名供前端本地存储 |
| STORE-03 | 解绑申请审批 | 店长审批顾客的门店解绑申请（approve/reject） |

**个人中心页面**（profile.ts）:
- 门店切换：使用 Picker 组件（仅首次点击时加载门店列表，后续使用缓存）
- 手机号重新绑定按钮
- 快捷导航：订单列表、服务单列表、顾客列表（3 个 Cell 入口）
- 退出登录：确认弹窗 → `app.resetEmployeeInfo()` 清除全部缓存 → `reLaunch` 跳转登录页

**数据来源**: PG `stores` + `org_nodes` + PG `store_unbind_requests`（读写）

**API**: `store.list` / `employee.bindStore` / `store.unbindRequests` / `store.approveUnbind` / `store.rejectUnbind`

---

#### 3.3 开单（核心流程）

**实现状态**: 已实现

**权限**: 仅店长（门店经理）可开单

**开单流程**:
```
选择项目（四级导航：大类→分类→SPU→SKU）→ 加入购物车 → 结算弹层（选顾客→选类型→确认）→ 生成订单二维码 → 顾客扫码支付 / 确认线下收款
```

**三种开单模式**:

| 模式 | sale_order_type | 说明 |
|------|-----------|------|
| 正式订单 | `正式` | 从商品目录选择 SPU/SKU，按 PG `product_skus.price` 开单 |
| 体验单 | `体验` | 首次体验/引流，店长可自定义金额，走相同支付流程 |
| 福利活动 | `福利活动` | 从 PG `products`（`product_kind = '福利活动'`）选择，方案内项目不可增删，单独成单 |

**项目选择（四级导航）**:

| 层级 | 内容 | 数据来源 |
|------|------|----------|
| 顶部 Tab | 大类切换：`福利活动 | 护理项目 | 家居产品 | 充值卡`（`product_kind` 枚举） | 固定常量 |
| 左侧分类 | 品项分类选择器 | PG `product_categories`（仅含有效 SKU 的分类），院装产品固定追加末尾 |
| 右侧列表 | SPU 卡片列表 | PG `products` + `product_skus`（is_active 过滤），按 categoryId 缓存已加载列表 |
| 商品详情 | SKU 规格选择 | PG `product_skus.price` / `session_count` |

**促销方案项目**:
- 方案列表：PG `products`（`product_kind = '福利活动'`）
- 方案详情：PG `product_skus`（价格/次数自包含，赠品价格为 0）

**购物车交互**:
- 购物车支持**逐项优惠**（per-item discount）：每个 SKU 可单独设置 discount 金额
- discount 上限校验：`discount ≤ price × quantity`
- 从 product-detail 返回时通过 `app.globalData.pendingCartItem` 传递新项目
- 两种加入方式：**加入购物车**（继续选购）/ **直接结算**（`directCheckout` flag → 自动弹出结算弹层）

**结算流程（3 步弹层）**:

| Step | 内容 | 说明 |
|------|------|------|
| Step 0 | 选择顾客 | 手机号搜索 + 最近顾客列表（localStorage 存储最多 5 个） |
| Step 1 | 选择开单类型 | `normal`（正式）/ `experience`（体验，仅店长可选） |
| Step 2 | 确认 + 备注 | 核对商品清单 → 提交后跳转二维码页 |

**核心规则**:
- 顾客手机号为必填项，自动查询是否已注册客户端小程序
- 已注册 → 直接关联 `client_user_id`；未注册 → 手机号临时标识，待绑定后自动关联
- 价格快照：开单时写入 `sale_items.unit_price`，后续不可变
- 订单号格式：`FY-XSD-WX-{YYMMDD}{4位序号}`，advisory lock 防并发
- 商品行流水号格式：`XSLSH-WX-{YYMMDD}{4位序号}`
- 门店未配置店长时，前端提示"请先配置门店店长"

**API**: `order.create` / `product.shopInit` / `product.categories` / `product.spuList` / `product.skuDetail` / `product.spuDetail` / `product.promotionList` / `product.promotionPlans`

---

#### 3.4 营业额分配

**实现状态**: 已实现

**权限**: 仅店长

**基本规则**:
- 先选择部门，再选择该部门下可分配业绩的员工
- 可分配业绩的员工由 PG `employees` 中字段控制

**分配规则**:

| 场景 | 规则 |
|------|------|
| 同部门分配 | 多名员工参与时，分配总额 ≤ 实收金额 |
| 跨部门分配 | 各部门可各按实收金额分配（总额可达实收 N 倍） |
| 默认候选人 | 订单指定的美容师（`preferred_employee_id`） |
| 未指定美容师 | 店长从全体可分配员工中手动选择 |

**销售分类（sales_category）**: 自采自销 / 他销自耗 / 他销他耗 / 生态合作

**提成比例**: 市场 × 部门 × 销售分类 × 金额阶段 → 提成比例（从 PG `commission_rate_matrix` 查询）

**"无需分配"标记**: `onSkipAllocation()` — 以空 allocations 数组调用 `allocation.save`，将订单标记为已处理

**恢复已有分配**: `restoreAllocations()` — 编辑已分配订单时，从已有 `sale_allocation_items` 恢复 displayItems，回填部门/员工/金额

**三接口并行初始化**: `Promise.all([allocation.suggest, employee.departments, order.detail])` → 首次加载时并行获取建议分配、部门列表、订单详情

**提成比例查询**: `lookupRate(dept, salesCategory, totalAmount)` — 美容部/养生部直接查 `beautyRates`，其他部门按 `rates` 数组的 amountRange 匹配

**可编辑窗口**:
- 开单后、顾客扫码前（二维码状态"待扫码"）→ 可修改
- 顾客扫码后 → 立即锁定，如需修改须作废订单重新开单

**分配流程差异**:

| 来源 | 分配方式 |
|------|----------|
| 员工端开单 | 开单流程中手动分配 |
| 顾客端下单（指定美容师） | 支付后系统自动创建分配记录 |
| 顾客端下单（未指定美容师） | 支付后 allocation_status = pending，店长手动分配 |

**数据来源**:
- 部门列表：PG `employees` + `org_nodes`
- 可分配员工：PG `employees`（按门店+部门筛选）
- 提成矩阵：PG `commission_rate_matrix`
- 分配记录：PG `sale_allocations` + `sale_allocation_items`

**API**: `allocation.save` / `allocation.deleteAllocation` / `allocation.getCommissionRates` / `allocation.pendingList` / `allocation.suggest` / `employee.departments`

---

#### 3.5 订单管理

**实现状态**: 已实现

**订单列表**:
- 店长：查看本店所有订单
- 美容师：仅查看 `preferred_employee_id` 匹配的订单
- Tab 筛选（7 个）：**全部 / 待支付 / 待确认收款 / 已支付 / 已完成 / 支付失败 / 已关闭**
- 支持 `presetStatus` 参数：从工作台待办可直接跳转到指定状态 Tab（如 `pendingOffline` → 待确认收款，`pendingCreate` → 待支付）
- 列表内嵌快捷操作按钮（如"确认线下收款"可在列表中直接执行）

**各状态可执行操作**:

| 状态 | 店长操作 | 美容师操作 |
|------|---------|-----------|
| 待支付 | 查看二维码、关闭订单 | 查看 |
| 待确认收款 | 确认线下收款、关闭订单 | 查看 |
| 已支付 | 查看详情、营业额分配、创建服务单 | 查看详情 |
| 支付失败 | 重置为待支付 | — |
| 已完成 | 查看详情 | 查看详情 |
| 已关闭 | 查看详情 | 查看详情 |

**二维码状态展示**: 待扫码 / 已扫码待付款 / 已付款

**订单详情页**:
- 基本信息：订单号、状态、顾客、门店、商品明细（名称/数量/单价/销售金额）、营业额分配信息、剩余次数
- `isCreator` 判定：`opened_by === getEmployeeId()` 确定当前员工是否为开单人

**操作按钮矩阵**（均含确认弹窗，提示操作不可恢复）:

| 操作 | 方法 | 可见条件 | 弹窗提示 |
|------|------|----------|----------|
| 查看二维码 | `onShowQrcode()` | 待支付 | — |
| 确认线下收款 | `onConfirmOffline()` | 待确认收款 + 店长 | 确认弹窗 |
| 关闭订单 | `onCloseOrder()` | 待支付/待确认收款 + 店长 | "关闭后不可恢复" |
| 重置支付失败 | `onResetFailed()` | 支付失败 + 店长 | 确认弹窗 |
| 营业额分配 | `onReAllocation()` | 已支付 + 店长 | 跳转 revenue-allocation 页 |

**API**: `order.list` / `order.detail` / `order.qrcode` / `order.confirmOffline` / `order.close` / `order.resetFailed`

---

#### 3.6 顾客档案与消费日历

**实现状态**: 已实现

**顾客搜索**:
- PG `client_wechat_users` 单源查询
- 美容师看脱敏手机号（138****8888）

**顾客详情**:
- 基本信息（姓名、手机号、会员等级、绑定门店）
- 消费统计（累计消费 + 年度消费）
- PG `client_wechat_users` 单源查询
- 支持双入参：`id`（顾客编号）或 `clientUserId`（PG 用户 ID）

**疗程卡列表**:
- 从已支付订单 `sale_items` 扁平化展示，每项含 `remainingSessions/totalSessions`
- 显示格式：项目名 + 规格 + `剩余 N/M 次`
- 顾客可勾选疗程卡，批量创建服务单 → 通过 `app.globalData._serviceCreatePreload` 预加载到 service-create 页面

**消费日历**:
- 按日展示已支付订单金额（仅 `paid_at` 入账）
- 同一天多笔订单按日汇总，可展开查看明细
- **实时性要求**：订单进入 `已支付` 后 **5 秒内** 日历出现消费标记
- WebSocket 断开时，轮询在 **30 秒内** 保证一致性
- 同一订单仅计入一次（幂等）

**数据来源**:
- 顾客基本信息：PG `client_wechat_users`
- 日历消费数据：PG `sale_orders`（WHERE status = '已支付'，按 paid_at 聚合）

**API**: `customer.search` / `customer.detail` / `customer.calendar` / `customer.paidOrders`

---

#### 3.7 预约管理

**实现状态**: 已实现

**预约列表**:
- 店长：查看本店全部预约
- 美容师：仅查看指定给自己的预约
- Tab 筛选（4 个）：**待确认 / 已确认 / 今日到店 / 全部**
- 支持分页加载：`page` + `pageSize=20`，滚动触底自动加载下一页
- 从预约详情可直接跳转创建服务单（带 `appointmentId` 参数预加载）

**操作权限**:

| 操作 | 权限 | 说明 |
|------|------|------|
| 确认预约 | 店长 或 被预约美容师 | 待确认 → 已确认 |
| 到店签到 | 店长 或 被预约美容师 | 仅记录 `checkin_at`，不改状态 |

**消息提醒**（P1）:

| 触发事件 | 通知对象 | 通知内容 |
|---------|---------|---------|
| 顾客发起预约 | 被预约美容师 | "顾客 {name} 预约了 {time}，请及时确认" |
| 顾客到店签到 | 被预约美容师 | "顾客 {name} 已到店，请准备服务" |

> MVP 阶段通知方式待定（小程序订阅消息 / WebSocket / 轮询兜底），归入 P1 实现。

**预约详情**: 预约 ID、门店、时间、美容师、顾客、关联项目、关联服务单

**API**: `appointment.list` / `appointment.detail` / `appointment.confirm` / `appointment.checkin`

---

#### 3.8 服务单（护理单）

**实现状态**: 已实现

**创建服务单**:
- 从已支付订单行中选择项目进行核销
- 支持关联预约（可选，`appointment_id`）
- 一条预约对应一张服务单，不可重复创建
- 无预约时 `appointment_id` 留空

**创建权限**:
- 店长：可代为创建（指定服务美容师）
- 美容师：仅创建自己负责的服务单

**状态推进**:

| 操作 | 状态变化 | 说明 |
|------|---------|------|
| 开始服务 | 待服务 → 服务中 | — |
| 完成服务 | 服务中 → 已完成 | 原子扣减 `remaining_sessions`，幂等处理 |
| 取消服务 | 待服务/服务中 → 已取消 | 不扣减次数 |

**核销规则**:
- 仅在 `已完成` 时扣减次数：`UPDATE ... SET remaining_sessions = remaining_sessions - n WHERE remaining_sessions >= n`
- 重复完成不重复扣次（幂等）
- 若扣次后该订单行 `remaining_sessions` 归零，自动关闭该行的 `待确认/已确认` 预约

**服务单号格式**: `HLD-WX-{YYMMDD}{4位序号}`

**护理 Tab 页面**（service.ts）:
- 3 Tab：**待服务 / 服务中 / 已完成**
- 卡片展示：服务单编号 + 状态标签 + 顾客信息 + 服务项目列表（含剩余次数 `剩余 N/M 次`）+ 时间信息（按状态不同显示预计/开始/完成时间）
- 内嵌快捷操作按钮：待服务→"开始服务"、服务中→"确认完成"
- 完成服务需 Modal 确认："确认完成后将扣减1次疗程次数，操作不可撤销"
- **FAB 悬浮按钮**：右下角 "+" 按钮 → 跳转 service-create 创建服务单页面

**数据来源**: PG `service_orders` + `service_items`（读写）

**API**: `service.create` / `service.start` / `service.complete` / `service.cancel` / `service.list` / `service.detail`

---

#### 3.9 工作台

**实现状态**: 已实现

**工作台首页 UI 结构**:

| 区域 | 内容 | 说明 |
|------|------|------|
| 员工信息行 | 姓名 + 门店 + 角色 badge | 顶部展示 |
| 分成卡片 | 两列布局：今日分成 \| 本月累计 | 含订单数和服务单数 |
| 店长额外行 | 门店今日营收金额 | 仅 `isManager` 可见 |
| 月度业绩日历 | 7×6 网格 + 月份导航 | 禁止选未来月份；金额 ≥1000 显示为 `k` 格式 |
| 待办事项 | 6 种待办类型（见下方） | 角色差异控制可见性 |
| 顾客搜索 | 快捷搜索入口 | — |

**待办事项（6 种类型）**:

| # | 待办类型 | 可见角色 | 点击跳转 |
|---|---------|---------|----------|
| 1 | 预约待确认 | 全员 | appointment-detail |
| 2 | 服务单待推进 | 全员 | service-detail |
| 3 | 待确认收款 | 仅店长 | order-list (`presetStatus=pendingOffline`) |
| 4 | 待确认订单 | 仅店长 | order-list (`presetStatus=pendingCreate`) |
| 5 | 待提成分配 | 仅店长 | allocation-list |
| 6 | 待审批解绑申请 | 仅店长 | unbind-requests |

**API**: `employee.todayCommission` / `employee.monthlyCalendar` / `employee.todoList`

---

#### 3.10 员工列表

**实现状态**: 已实现

| ID | 需求 | 说明 |
|----|------|------|
| EMPLOYEE-01 | 员工列表 | 按门店查询在职员工；美容师看不到手机号 |
| EMPLOYEE-02 | 部门列表 | 按部门分组返回员工，用于营业额分配 |

**查询条件**: PG `employees.is_resigned = false` + 属于已选门店

**数据来源**: PG `employees`

**API**: `employee.list` / `employee.departments`

---

#### 3.11 数据访问权限

**实现状态**: 已实现

| 角色 | 数据访问范围 | 操作权限 |
|------|-------------|---------|
| 店长（门店经理） | 本店所有数据 | 开单、营业额分配、确认收款、关闭/重置订单、确认预约、创建/推进服务单、审批解绑 |
| 美容师 | 本人相关数据 | 确认预约（分配给自己的）、创建/推进服务单（自己的）、查看脱敏手机号 |

**角色判定**: PG `permission_roles.role` + `org_nodes.type`（从 org_nodes 获取域级别），降级时由 `employees.position_name` 推导
**门店归属**: PG `employees.store_id` → `stores`
**门店数据隔离**: 所有 PG 查询以 scope 过滤（headquarters 无过滤 / market 按 `market_name` / store 按 `store_name`），`buildScopeWhere()` 统一生成

---

### P1 — 重要功能（v1.1）

#### 3.12 数据看板（简单指标）

**实现状态**: 未实现

**来源**: 会议纪要 2026-03-04 — 简单指标在小程序展示，复杂分析跳转决策分析系统

**核心指标**:

| 指标 | 定义 | 数据来源 |
|------|------|----------|
| 客流 | 服务单数量，一人一天算一次 | PG `service_orders` |
| 客量 | 按日期+顾客去重，一人一月算一次 | PG `service_orders` |
| 新会员 | 首次消费达 1980 元 | PG `sale_orders` |
| 业绩 | 收款金额汇总（不限付款方式） | PG `sale_orders`（已支付） |
| 消耗 | 服务单划卡单价汇总 | PG `service_items` |

**角色视角**:
- 美容师：仅看自己数据
- 店长：看整店数据，拿整店业绩
- 区域总监（未来）：默认看区域数据，可筛选具体门店

**UI**: 核心指标大数字 + 折线图趋势 + 详情列表

---

#### 3.13 内部单（员工消费）

**实现状态**: 未实现

**来源**: 会议纪要 2026-03-04 — 销售单下新增内部单

**说明**:
- 员工/家属半价消费，需打标记以便数据分析时剔除
- 新增 `sale_order_type = '内部'` 枚举
- 走与正式订单相同的支付和分配流程
- 数据看板统计时可选剔除内部单

---

#### 3.14 顾客管理增强

**实现状态**: 未实现

**顾客列表增强**:
- 统计栏：全部 / 会员客 / 流量客（计数）
- 快捷标签筛选：活跃客户、即将流失、流失客户、沉睡客户、本月/下月生日客户
- 下拉筛选器：建档、等级
- 悬浮按钮：客户分配（店长权限）

**顾客档案多 Tab**（增强至 9 个 Tab）:

| Tab | 内容 | 数据来源 |
|-----|------|----------|
| 详情 | 基本信息 + 消费汇总 | PG |
| 日历 | 消费日期标记（已实现） | PG `sale_orders` |
| 购买记录 | 购买商品/服务列表 | PG `sale_items` |
| 赠送记录 | 赠送项目/优惠记录 | 待定 |
| 退换记录 | 退换货/退款记录 | 待定 |
| 持卡汇总 | 疗程卡/储值卡余次 | PG `sale_items`（remaining_sessions） |
| 跟踪 | 客户跟踪记录 | 待定（新表） |
| 回访 | 回访记录与跟进 | 待定（新表） |
| 问卷 | 满意度/需求问卷 | 待定（新表） |

**顾客分类**（会议纪要）: 粉丝/铁粉/黑钻，按年度消费金额滚动计算等级

---

#### 3.15 提成展示增强

**实现状态**: 部分实现（基础分成金额已有，详细提成计算未实现）

**提成项目卡片**:
- 卡数提成 / 手工费 / 自销实耗提成 / 自销业绩提成 / 他销业绩提成 / 退款扣提成
- 分类 Tab：合计 / 销售 / 服务 / 他销他耗 / 生态合作
- 明细列表：项目名称、时间、提成金额、业绩金额、顾客、员工、门店

**双维度提成模型**（来源：`03-开单与营业额分配.md §二`）:

| 维度 | 触发时机 | 计算基数 | 说明 |
|------|---------|---------|------|
| 销售提成 | 订单支付成功时 | 订单营业额分配金额 | 美容师/养生师均可参与，按顾客填写或指定的美容师分配 |
| 服务提成 | 服务单完成时 | 服务项目实际单价（划卡单价） | 谁做的拿服务提成（手工费），按实际执行服务的美容师计算 |

- 两个维度独立计算、独立累计，同一笔订单可同时产生销售提成和服务提成
- 销售提成归属：按营业额分配时指定的员工（美容师、养生师均可参与分配）
- 服务提成归属：实际执行服务的美容师
- 提成比例均从 PG `commission_rate_matrix` 查询

**依赖**: 提成比例矩阵（PG `commission_rate_matrix`）已实现查询接口

---

### P2 — 增强功能（Future）

#### 3.16 转换单

**说明**: 将顾客已购项目（A）转换为其他项目（B），处理差价
**复杂度**: 涉及 A 表（转出）和 B 表（转入）双向项目选择、差价计算、折旧费
**待确认需求**: 可用数量 vs 剩余次数 vs 剩余未消耗的区别、协商金额含义（批注 #7）

---

#### 3.17 退款单

**说明**: 处理顾客退款，区分全退/部分退（按件数）/部分退（按金额）
**复杂度**: 金额折算扣费、退业绩联动、退提成计算
**待确认需求**: 退款次数定义、折算扣费比例规则（批注 #9）
**依赖**: 微信支付退款接口

---

#### 3.18 回款单

**说明**: 处理顾客未付尾款/欠款清算
**流程**: 选客户 → 查看欠款列表 → 选择回款项目 → 录入回款信息 → 营业额分配

---

#### 3.19 取货单

**说明**: 实物商品（院装产品）分次提货
**流程**: 选客户 → 选已购实物商品 → 选择取货数量（≤ 剩余未取）→ 确认

---

#### 3.20 排班管理

**说明**: 按时段（09:00-23:00，半小时为单位）安排员工上岗
**UI**: 时间列表 + 员工头像气泡展示
**子页面**: 排班主页（全员）、个人排班（编辑）、上岗预览

---

#### 3.21 消息中心

**说明**: 客户沟通、评论回复、公告通知（带未读角标）
**子页面**: 客户沟通、回复评论、评论列表、公告列表/详情、订单消息通知
**依赖**: 消息推送基础设施（订阅消息/WebSocket）

---

#### 3.22 数据中心

**说明**: 经营数据多维度报表

**经营数据模块**:

| 子模块 | 内容 | 图表 |
|--------|------|------|
| 客户回店率 | 保有会员人数、客户活跃度、回访人数、客淘率 | 列表 |
| 品项占比 | 按品项分类的消耗/销售占比 | 环形饼图 |
| 经营动线 | 消费档位分布、去年基数今年被经营、持卡数 | 表格 + 环形饼图 |
| 人效分析 | 员工英雄榜、人效达标率、排名数据 | 表格 |

**数据中心首页 Tab**: 数据管理 / 门店管理 / 产品数据 / 盘点数据

**排行榜**: 门店排名、员工排名

---

#### 3.23 员工绩效

**说明**: 按时间维度（日/周/月）展示员工提成明细
**提成模式**: 普通提成 / 阶梯提成
**待确认需求**: 业绩合计/提成合计计算公式、阶梯提成计算方式（批注 #13/#14）

---

#### 3.24 甘特图预约视图

**说明**: 横轴=时间段（9:00-13:00），纵轴=服务房间（房间 A/B/C）
**图例**: 预约中（蓝）/ 确认已赴约（绿）/ 已完成（灰）/ 待确认（橙）
**交互**: 长按色块查看预约详情

---

#### 3.25 商品管理

**说明**: 商品列表查看、编辑、新增（含库存管理）
**UI**: 商品图片、名称、规格、价格、库存数量 + 编辑/新增入口
**依赖**: 当前商品元数据由运营在控制台维护，此功能将迁移至小程序内

---

#### 3.26 个人中心增强

**说明**: 员工个人主页增强功能

| 模块 | 内容 |
|------|------|
| 员工信息卡片 | 头像（可更换）、姓名、职级标签、脱敏手机号 |
| 角色标识 | 大按钮样式展示角色（粉红渐变） |
| 我的荣耀 | 等级、工龄勋章、员工商城 |
| 公告区 | 喇叭图标 + 滚动公告 |
| 设置 | 修改密码、头像更新、切换账号、用户协议 |

---

#### 3.27 日报审批

**说明**: 日报提交与查看
**待确认需求**: 提交权限（全员/仅普通员工）、接收者查看入口（批注 #27）

---

#### 3.28 库存管理

**说明**: 入库/出库/盘点操作
**待确认需求**: 入库类型枚举、采购入库数据录入入口（批注 #28）

---

#### 3.29 优惠券（员工端视角）

**说明**: 员工端查看和管理优惠券发放
**券种类型**: 现金券 / 项目券 / 折扣券（统一模型）
**来源**: 会议纪要 2026-03-04 — 先出一版再迭代

---

## 4. 状态机

### 4.1 订单状态机

```text
待支付 → 已支付              （微信/支付宝支付回调成功）
待支付 → 待确认收款          （顾客选择线下付款提交）
待支付 → 支付失败            （支付超时/失败）
待支付 → 已关闭              （店长关闭 或 开单员工关闭自己的待支付订单）
待确认收款 → 已支付          （店长确认线下收款）
待确认收款 → 已关闭          （店长手动关闭）
支付失败 → 待支付            （店长手动重置，允许重新付款）
已支付 → 已完成              （所有疗程卡/单品行 remaining_sessions 归零；院装产品支付即完成）
```

**订单状态集**: `待支付` / `待确认收款` / `已支付` / `已完成` / `支付失败` / `已关闭`

**补充说明**:
- 体验单（`sale_order_type = 体验`）与正式订单走相同状态机
- 福利活动订单（`sale_order_type = 福利活动`）走相同状态机
- 订单关闭时，对应营业额分配记录标记为无效（`is_void = true`）
- 订单支付成功后 `allocation_status` 设为 `pending`

### 4.2 预约状态机

```text
待确认 → 已确认              （员工确认预约）
待确认 → 已取消              （顾客取消）
已确认 → 已取消              （顾客取消）
已确认 → 已完成              （关联服务单完成后自动流转）
待确认 → 已关闭              （超期未到店 或 该订单行剩余次数归零）
已确认 → 已关闭              （超期未到店 或 该订单行剩余次数归零）
```

**`已关闭`触发条件**（二选一）:
1. 定时任务：预约时间超过 1 天未到店（`appointment_time < NOW() - INTERVAL '1 day'`）
2. 服务完成：该订单行 `remaining_sessions` 归零时，关联的 `待确认/已确认` 预约自动关闭

**取消规则**: `已取消` 可重新发起新预约；`已关闭` 不可重新发起

**到店签到**: 仅记录 `checkin_at` 时间，不改变预约状态

### 4.3 服务单状态机

```text
待服务 → 服务中              （开始服务）
服务中 → 已完成              （完成服务，原子扣减次数）
待服务 → 已取消              （取消服务单，不扣次）
服务中 → 已取消              （取消服务单，不扣次）
```

**扣减规则**:
- 仅在 `服务中 → 已完成` 时扣减 `session_used` 次
- 原子操作：`UPDATE sale_items SET remaining_sessions = remaining_sessions - n WHERE sale_item_id = $1 AND remaining_sessions >= n`
- 检查 `rowCount` 判断成功，若为 0 则余次不足
- 重复完成同一服务单，后端幂等返回成功（已完成状态直接返回）

### 4.4 营业额分配状态机

```text
null → pending               （订单支付成功，allocation_status 初始化）
pending → allocated          （店长完成分配）
allocated → pending          （店长删除分配记录，重新分配）
```

---

## 5. 页面结构与导航地图

### 5.1 TabBar（实际实现）

| Tab | 页面路径 | 图标 | 说明 |
|-----|----------|------|------|
| 工作台 | `pages/workbench/workbench` | tab-workbench | 员工信息、分成卡片、月度日历、6种待办、顾客搜索 |
| 开单 | `pages/order-create/order-create` | tab-create-order | 四级导航选品 + 购物车 + 3步结算弹层（仅店长） |
| 护理 | `pages/service/service` | tab-service | 3 Tab 服务单列表 + FAB 新建 |
| 顾客 | `pages/customer-list/customer-list` | tab-customer | 顾客搜索/列表 |
| 我的 | `pages/profile/profile` | tab-profile | 员工信息 |

> **设计稿 vs 实现**: 设计稿为 4 Tab（我的/工作台/消息/数据中心），实际实现为 5 Tab。开单/护理/顾客是高频操作，提升为独立 Tab 更合理。消息中心和数据中心归入 P2。

### 5.2 分包结构

| 分包 | 页面 | 说明 |
|------|------|------|
| 主包 | login, workbench, order-create, service, customer-list, profile | TabBar 页面 + 登录页 |
| packageOrder | order-qrcode, order-list, order-detail, revenue-allocation, allocation-list | 订单与分配 |
| packageCustomer | customer-detail | 顾客详情 |
| packageService | service-list, service-detail, service-create, appointment, appointment-detail, product-detail, unbind-requests | 护理与预约 |

### 5.3 导航地图

```
TabBar
├── 工作台 (workbench)
│   ├── 今日分成 → 月度业绩日历（7×6 网格）
│   ├── 待办事项
│   │   ├── 预约待确认 → 预约详情 (appointment-detail)
│   │   ├── 服务单待推进 → 服务单详情 (service-detail)
│   │   ├── 待确认收款 → 订单列表 (order-list, presetStatus=pendingOffline)
│   │   ├── 待确认订单 → 订单列表 (order-list, presetStatus=pendingCreate)
│   │   ├── 待提成分配 → 分配列表 (allocation-list) → 营业额分配 (revenue-allocation)
│   │   └── 待审批解绑 → 解绑申请 (unbind-requests)
│   └── 顾客搜索 → 顾客详情 (customer-detail)
│       ├── 消费日历
│       ├── 已支付订单
│       └── 选中疗程卡 → 创建服务单 (service-create, preloaded)
├── 开单 (order-create)
│   ├── 四级导航：大类 Tab → 左侧分类 → 右侧 SPU → 商品详情 (product-detail)
│   ├── 商品详情返回 → pendingCartItem → 加入购物车 / 直接结算
│   ├── 结算弹层 3 步（选顾客 → 选类型 → 确认）
│   └── 提交后 → 订单二维码 (order-qrcode)
├── 护理 (service) — 3 Tab: 待服务/服务中/已完成
│   ├── 卡片内嵌快捷操作（开始服务/确认完成）
│   ├── 点击卡片 → 服务单详情 (service-detail)
│   └── FAB "+" → 创建服务单 (service-create)
├── 顾客 (customer-list) → 顾客详情 (customer-detail)
│   ├── 消费日历
│   ├── 已支付订单 → 创建服务单
│   └── 解绑申请审批 (unbind-requests)（店长）
├── 预约 (appointment) — 从护理 Tab 或工作台进入
│   ├── 4 Tab: 待确认/已确认/今日到店/全部
│   └── 预约详情 (appointment-detail)
│       ├── 确认预约 / 到店签到
│       └── 创建服务单 (service-create, appointmentId)
└── 我的 (profile)
    ├── 员工信息 + 角色 badge
    ├── 门店切换（Picker）
    ├── 快捷导航：订单列表 / 服务单列表 / 顾客列表
    ├── 订单列表 (order-list) → 订单详情 (order-detail)
    │   ├── 二维码 (order-qrcode)
    │   ├── 营业额分配 (revenue-allocation)
    │   └── 分配列表 (allocation-list)
    ├── 手机号重新绑定
    └── 退出登录
```

---

## 6. 数据来源对照

### 读写（PG 自托管数据库）

| 数据域 | PG 表 | 关键字段 | 用途 |
|--------|------|----------|------|
| 组织架构 | `org_nodes` | id, name, type, parent_id, parent_name | 组织层级树、权限域目标 |
| 门店详情 | `stores` | store_id, store_name, org_node_id, market_name | 门店业务信息 |
| 员工微信用户 | `staff_wechat_users` | openid, phone, employee_id | 员工身份 |
| 顾客微信用户 | `client_wechat_users` | openid, phone, bound_store_name | 顾客身份关联 |
| 商品分类 | `product_categories` | name, product_kind, sort_order | 品项分类 |
| 商品主表 | `products` | name, category_id, product_kind, cover_image | 商品元数据 |
| 商品规格 | `product_skus` | product_id, price, session_count, is_active | 商品规格 |
| 订单主表 | `sale_orders` | sale_order_id, status, sale_sale_order_type, allocation_status | 订单 CRUD |
| 订单明细 | `sale_items` | sale_item_id, sku_id, unit_price, remaining_sessions | 商品行、价格快照、剩余次数 |
| 营业额分配 | `sale_allocations` + `sale_allocation_items` | employee_id, department, amount, commission_rate | 分配记录 |
| 权限角色 | `permission_roles` | employee_id, role, scope_id → org_nodes.id | RBAC 权限 |
| 预约 | `appointments` | status, client_user_id, employee_id, checkin_at | 预约 CRUD |
| 服务单 | `service_orders` + `service_items` | service_order_id, status, appointment_id, session_used | 服务单核销 |
| 解绑申请 | `store_unbind_requests` | status, user_id, from_store_name | 门店解绑审批 |
| 操作日志 | `operation_logs` | operator_user_id, org_node_id, action, target_type, target_id | 审计追踪（只写） |

---

## 7. 环境约束（引用 real.md）

| 约束 | 描述 |
|------|------|
| 疗程次数原子扣减 | `UPDATE ... SET remaining_sessions = remaining_sessions - n WHERE remaining_sessions >= n`，禁止先 SELECT 后 UPDATE |
| 价格快照不可变 | 开单时写入 `unit_price`，后续价格变动不影响历史订单 |
| 支付幂等 | 微信回调、线下确认、服务完成接口均需幂等，不得重复入账或扣次 |
| 状态单向推进 | 订单/服务单/预约状态只能沿状态机正向流转；唯一例外：店长可重置 `支付失败` → `待支付` |
| 域数据隔离 | 所有 PG 查询以 scope 过滤（headquarters 无过滤 / market 按 `market_name` / store 按 `store_name`），由 `buildScopeWhere()` 统一生成 |
| 订单号唯一生成 | advisory lock 防流水号并发冲突 |
| 待支付订单唯一 | 同一顾客同时只能有一笔待支付订单（数据库部分唯一索引 + 应用层校验） |
| 事务处理 | 服务单完成、订单创建、分配保存均使用 PostgreSQL transaction |
| 连接池限制 | PG max 5，懒初始化 |

---

## 8. 验收标准

### P0 核心功能

| ID | 标准 | 验证方式 |
|----|------|----------|
| AC-01 | 员工微信登录后自动创建 `staff_wechat_users` 记录 | 查看数据库表 |
| AC-02 | 手机号绑定后自动关联 PG 员工档案（`employee_id`） | 绑定后查询 employee_id 非空 |
| AC-03 | 仅店长可进入开单流程，美容师角色被拒绝 | 美容师点击开单 → 提示无权限 |
| AC-04 | 开单后 PG 订单表能查到同一笔记录 | 开单 → 查询 orders 表 |
| AC-05 | SKU 价格从 PG `product_skus` 读取，与管理端一致 | 修改商品价格 → 刷新后更新 |
| AC-06 | 店长确认线下收款后订单状态变为 `已支付` | 确认收款 → 检查状态 |
| AC-07 | 订单进入 `已支付` 后，顾客日历在 **5 秒内** 出现消费标记 | 支付 → 5 秒内刷新日历 |
| AC-08 | WebSocket 断开时，轮询在 **30 秒内** 保证一致性 | 断网恢复后 30 秒内数据同步 |
| AC-09 | 同一订单日历仅计入一次（幂等） | 重复确认 → 日历不重复标记 |
| AC-10 | 同一服务单重复完成不产生重复扣次 | 连续点击完成 → 仅扣一次 |
| AC-11 | 营业额分配保存后 PG 分配表能查到分配明细 | 分配 → 查询 sale_allocations |
| AC-12 | 美容师不可查看顾客完整手机号 | 美容师查询 → 返回脱敏手机号 |
| AC-13 | 服务单完成后 `remaining_sessions` 正确扣减 | 从 3 → 服务一次 → 变为 2 |
| AC-14 | 体验单走与正式订单相同的支付和分配流程 | 创建体验单 → 支付 → 分配 → 服务 |
| AC-15 | 福利活动订单内项目不可增删 | 选择方案后尝试修改 → 不允许 |
| AC-16 | 预约确认后 `已确认`，签到记录 `checkin_at` 但不改状态 | 签到后检查状态仍为已确认 |

### P1 重要功能

| ID | 标准 | 验证方式 |
|----|------|----------|
| AC-17 | 数据看板核心指标与 PG 数据一致 | 对比数据库聚合值 |
| AC-18 | 内部单可标记且可从统计中剔除 | 创建内部单 → 统计筛选 |
| AC-19 | 顾客列表支持标签筛选 | 选择标签 → 过滤结果正确 |

---

## 9. 不包含功能（明确排除）

| 功能 | 排除原因 |
|------|----------|
| 转换单/退款单/回款单/取货单 | 复杂度高，归入 P2，待需求确认后实现 |
| 充值卡金营业额分配 | 充值卡金相关流程未建立 |
| 跨店服务 | 跨店申请审批流程未设计 |
| PC 管理后台 | 独立项目，不在小程序范围 |
| 服务号提醒 | 依赖微信服务号，独立对接 |
| 客户反馈处理 | 依赖反馈系统（P2） |
| 报货流程 | 门店消耗品报货，待定 |
| 库存管理 | 各单位库存在线查看（P2） |
| 复杂提成计算 | 阶梯提成等复杂规则待确认（P1/P2） |
| 细粒度权限配置 | MVP 仅区分店长/美容师。以下细粒度规则暂不实现：项目部门人员按品项类别查看对应顾客档案；按数据维度（如门店/区域）限定可见范围 |
| 授权员工开单 | MVP 仅店长可开单 |
| 甘特图预约视图 | 高复杂度 UI（P2） |
| 排班管理 | 依赖排班数据（P2） |
| 消息中心 | 依赖消息推送基础设施（P2） |
| 数据中心完整报表 | 简单指标小程序展示（P1），复杂分析跳转决策系统 |
| 商品管理 | 当前由运营控制台维护（P2） |
| 用户体系迁移 | 未来所有档案在小程序管理，不再依赖外部系统（远期规划） |

---

## 10. employeeApi 接口汇总

| 模块 | 接口 | 说明 | 前端调用页面 | 实现状态 |
|------|------|------|-------------|---------|
| auth | login | 员工微信登录 | app.ts (onLaunch) | 已实现 |
| auth | bindPhone | 绑定手机号 → 关联 PG 员工档案 | login | 已实现 |
| store | list | 门店列表 | profile (Picker) | 已实现 |
| store | unbindRequests | 待审批解绑申请列表 | unbind-requests | 已实现 |
| store | approveUnbind | 审批通过解绑 | unbind-requests | 已实现 |
| store | rejectUnbind | 拒绝解绑申请 | unbind-requests | 已实现 |
| employee | list | 员工列表 | — | 已实现 |
| employee | departments | 部门列表（含员工分组） | revenue-allocation | 已实现 |
| employee | todayCommission | 今日分成 | workbench | 已实现 |
| employee | monthlyCalendar | 月度业绩日历 | workbench | 已实现 |
| employee | todoList | 待处理事项 | workbench | 已实现 |
| employee | bindStore | 切换工作门店 | profile | 已实现 |
| product | shopInit | 开单页初始化（分类+首个分类SPU） | order-create | 已实现 |
| product | categories | 品项分类列表 | order-create | 已实现 |
| product | spuList | SPU 商品列表 | order-create | 已实现 |
| product | skuDetail | SKU 详情（含实时价格） | product-detail | 已实现 |
| product | spuDetail | SPU 详情（含 SKU 列表、福利活动反查） | product-detail | 已实现 |
| product | promotionList | 福利活动列表（原始格式） | order-create | 已实现 |
| product | promotionPlans | 福利活动列表（前端适配格式） | order-create | 已实现 |
| customer | search | 顾客搜索 | order-create, customer-list | 已实现 |
| customer | calendar | 消费日历 | customer-detail | 已实现 |
| customer | detail | 顾客详情 | customer-detail | 已实现 |
| customer | paidOrders | 已支付订单（用于核销选择） | customer-detail | 已实现 |
| order | create | 员工开单（正式/体验/福利活动） | order-create | 已实现 |
| order | qrcode | 订单二维码状态 | order-qrcode | 已实现 |
| order | confirmOffline | 确认线下收款 | order-detail, order-list | 已实现 |
| order | close | 关闭订单 | order-detail | 已实现 |
| order | resetFailed | 重置支付失败 | order-detail | 已实现 |
| order | list | 订单列表 | order-list | 已实现 |
| order | detail | 订单详情 | order-detail, revenue-allocation | 已实现 |
| allocation | save | 保存营业额分配 | revenue-allocation | 已实现 |
| allocation | deleteAllocation | 删除分配记录 | revenue-allocation | 已实现 |
| allocation | getCommissionRates | 获取提成比例矩阵 | revenue-allocation | 已实现 |
| allocation | pendingList | 待分配订单列表 | allocation-list | 已实现 |
| allocation | suggest | 分配建议（自动填充） | revenue-allocation | 已实现 |
| appointment | list | 预约列表 | appointment | 已实现 |
| appointment | detail | 预约详情 | appointment-detail | 已实现 |
| appointment | confirm | 确认预约 | appointment-detail | 已实现 |
| appointment | checkin | 到店签到 | appointment-detail | 已实现 |
| service | create | 创建服务单 | service-create | 已实现 |
| service | start | 开始服务 | service, service-detail | 已实现 |
| service | complete | 完成服务（原子扣减） | service, service-detail | 已实现 |
| service | cancel | 取消服务单 | service-detail | 已实现 |
| service | list | 服务单列表 | service | 已实现 |
| service | detail | 服务单详情 | service-detail | 已实现 |

---

## 11. 前端实现基础设施

### 11.1 API 封装

统一入口 `utils/cloud.ts`：
```typescript
callStaffApi<T>(action: string, payload?: Record<string, any>): Promise<T>
```
- 调用 `wx.cloud.callFunction('staffApi', { action, payload })`
- 自动检查 `result.code !== 0` 抛出异常
- 返回 `result.data as T`

### 11.2 Mock 模式

`utils/dev-config.ts` 提供 `MOCK_ENABLED` 开关（默认 `false`）：
- 开启时 `callStaffApi` 优先走 `mockCallApi` 拦截
- 发版前必须确认为 `false`

### 11.3 角色工具函数

`utils/role.ts` 导出：

| 函数 | 作用 |
|------|------|
| `isManager()` | 判断当前员工是否为店长（`position === '门店经理'`） |
| `isBeautician()` | 判断是否为美容师 |
| `requireManager(tipMsg?)` | 非店长时 Toast 提示并返回 `false` |
| `getStaffId()` | 返回 `app.globalData.staffId` |

### 11.4 全局状态

`app.globalData` 结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| userId | string | PG staff_wechat_users.id |
| EmployeeId | string | PG 员工档案 ID |
| employeeName | string | 员工姓名 |
| position | string | 职位（'门店经理' / 其他） |
| boundStoreName | string | 当前绑定门店名 |
| boundStoreId | string | 门店 ID |
| phone | string | 手机号 |

### 11.5 登录与缓存

- `restoreFromCache()`：应用启动时从 wx.storage 恢复全局状态（兼容 legacy `role` → `position` 字段）
- `syncLoginState()`：`onLaunch` 调用 `auth.login` 同步最新状态到 globalData
- `resetEmployeeInfo()`：退出登录时清除所有字段 + `wx.clearStorageSync()`
