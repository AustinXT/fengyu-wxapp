# 凤御双美容院 — 管理后台（Web端）产品需求规格书

> **文档版本**: 2.0.0
> **端口**: 管理后台（Web端，面向内部管理人员）
> **约束文档**: `.42cog/real.md` v3.1.0 | `.42cog/cog.md` v4.0.0
> **依赖文档**: `backend.pr.spec.md` v3.3.0 | `staff.pr.spec.md` v1.0.0
> **日期**: 2026-03-13

---

## 1. 产品环境

**名称**: 凤御美业管理后台
**定位**: 员工端小程序的"超集"——覆盖员工端业务操作 + 新增数据填报与维护功能，适合大屏幕、批量操作、数据录入的办公场景。

**智能体**:

| 智能体 | 行动能力 |
|--------|----------|
| admin（超级管理员） | 基础数据 CRUD + 系统配置 + 数据同步 + 权限管理（不受 scope 限制）；**不碰业务数据和顾客** |
| manager（经理） | 业务操作（开单/收款/分配/服务/预约）+ 顾客数据（读+写）+ 经营看板（受 scope 限制） |
| finance（财务） | 财务看板 + 订单/分配只读 + 顾客消费只读 + 数据中心 |
| hr（人事） | 员工管理 + 权限分配 + 组织架构/门店管理 |
| product（品项） | 商品 CRUD + 分类管理 + 优惠券管理 |
| customer_mgr（顾客管理） | 顾客查询（完整）+ 档案维护 + 消费记录（受 scope 限制） |
| staff（员工） | 仅可通过员工端小程序操作，不登录管理后台 |

**色彩方案**（白红主题，与小程序端统一品牌色）:
- 主色：`#C0322A`（中国红） | 辅助：`#FFF0EE`（浅红）、`#F5F2EE`（暖米）
- 状态：`#D4820A`（待处理）、`#3D8A5A`（成功）、`#5E8BB3`（进行中）、`#888888`（已完成）、`#D94040`（错误）
- 文本：`#1A1A1A` → `#666666` → `#999999` | 背景：`#FAFAFA` / `#FFFFFF` | 边框：`#E8E8E8`

---

## 2. 角色与权限

### 2.1 admin 角色定义

管理后台在 cog.md 6 角色基础上新增 `admin`，并扩展 `customer_mgr` 使其可登录管理后台：

| 角色 | 标识 | 核心能力 |
|------|------|----------|
| **超级管理员** | `admin` | 基础数据 CRUD（组织/门店/员工/商品/提成）+ 系统配置 + 数据同步 + 操作日志 + admin 权限分配；**不碰业务数据和顾客** |
| 顾客管理 | `customer_mgr` | 顾客查询（完整不脱敏）、档案维护、消费记录（受 scope 限制）；需叠加基础角色使用 |

> staff 不可登录管理后台。admin 不参与同步推导，仅通过管理后台手动分配。

### 2.2 扩展权限矩阵

在 `backend.pr.spec.md` §3.1 基础上新增 admin/customer_mgr 列和管理后台专属模块：

| 模块 | 操作 | admin | manager | finance | hr | product | customer_mgr |
|------|------|-------|---------|---------|-----|---------|-------------|
| **org** | CRUD | ✅ | - | - | ✅ scope | - | - |
| **store** | R | ✅ | ✅ scope† | ✅ scope† | ✅ scope | - | - |
| **store** | CUD | ✅ | - | - | ✅ scope | - | - |
| **employee** | R | ✅ | ✅ scope† | - | ✅ scope | - | - |
| **employee** | CUD | ✅ | - | - | ✅ scope | - | - |
| **product** | CRUD | ✅ | - | - | - | ✅ | - |
| **commission** | CRUD | ✅ | - | - | - | - | - |
| **customer** | R | - | ✅ scope | ✅ scope（只读） | - | - | ✅ scope |
| **customer** | CU | - | ✅ scope | - | - | - | ✅ scope |
| **coupon** | CRUD | ✅ | - | - | - | ✅ | - |
| **permission** | list/assign/revoke | ✅ | - | - | ✅ scope | - | - |
| **permission** | assign_admin | ✅ | - | - | - | - | - |
| **sale_order** | create | - | ✅ scope | - | - | - | - |
| **sale_order** | R | - | ✅ scope | ✅ scope（只读） | - | - | - |
| **sale_order** | confirmOffline/close/resetFailed | - | ✅ scope | - | - | - | - |
| **allocation** | 全部 | - | ✅ scope | ✅ scope（只读 R） | - | - | - |
| **service** | 全部 | - | ✅ scope | - | - | - | - |
| **appointment** | 全部 | - | ✅ scope | - | - | - | - |
| **sync** | trigger/status/log | ✅ | - | - | - | - | - |
| **operation_log** | list | ✅ | - | - | - | - | - |
| **system** | config | ✅ | - | - | - | - | - |
| **data_center** | dashboard/reports | - | ✅ scope | ✅ scope | - | - | - |

