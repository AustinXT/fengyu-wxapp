# 凤御双美容院 — 管理后台（Web端）产品需求规格书

> **文档版本**: 2.0.1
> **端口**: 管理后台（Web端，面向内部管理人员）
> **约束文档**: `.42cog/real.md` v3.1.0 | `.42cog/cog.md` v4.0.0
> **依赖文档**: `backend.pr.spec.md` v3.3.0 | `staff.pr.spec.md` v1.0.0
> **日期**: 2026-08-17

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

以上 7 个角色是系统迁移时保留的初始角色，不再是封闭枚举。角色定义存储在
`permission_role_definitions`，支持新增、改名、修改说明、复制权限、调整权限和删除；
`role_key` 为不可变内部标识，员工现有 `permission_roles` 授权迁移时原样保留。
高级能力独立于角色键：`can_access_admin` 控制后台登录，`is_super_admin` 控制超级管理员硬闸，
`is_store_manager` 控制员工端店长能力。至少保留一名在职超级管理员，已分配角色不可删除。

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
| **system** | diagnostics / database backup | ✅ | - | - | - | - | - |
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

admin 管理权限分配/撤销、WorkFine → PG 数据同步、操作日志查看、系统自检与经营数据看板。依赖 MAS-1/2。超出范围：通用可观测平台、自动故障修复、审计报告导出。

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

**商品字段**: name, category_id, description, is_shengmei, is_bundle, price, special_price, sales_category, manage_scope, market_scope, cover_image, detail_images[], is_enabled, sort_order

**SKU 字段**: spec_name, product_type, price, special_price, session_count, service_fee, is_bundle_sku, is_enabled, **is_experience, is_recharge_card**（capability 列，业务判定 SSoT，详见 `backend.pr.spec.md` §2.6 + §4 #23/#24）

**约束**: price/service_fee ≥ 0；session_count ≥ 1（非 null）；套餐赠品 price=0；上下架叠加（商品+SKU 均 is_enabled=true 才展示）；下架=设 is_enabled=false；价格变更不影响已有订单；`is_experience` 与 `is_recharge_card` 互斥（DB CHECK `chk_sku_not_both_capabilities`）；UI 编辑两个 capability 列勾选互斥提示

#### AFF-05 提成比例矩阵配置

**操作对象**: `commission_rate_matrix` | 权限：仅 admin

**字段**: org_id（市场节点）, order_type, role_type, sales_category, amount_tier_min/max, commission_rate [0,1]

**约束**: UNIQUE `(org_id, order_type, role_type, sales_category, amount_tier_min)`；金额阶段不可重叠；物理删除（快照在 sale_allocations）

#### AFF-06 顾客档案管理

**操作对象**: `client_wechat_users` | 权限：manager/customer_mgr（读写）, finance（只读）

**可编辑字段**: name, bound_store_id, bound_employee_id, member_level, customer_source, category, birthday, occupation, is_married, wechat_name, skin_type, improvement_focus, skin_issue, wellness_preference

**不可编辑**: user_id, openid, session_key, phone, last_login_at, created_at, updated_at

**约束**: phone 唯一；新增须填 phone（系统生成 user_id）

**顾客详情只读资产**: 在“疗程卡”后展示“家居产品”。纳入已支付/部分支付/已完成订单的家居产品购买行；展示待提、已付、购买数量，以及状态、购买门店、购买时间和订单号。购买数量为订单数量；已付数量按单行实收占销售金额的比例折算并向下取整到整件（零销售额视为全部已付）；待提数量不得超过“已付整件数 - 实际提货数”，同时扣除已退款结算数量。完全退款行不展示，已全部提货行保留；按现有顾客数据权限校验，资产可跨门店汇总。

### 4.2 次要可供性

#### AFF-07 权限角色管理

**操作对象**: `permission_role_definitions` + `permission_roles` | 权限：admin, hr | 操作：角色定义增删改、分配（role+scope_id）、撤销、批量查看

**scope 传递约束**: hr 分配的 scope_id 须在其 scope 内；只有 admin 可分配/撤销 admin 角色；admin 不受 scope 限制

**admin 特殊规则**: scope_id 固定 headquarters；分配需二次确认；变更强制写 operation_logs

**动态角色规则**: 非超级管理员角色可绑定总部/市场/门店；超级管理员角色只允许总部。
角色删除前必须撤销全部员工授权；角色名称全局唯一，内部 role_key 不随改名变化。

#### AFF-08 业务操作（adminApi）

adminApi 独立实现 staffApi 同等业务操作（开单、订单管理、营业额分配、服务单、预约），业务规则以 `backend.pr.spec.md` 为唯一真相源。