> **admin 不受 scope 限制**：`buildScopeWhere()` 返回空条件。**admin 不碰业务数据和顾客**。
> **†标记**：manager/finance 对 employee/store 的 R 权限为 API 级别（嵌入业务流程中调用），无独立菜单入口。

### 2.3 登录认证

**方式**: 手机号+密码 → 匹配 `staff_wechat_users.phone` → 校验 `admin_passwords` 哈希 → 查 `permission_roles` → 签发 JWT

**admin_passwords 表**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigserial | 主键 |
| `employee_id` | varchar(30) | FK → `staff_wechat_users.employee_id`，UNIQUE |
| `password_hash` | text | bcrypt（cost ≥ 12），NOT NULL |
| `must_change` | boolean | 首次登录强制改密，DEFAULT true |
| `last_changed_at` | timestamp | 最近修改密码时间 |
| `created_at` / `updated_at` | timestamp | 时间戳 |

**登录约束**:
- staff 不可登录；customer_mgr 可登录
- 仅 `admin_passwords` 有记录的员工可登录
- `must_change = true` 时强制改密
- JWT 24h，支持刷新；连续 5 次错误锁定 15 分钟
- 登录返回与员工端相同的 `permissions` 结构（`roles[]` + `actions[]`）

---

## 3. 最小可供故事（MAS）

### MAS-1：数据填报

管理人员在 Web 端维护基础数据（组织架构 → 门店 → 员工 → 商品/SKU → 提成矩阵 → 顾客档案），使小程序端业务流程有数据支撑。无前置依赖，启用 MAS-2/3。超出范围：批量导入导出（P2）。

### MAS-2：业务操作

管理人员在 Web 端完成员工端核心业务操作（开单 → 订单管理 → 营业额分配 → 服务单 → 预约）。adminApi 独立实现，与 staffApi/clientApi 无代码依赖，业务规则以 `backend.pr.spec.md` 为唯一真相源。依赖 MAS-1。超出范围：微信扫码支付（小程序专属）。

### MAS-3：权限与系统管理

admin 管理权限分配/撤销、WorkFine → PG 数据同步、操作日志查看、经营数据看板。依赖 MAS-1/2。超出范围：系统监控告警、审计报告导出。

---

## 4. 可供性目录

### 4.1 主要可供性

#### AFF-01 组织架构管理

**操作对象**: `org_nodes` | 权限：admin, hr | 操作：树形查看、新增、编辑、软删除（有子节点禁止）

**可编辑字段**: name, type, parent_id, sort_order, is_active

**层级约束**: 引用 `backend.pr.spec.md` §2.1（headquarters→market→store→department，department 不可嵌套）

#### AFF-02 门店信息管理

**操作对象**: `stores` | 权限：admin, hr | 操作：新增（同时创建 org_nodes）、编辑、关闭（`is_closed = true`）

**可编辑字段**:
- 基本信息：store_name, opening_date, bed_count, business_hours, phone
- 地理位置：district, street_address, latitude, longitude
- 展示内容：cover_image, images[], description, announcement, parking_info

**约束**: store_name 唯一；新增须选所属市场；经纬度格式校验

#### AFF-03 员工档案管理

**操作对象**: `staff_wechat_users` | 权限：admin, hr | 操作：新增、编辑、标记离职（`is_resigned=true`，同步作废 permission_roles）

**可编辑字段**:
- 身份：employee_id（自动生成 `FY-{YYMMDD}{序号}`）, name, gender, phone, id_card（AES-256-GCM 加密，显示脱敏）
- 组织：store_id, org_node_id, position_name（先选门店再选部门）
- 档案：birthday, skills[]

**约束**: phone 唯一；编辑门店/部门时需同步更新 permission_roles scope

#### AFF-04 商品目录管理

**操作对象**: `product_categories` + `products` + `product_skus` | 权限：admin, product

**品项分类字段**: category_name, product_kind, sort_order, is_valid