**与员工端差异**: 向导式表单（大屏适配）| JWT 认证（非 openid）| 生成可打印二维码 | 顾客列表筛选 | 订单导出 Excel（P2）

**累计梯度计价**：管理后台销售单和转换单与员工端保持一致。购物车内非体验、非店长特价、非套餐的疗程卡，按 `category_id + spec_name` 汇总 `session_count × quantity`；命中不超过累计次数的最高档位后，同组各行按该档每次价折算金额。会员使用档位会员价，非会员使用标价；前端实时预览，提交时服务端基于 SKU 权威数据重新计算，忽略被篡改的前端金额。内部单、套餐、体验卡、店长特价不参与；体验转换的转入金额最终仍由旧卡划卡价值覆盖。

**转换单**：与员工端共用同一业务规则。转入项目和差额可见后提供“体验转换”开关；开启后转入金额按旧卡划卡价值由系统锁定，不补不退、不收款、不欠款。普通转换提供“本次实付”输入并支持部分支付/后续回款。订单列表和导出支持“体验转换/普通转换”筛选及体验标记；订单详情将负差额储值金入账作为独立资产流水展示，不伪装成支付。

**业绩归属日期**：订单列表、详情和导出均展示 `performance_attribution_date`，原始订单日期同时保留。拥有 `sale_order:performance_attribution_update` 的系统管理员、店长、财务可在详情中调整一次；可选范围为原始订单上海自然日前后 7 天（含边界），无操作时限。成功后页面显示调整人/时间，写入操作日志，并立即重述首次业绩及其首次销售提成所属日期。

订单详情的回款、纯储值卡支付和退款流水展示归属日期，默认取各自 `paid_at` 上海自然日；同一权限角色可在流水入账后调整一次，可选范围为款项发生日前后 7 天。现金/在线款与储值卡组成同次混合支付时，只展示并调整现付主流水，储值卡抵扣与主流水共用归属日期和一次调整机会；首次支付主流水及其储值卡抵扣继续随订单归属日期，不提供独立修改入口。调整后该次正向/负向业绩及销售提成立即按新日期重述。

订单列表与订单明细导出提供“下单日期/款项发生日期”两种日期口径，默认按下单日期；款项发生日期按已入账的首次支付、回款、储值卡抵扣或退款时间判断订单是否入选，金额列仍展示订单当前累计快照。日期范围按上海自然日半开区间处理，完整包含结束日。

订单管理页另提供“回款明细”异步导出，一行对应一条 `sale_order_payments`，覆盖首次支付、回款、储值卡抵扣、退款及所有状态，金额保留正负号。导出复用当前订单列表的状态、类型、市场、门店、支付方式、转换模式、储值卡抵扣、搜索词和日期条件；下单日期按订单筛选，款项发生日期按当前流水的 `paid_at` 逐笔筛选，无 `paid_at` 的未入账流水在有款项日期范围时不命中。

营业额分配的销售提成列表与导出同样提供“下单日期/款项发生日期”两种日期口径，默认按下单日期；款项发生日期按当前回款行的 `paid_at` 逐笔筛选，不因同订单其他款项命中而带出全部回款。服务提成继续固定按服务日期筛选。

订单明细导出必须覆盖筛选结果中的全部订单。WorkFine 历史订单或异常原生订单没有可导出的 `sale_items` 时，按订单级生成一条“无商品明细”兜底行，保留订单、顾客及金额字段且不虚构商品分摊；存在正常商品明细的订单不得重复生成兜底行。WorkFine 历史单没有支付流水，订单 `received` 仅保留旧系统实收作为消费痕迹，不能反推为现金收款；列表、详情和导出均将支付方式展示为“未知”，订单明细导出的“现付”固定为 0。数据库 `payment_method` 继续复用枚举值“无”，通过 `legacy_source='workfine'` 与原生全额抵扣订单区分；支付方式筛选中的“无（全额抵扣）”排除 WorkFine，“未知（历史单）”只匹配 WorkFine。

订单明细导出对普通转换的负差额增加“转换差额转入储值卡”独立行，金额取关联的正向 `card_transactions`；该行商品属性为空，订单金额、实付与“现付”均按同额正数记账，“储值卡抵扣”为 0，使各金额列均可按 `转出负数 + 转入正数 + 储值金入账正数 = 0` 直接勾稽，并满足“实付 = 储值卡抵扣 + 现付”。订单详情仍以独立资产流水展示。

**异步导出明细规则**：

- 订单明细仅在同一订单内合并：真实 SKU、商品方向、规格、经营分类、单份已付/已用状态及分摊后单份金额一致时，累加总数量、可用数量和金额；不同 SKU/卡型不得因名称相同而合并，无 SKU 历史行保持独立。
- 储值卡抵扣、现付和退款先按实际明细实收分摊到分，前 N-1 行四舍五入，最后一行吸收尾差；尾差不同可保留为单独一行。
- 营业额分配销售提成按单笔回款/退款内的 SKU、经营分类、方向和完整人员分配签名合并，数量、receipt 实收、分配额及提成额分别累计；不同人员、角色、比例或提成率不得合并。
- 服务单提成不使用销售 SKU 聚合规则，始终按 `serviceItemId` 逐项目展示，并在项目内按实际服务人员拆分。

#### AFF-09 数据同步

触发 WorkFine → PG 全量同步 / 查看状态与日志 | 权限：仅 admin

**约束**: UPSERT 不锁表；不覆盖手动记录（`created_by != 'sync'`）；同步中互斥锁

#### AFF-10 操作日志查看

`operation_logs`（只读）| 权限：仅 admin | 筛选：时间范围、操作人、操作类型、目标实体

#### AFF-14 优惠券管理

**操作对象**: `coupon_templates` + `user_coupons` | 权限：admin, product

**券种**: 现金券（固定金额抵扣）| 项目券（绑定 product/category）| 折扣券（百分比，如 0.85）

**模板字段**: name, coupon_type, discount_value, min_spend, applicable_product_ids, applicable_category_ids, total_count, valid_days, validity_mode, valid_from, valid_to, is_active

**约束**: 折扣券 discount_value ∈ (0,1)；现金券 discount_value > 0；已用不可撤回；停用模板不影响已发放券；核销在开单时扣减

#### AFF-16 充值卡余额管理（2026-05-18 补）

**操作对象**: `prepaid_cards` + `card_transactions` | 权限：`prepaid_card:read` (admin / manager / finance scope 内)；`adjustBalance` 仅 admin

**列表 `/cards`**

| 列 | 字段来源 | 备注 |
|----|---------|------|
| 卡号 | `prepaid_cards.card_id` | text |
| 持有顾客 | `client_wechat_users.name` + `phone` | JOIN by user_id |
| 绑定门店 | `stores.name` | JOIN by bound_store_id |
| 余额 | `balance` | `< 0` 红色高亮（DB CHECK 防止，仅作视觉异常监控）|
| 总充值 | `SUM(amount > 0 FROM card_transactions)` | aggregate |
| 创建时间 | `created_at` | desc |
| 操作 | 跳转 `/card-transactions?card_id=` | — |

**流水 `/card-transactions`**

| 列 | 字段 |
|----|------|
| 时间 | `created_at` desc |
| 类型 | `change_type` enum（充值 / 抵扣 / 退款回冲 / 管理员调整）|
| 金额 | `amount`（正绿负红）|
| 关联订单 | `ref_sale_order_id`（点击跳订单详情）|
| 备注 | `note` |

筛选：card_id / 顾客手机号 / change_type / 时间范围

**手动调账**（仅 admin）：`adjustBalance(cardId, delta, reason)` 写 `change_type='管理员调整'` 流水 + 调整 balance，必经 `logOperation('prepaid_card.adjustBalance')` 审计。

### 4.3 潜在可供性

#### AFF-11 数据看板

P1 | 权限：manager, finance（scope 内）| 指标同 `staff.pr.spec.md` §3.12

#### AFF-12 门店解绑审批

`store_unbind_requests` | 权限：manager | 审批通过（清 bound_store_id）/ 拒绝（填原因）

#### AFF-12B 退款审批（2026-05-17 PR-Z2）

`sale_order_payments[change_type='退款']` | 权限：`sale_order:refund_approve` 由 **admin + manager** 双角色持有 | 审批通过（`status='已支付'`，触发 cascade：作废 sale_allocations / service_commissions、恢复 user_coupons、反冲 point_transactions、回滚 pickup_records、按比例回冲储值卡 balance）/ 驳回（`status='已关闭'`，写 `audit_remark` 拒因）

> **职责设计**：admin 与 manager 并列为审批角色；admin 在 manager 缺位时可代理审批。manager 在本店 scope 内可自审自批（与员工端 staffApi.approveRefund 行为对齐）。`refund_create` 全 6 个 admin-side 角色均持有（admin/manager/finance/hr/product/customer_mgr）。同人不审自单的 SoD 约束目前不强制（业务侧权衡）。

#### AFF-13 系统配置

仅 admin | 配置项：新会员消费门槛（默认 1980）、订单自动关闭时间、首页轮播图、凤御馆宣传图（P2）