**商品字段**: name, category_id, description, is_shengmei, is_bundle, price, special_price, sales_category, manage_scope, market_scope, cover_image, detail_images[], valid_start, valid_end, sort_order

**SKU 字段**: spec_name, product_type, price, special_price, session_count, service_fee, is_bundle_sku, valid_start, valid_end

**约束**: price/service_fee ≥ 0；session_count ≥ 1（非 null）；套餐赠品 price=0；有效期叠加（商品+SKU 均有效才展示）；下架=设 valid_end；价格变更不影响已有订单

#### AFF-05 提成比例矩阵配置

**操作对象**: `commission_rate_matrix` | 权限：仅 admin

**字段**: org_id（市场节点）, order_type, role_type, sales_category, amount_tier_min/max, commission_rate [0,1]

**约束**: UNIQUE `(org_id, order_type, role_type, sales_category, amount_tier_min)`；金额阶段不可重叠；物理删除（快照在 sale_allocations）

#### AFF-06 顾客档案管理

**操作对象**: `client_wechat_users` | 权限：manager/customer_mgr（读写）, finance（只读）

**可编辑字段**: name, store_id, bound_employee_id, member_level, customer_source, category, birthday, occupation, is_married, wechat_name, skin_type, improvement_focus, skin_issue, wellness_preference

**不可编辑**: user_id, openid, session_key, phone, bound_store_id, registered_at, last_login_at, created_at, updated_at

**约束**: phone 唯一；新增须填 phone（系统生成 user_id）

### 4.2 次要可供性

#### AFF-07 权限角色管理

**操作对象**: `permission_roles` | 权限：admin, hr | 操作：分配（role+scope_id）、撤销（软删除）、批量查看

**scope 传递约束**: hr 分配的 scope_id 须在其 scope 内；只有 admin 可分配/撤销 admin 角色；admin 不受 scope 限制

**admin 特殊规则**: scope_id 固定 headquarters；分配需二次确认；变更强制写 operation_logs

#### AFF-08 业务操作（adminApi）

adminApi 独立实现 staffApi 同等业务操作（开单、订单管理、营业额分配、服务单、预约），业务规则以 `backend.pr.spec.md` 为唯一真相源。

**与员工端差异**: 向导式表单（大屏适配）| JWT 认证（非 openid）| 生成可打印二维码 | 顾客列表筛选 | 订单导出 Excel（P2）

#### AFF-09 数据同步

触发 WorkFine → PG 全量同步 / 查看状态与日志 | 权限：仅 admin

**约束**: UPSERT 不锁表；不覆盖手动记录（`created_by != 'sync'`）；同步中互斥锁

#### AFF-10 操作日志查看

`operation_logs`（只读）| 权限：仅 admin | 筛选：时间范围、操作人、操作类型、目标实体

#### AFF-14 优惠券管理

**操作对象**: `coupon_templates` + `coupon_instances`（待建） | 权限：admin, product

**券种**: 现金券（固定金额抵扣）| 项目券（绑定 product/category）| 折扣券（百分比，如 0.85）

**模板字段**: name, coupon_type, value, min_spend, product_id/category_id, total_count, valid_days, valid_start, valid_end, is_active

**约束**: 折扣券 value ∈ (0,1)；现金券 value > 0；已用不可撤回；停用模板不影响已发放券；核销在开单时扣减

### 4.3 潜在可供性

#### AFF-11 数据看板

P1 | 权限：manager, finance（scope 内）| 指标同 `staff.pr.spec.md` §3.12

#### AFF-12 门店解绑审批

`store_unbind_requests` | 权限：manager | 审批通过（清 bound_store_id）/ 拒绝（填原因）

#### AFF-13 系统配置

仅 admin | 配置项：订单号前缀、新会员消费门槛（默认 1980）、订单自动关闭时间（P2）

#### AFF-15 数据中心

P2 | 权限：manager, finance（scope 内）| 模块：客户回店率、品项占比、经营动线、人效分析、排行榜

> 从员工端迁入，员工端仅保留简单看板（§3.12）。

---

## 5. 页面结构

### 5.1 导航结构

```
管理后台
├── 工作台
├── 业务管理：开单 | 订单 | 营业额分配 | 服务单 | 预约
├── 数据管理：组织架构 | 门店 | 员工 | 商品(含分类+SKU) | 提成矩阵 | 顾客 | 优惠券
├── 数据中心
├── 系统管理：权限 | 数据同步 | 操作日志 | 系统配置
└── 个人中心
```

### 5.2 菜单可见性

| 菜单 | admin | manager | finance | hr | product | customer_mgr |
|------|-------|---------|---------|-----|---------|-------------|
| 工作台 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 开单 | - | ✅ | - | - | - | - |
| 订单管理 | - | ✅ | ✅ 只读 | - | - | - |
| 营业额分配 | - | ✅ | ✅ 只读 | - | - | - |
| 服务单/预约 | - | ✅ | - | - | - | - |
| 组织架构/门店/员工 | ✅ | - | - | ✅ | - | - |
| 商品/优惠券 | ✅ | - | - | - | ✅ | - |
| 提成矩阵 | ✅ | - | - | - | - | - |
| 顾客管理 | - | ✅ | ✅ 只读 | - | - | ✅ |
| 数据中心 | - | ✅ | ✅ | - | - | - |
| 权限管理 | ✅ | - | - | ✅ | - | - |
| 数据同步/日志/配置 | ✅ | - | - | - | - | - |

---

## 6. 环境约束

**继承 real.md**: adminApi 须遵循 real.md 全部约束（原子扣减、价格快照、支付幂等、状态单向推进、统一鉴权、数据隔离）。admin 角色 `buildScopeWhere()` 返回空条件。

**管理后台特有约束**:

| 约束 | 说明 |
|------|------|
| API 独立 | adminApi 与 staffApi/clientApi 完全独立，自包含全部逻辑 |
| 图片上传 | CloudBase 云存储，`cloud://` URL |
| 会话安全 | JWT + HTTPS；敏感操作需二次确认 |
| 操作审计 | 数据管理增删改写入 `operation_logs` |
| 并发编辑 | 乐观锁（`updated_at` 校验） |
| 技术选型 | 待定（不影响 PRD） |

---

## 7. 验收标准

### P0（数据管理 + 权限）

| ID | 标准 |
|----|------|
| AC-01 | admin 可登录，staff 不可登录 |
| AC-02 | 新增组织节点后，门店列表/员工归属选择器同步更新 |
| AC-03 | 编辑门店信息后，顾客端展示更新值 |
| AC-04 | 新增员工后，该员工可在员工端绑定手机号 |
| AC-05 | 新增商品+SKU 后，员工端开单可选 |
| AC-06 | 修改 SKU 价格后，已有订单 unit_price 不变 |
| AC-07 | 配置提成矩阵后，分配时比例正确 |
| AC-08 | 编辑顾客档案后，员工端展示更新值 |
| AC-09 | 仅 admin 可分配 admin 角色（manager/hr → -403） |
| AC-10 | 权限撤销后，被撤销者立即失去权限 |
| AC-11 | 所有数据管理增删改写入 operation_logs |

### P0（业务操作）

| ID | 标准 |
|----|------|
| AC-12 | 管理后台开单 → PG 有记录 |
| AC-13 | 确认收款 → 状态变已支付 |
| AC-14 | 分配保存 → PG 有分配明细 |
| AC-15 | 完成服务单 → remaining_sessions 正确扣减 |

### P1

| ID | 标准 |
|----|------|
| AC-16 | 数据看板与 PG 聚合一致 |
| AC-17 | 同步后 PG 与 WorkFine 一致 |
| AC-18 | 操作日志多维筛选正确 |

---

## 8. 非可供性

| 行动 | 禁止理由 |
|------|----------|
| 直接修改订单金额 | 价格快照不可变；需作废重开 |
| 直接修改 remaining_sessions | 防超卖；只能通过服务单完成扣减 |
| 物理删除有 FK 引用的记录 | 数据完整性；使用软删除 |
| 绕过状态机修改状态 | 单向推进；即使 admin 也不可 |
| staff 登录管理后台 | 仅限移动端 |
| 管理后台发起微信支付/扫码 | Web 端无此能力 |
| 编辑 openid / session_key | 系统自动管理 |
| 跨 scope 操作（admin 除外） | 数据隔离 |

---

## 9. 技术实现要点

- **adminApi 独立性**: 独立 Web 后端，自包含 PG 连接池、JWT 中间件、权限校验、全部业务逻辑，与 staffApi/clientApi 无代码依赖。
- **认证流程**: 手机号+密码 → admin_passwords 校验 → staff_wechat_users → permission_roles → JWT。`ctx.auth` 结构同 staffApi。
- **乐观锁**: `WHERE id = $1 AND updated_at = $2`，rowCount=0 → "数据已被修改，请刷新"。
- **业务规则一致性**: 以 `backend.pr.spec.md` 为唯一真相源，adminApi 独立实现但保持一致。