#### AFF-14 系统自检

仅持有超级管理员专用权限 `system:diagnostics` 的账号可访问 `/settings/diagnostics`；页面分为“子系统自检”与“拉卡拉自检”两个 Tab。

- 子系统：检查 Admin、PostgreSQL、Analyst、cron/export worker、clientApi/staffApi/payNotify、CloudBase 存储、WorkFine 和可选外部网关。只读接口可做真实连接校验；微信/地图/OCR/AI 等可计费依赖只校验配置与网关可达性。
- 数据库备份：每天 03:00（Asia/Shanghai）自动执行，保留 7 天；手动备份异步排队，保留 30 天。执行前必须二次检查磁盘空间，不足时阻断，扣除预留后剩余低于 10% 时警告。
- 备份文件使用 `pg_dump -Fc` 生成并经 `pg_restore --list` 校验；目录 0700、文件 0600。Web 容器不挂载真实 dump 目录，不提供下载、删除或恢复操作。
- 云函数与 Analyst 健康入口使用服务名、时间戳、nonce 和 HMAC-SHA256 鉴权，时间窗为 ±5 分钟。页面不展示密钥、连接串和服务器路径。

#### AFF-15 数据中心

P2 | 权限：manager, finance（scope 内）| 模块：客户回店率、品项占比、经营动线、人效分析、排行榜

> 多门店范围：同一员工被授予多个具有 `data_center:dashboard` 的门店/市场角色时，默认汇总展示全部授权在营门店，并可按授权市场或单店下钻。市场筛选仍与账号的门店权限取交集，不得扩大至未授权门店；非总部账号不得使用全局“全部市场”范围。

> 从员工端迁入，员工端仅保留简单看板（§3.12）。

> 业绩类指标统一按 `performance_date` 聚合：首次收款跟随订单归属日，后续回款/退款按真实流水日；品项/生美按行级业绩事件，销售分配/提成跟随关联款项的业绩事件。实际收款金额仍按 `paid_at`，服务实耗/服务提成仍按 `service_date`。

---

## 5. 页面结构

### 5.1 导航结构

```
管理后台
├── 工作台
├── 经营业务：开单 | 订单 | 历史订单核对 | 营业额分配 | 退款 | 服务单 | 预约 | 提货 | 门店解绑
├── 客户运营：顾客 | 疗程卡 | 优惠券 | 会员权益 | 积分流水 | 充值卡流水
├── 商品商城：商品（含分类+SKU）| 商城
├── 库存管理：库存查询 | 供应链业务 | 市场业务 | 门店业务 | 单据中心 | 资料配置（含报货福利）
├── 组织管理：组织架构 | 门店 | 商户 | 员工 | 提成矩阵
├── 数据中心
├── 系统管理：权限 | 权限矩阵 | 消息中心 | 操作日志 | 系统配置 | 系统自检
└── 个人中心
```

**销售商品组成与提货**：资料配置中的“销售商品组成”按销售家居 SKU 聚合，每项配置一个或多个库存 SKU 及正整数数量。页面只展示组成结果，不展示底层映射行或启停操作。Admin 新建销售单、转换转入单、寄存单时，家居商品未配置组成必须阻断；成功建单后把组成冻结在销售明细。提货时按本次数量自动计算并整套扣减所有库存组成，任一组成库存不足则整笔提货回滚，不允许业务员任选某一库存 SKU。历史空快照订单提货时读取最新有效组成且不回写快照。

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
| 系统自检/备份 | ✅ | - | - | - | - | - |

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
| AC-19 | `/cards` 列表正确 JOIN 顾客/门店，余额异常（< 0）红色高亮 |
| AC-20 | `/card-transactions` 按 change_type / card_id / 顾客手机号 / 时间范围筛选可用 |
| AC-21 | admin 手动调账（`adjustBalance`）写入 `change_type='管理员调整'` 流水并经 `logOperation` 审计 |
| AC-22 | 顾客详情“家居产品”正确展示购买/实际提货/退款/待提数量，完全退款行不展示、全部提货行保留 |
| AC-23 | 销售商品组成按销售 SKU 聚合展示“库存商品 × 数量”，不暴露底层映射行 |
| AC-24 | 家居商品未配置组成时三类建单入口均阻断；配置后新订单冻结组成 |
| AC-25 | 提货按完整组成自动出库，任一库存商品不足时销售明细、提货记录和库存均不变 |
| AC-26 | 顾客详情“家居产品”纳入部分支付订单，正确展示待提/已付/购买数量；部分支付按实收比例向下取整到整件 |

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
