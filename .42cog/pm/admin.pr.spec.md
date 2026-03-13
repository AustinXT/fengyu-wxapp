# 凤御双美容院 — 管理后台（Web端）产品需求规格书

> **文档版本**: 1.0.0
> **端口**: 管理后台（Web端，面向内部管理人员）
> **约束文档**: `.42cog/real.md` v3.0.0 | `.42cog/cog.md` v3.0.0
> **依赖文档**: `backend.pr.spec.md` v3.1.0 | `staff.pr.spec.md` v1.0.0
> **日期**: 2026-03-13

---

## 1. 产品环境

**名称**: 凤御美业管理后台
**标语**: 一个可以统管门店经营与基础数据的 Web 工作台
**环境描述**: 管理后台为凤御美业生态的第三个端口（Web），是员工端小程序的"超集"——覆盖员工端大部分业务操作能力，同时新增数据填报与维护功能。员工端小程序适合移动场景下的快速操作，管理后台适合需要大屏幕、批量操作、数据录入的办公场景。

**主要智能体**:

| 智能体 | 行动能力 |
|--------|----------|
| admin（超级管理员） | 基础数据 CRUD + 系统配置 + 数据同步 + 权限管理（不受 scope 限制）；**不碰业务数据和顾客** |
| manager（经理） | 业务操作（开单/收款/分配/服务/预约）+ 顾客数据（读+写）+ 经营看板（受 scope 限制） |
| finance（财务） | 财务看板 + 订单/分配只读 + 顾客消费只读 + 数据中心 |
| hr（人事） | 员工管理 + 权限分配 + 组织架构/门店管理 |
| product（品项） | 商品 CRUD + 分类管理 + 优惠券管理 |
| customer_mgr（顾客管理） | 顾客查询（完整）+ 档案维护 + 消费记录（受 scope 限制） |
| staff（员工） | 仅可通过员工端小程序操作，不登录管理后台 |

**核心可供性**:
1. **业务操作**：开单、订单管理、营业额分配、服务单管理、预约管理（adminApi 独立实现）
2. **数据填报**：组织架构、门店信息、员工档案、商品目录、提成矩阵、顾客档案的 CRUD
3. **权限管理**：角色分配/撤销、权限查看
4. **数据同步**：触发 WorkFine → PG 全量/增量同步
5. **审计与日志**：操作日志查看、数据变更追踪

**色彩方案**（白红主题，与小程序端统一品牌色）:
- 主色：中国红 `#C0322A`（品牌色，按钮/导航高亮/链接/操作入口）
- 辅助浅色：`#FFF0EE`（浅红背景，选中行/高亮提示）、`#F5F2EE`（暖米色，辅助背景）
- 状态标签：橙色 `#D4820A`（待处理）、绿色 `#3D8A5A`（成功/已确认）、蓝色 `#5E8BB3`（进行中）、灰色 `#888888`（已完成/已关闭）、红色 `#D94040`（错误/失败）
- 文本层级：`#1A1A1A`（主文本）→ `#666666`（次要）→ `#999999`（提示）
- 背景：`#FAFAFA`（页面）、`#FFFFFF`（卡片/表格）
- 边框：`#E8E8E8`

---

## 2. 角色与权限

### 2.1 admin 角色定义

管理后台在员工端 6 角色基础上新增 `admin` 角色：

| 角色 | 标识 | 典型人员 | 核心能力 |
|------|------|----------|----------|
| **超级管理员** | `admin` | 系统运维人员、总部 IT | 基础数据 CRUD（组织/门店/员工/商品/提成）+ 系统配置 + 数据同步 + 操作日志 + admin 权限分配；**不碰业务数据（订单/分配/服务单/预约）和顾客数据** |
| 经理 | `manager` | 门店经理、市场总监 | 业务操作（开单/收款/分配/服务/预约）+ 顾客数据（读+写）+ 经营看板/数据中心（受 scope 限制）；**不碰权限管理/员工CRUD/商品CRUD/同步/配置** |
| 财务 | `finance` | 财智部人员 | 订单只读、分配只读、顾客消费只读、财务看板、数据中心；**不可做任何写操作** |
| 人事 | `hr` | 人事行政人员 | 员工管理（CRUD）、组织架构/门店管理、权限分配（scope 内）；**不碰业务数据/顾客/商品** |
| 品项 | `product` | 品项管理人员 | 商品/分类/SKU/优惠券 CRUD；**不碰业务数据/顾客/人员** |
| 顾客管理 | `customer_mgr` | 顾客管理专员、前台 | 顾客查询（完整不脱敏）、档案维护、消费记录（受 scope 限制）；需叠加基础角色使用 |

> **staff 角色不可登录管理后台**。`customer_mgr` 角色可登录管理后台（仅看到顾客管理菜单）。admin 角色不参与同步推导，仅通过管理后台手动分配。

### 2.2 扩展权限矩阵

在 `backend.pr.spec.md` §6.5 的 PERMISSION_MATRIX 基础上，新增 admin 列、customer_mgr 列和管理后台专属模块：

| 模块 | 操作 | admin | manager | finance | hr | product | customer_mgr |
|------|------|-------|---------|---------|-----|---------|-------------|
| **org** | list, detail | ✅ | - | - | ✅ scope 内 | - | - |
| **org** | create, update, delete | ✅ | - | - | ✅ scope 内 | - | - |
| **store** | list, detail | ✅ | ✅ scope 内† | ✅ scope 内† | ✅ scope 内 | - | - |
| **store** | create, update, delete | ✅ | - | - | ✅ scope 内 | - | - |
| **employee** | list, detail | ✅ | ✅ scope 内† | - | ✅ scope 内 | - | - |
| **employee** | create, update, delete | ✅ | - | - | ✅ scope 内 | - | - |
| **product** | list, detail | ✅ | - | - | - | ✅ | - |
| **product** | create, update, delete | ✅ | - | - | - | ✅ | - |
| **commission** | list, detail | ✅ | - | - | - | - | - |
| **commission** | create, update, delete | ✅ | - | - | - | - | - |
| **customer** | list, detail | - | ✅ scope 内 | ✅ scope 内（只读） | - | - | ✅ scope 内 |
| **customer** | update, create | - | ✅ scope 内 | - | - | - | ✅ scope 内 |
| **coupon** | list, detail | ✅ | - | - | - | ✅ | - |
| **coupon** | create, update, delete | ✅ | - | - | - | ✅ | - |
| **permission** | list | ✅ | - | - | ✅ scope 内 | - | - |
| **permission** | assign, revoke | ✅ | - | - | ✅ scope 内 | - | - |
| **permission** | assign_admin | ✅ | - | - | - | - | - |
| **sale_order** | create | - | ✅ scope 内 | - | - | - | - |
| **sale_order** | list, detail | - | ✅ scope 内 | ✅ scope 内（只读） | - | - | - |
| **sale_order** | confirmOffline, close, resetFailed | - | ✅ scope 内 | - | - | - | - |
| **allocation** | save, delete | - | ✅ scope 内 | - | - | - | - |
| **allocation** | list, detail | - | ✅ scope 内 | ✅ scope 内（只读） | - | - | - |
| **service** | 全部操作 | - | ✅ scope 内 | - | - | - | - |
| **appointment** | 全部操作 | - | ✅ scope 内 | - | - | - | - |
| **sync** | trigger, status, log | ✅ | - | - | - | - | - |
| **operation_log** | list | ✅ | - | - | - | - | - |
| **system** | config | ✅ | - | - | - | - | - |
| **data_center** | dashboard, reports | - | ✅ scope 内 | ✅ scope 内 | - | - | - |

> **admin 不受 scope 限制**：admin 角色查询数据时 `buildScopeWhere()` 返回空条件（等同 headquarters），其他角色沿用现有 scope 过滤逻辑。
>
> **admin 不碰业务数据和顾客**：admin 不可访问订单/分配/服务单/预约/顾客相关接口，这些是 manager 的专属职权。
>
> **customer_mgr**：独立的顾客管理角色，需叠加基础角色使用（如 staff + customer_mgr）。
>
> **†标记**：manager/finance 对 employee.list 和 store.list 的权限为 API 级别（嵌入在开单/分配等业务流程中调用），无独立菜单入口。

### 2.3 登录认证

管理后台登录方式：

| 方式 | 说明 |
|------|------|
| 手机号 + 密码 | 通过手机号匹配 PG `employees.phone`，校验密码哈希（`admin_passwords` 表），获取 `employee_id`，再查 `permission_roles` 获取角色 |

**密码管理**:
- 密码存储：bcrypt 哈希（cost factor ≥ 12），存入 PG `admin_passwords` 表
- 初始密码：admin 为员工开通管理后台权限时设置初始密码
- 修改密码：个人中心可修改（需输入旧密码验证）
- 重置密码：admin 可为任意员工重置密码（生成临时密码，首次登录强制修改）

**admin_passwords 表**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigserial | 主键 |
| `employee_id` | varchar(30) | FK → `employees.employee_id`，UNIQUE |
| `password_hash` | text | bcrypt 哈希，NOT NULL |
| `must_change` | boolean | 是否需要首次修改密码，NOT NULL DEFAULT true |
| `last_changed_at` | timestamp | 最近修改密码时间 |
| `created_at` | timestamp | 创建时间 |
| `updated_at` | timestamp | 更新时间 |

**登录约束**:
- `staff` 角色的员工不可登录管理后台（返回"无管理后台访问权限"）；`customer_mgr` 角色可登录管理后台
- 仅 `admin_passwords` 表中有记录的员工可登录（无记录 → "未开通管理后台权限"）
- 登录后返回与员工端相同的 `permissions` 结构（`roles[]` + `actions[]`）
- `must_change = true` 时强制跳转修改密码页面，修改后才能进入主界面
- Session 管理：JWT Token，有效期 24 小时，支持刷新
- 连续 5 次密码错误锁定 15 分钟

---

## 3. 最小可供故事（MAS）

### MAS-1：数据填报（使其他故事成为可能）

**故事主题**: 管理人员在 Web 端维护基础数据，使小程序端业务流程能正常运转

**可供性序列**:
1. **组织架构管理**：查看/新增/编辑/删除组织节点（感知：左侧树形导航）
2. **门店信息维护**：填写门店详情——地址、经纬度、营业时间、封面图等（感知：门店卡片列表 + 编辑表单）
3. **员工档案管理**：查看/新增/编辑员工信息，调整门店/部门归属（感知：员工列表 + 详情表单）
4. **商品目录管理**：维护品项分类、商品、SKU 的完整生命周期（感知：商品列表 + 多级编辑表单）
5. **提成矩阵配置**：配置市场×部门×销售分类×金额阶段的提成比例（感知：矩阵表格 + 行编辑）
6. **顾客档案维护**：查看/编辑顾客的美容档案字段（感知：顾客列表 + 详情编辑）

**意义闭合**: 基础数据齐全后，员工端和顾客端的商品展示、开单、分配等流程才有数据支撑
**内在动机**: 自主——集中管理数据比在各系统分散维护更高效
**依赖**: 无前置 / 启用 MAS-2、MAS-3
**超出范围**: 数据导入/导出批量工具（P2）

---

### MAS-2：业务操作（adminApi 独立实现）

**故事主题**: 管理人员在 Web 端完成员工端小程序的核心业务操作

**可供性序列**:
1. **开单**：选顾客 → 选商品 → 设价格/优惠 → 创建订单（感知：开单向导表单）
2. **订单管理**：列表/详情/确认收款/关闭/重置（感知：订单列表 + 操作按钮）
3. **营业额分配**：选部门/员工 → 设分配金额 → 保存（感知：分配编辑表单）
4. **服务单管理**：创建/开始/完成/取消服务单（感知：服务单列表 + 状态操作）
5. **预约管理**：查看/确认/签到预约（感知：预约列表 + 操作按钮）

**意义闭合**: Web 端可替代小程序完成业务操作，适合长时间办公场景
**内在动机**: 精通——大屏操作效率更高，特别是批量场景
**依赖**: 需要 MAS-1（基础数据） / 启用 MAS-3
**超出范围**: 二维码生成/扫码支付（小程序专属）、微信支付回调（后端自动处理）

> **实现说明**: adminApi 是独立的 Web 后端，与小程序云函数（staffApi/clientApi）无代码依赖。adminApi 自包含全部 DB 连接、权限校验和业务逻辑。业务规则（状态机、原子扣减、幂等等）以 `backend.pr.spec.md` 为唯一真相源，两端各自独立实现但保持一致。

---

### MAS-3：权限与系统管理

**故事主题**: admin 管理系统权限、数据同步和运营监控

**可供性序列**:
1. **权限管理**：为员工分配/撤销角色（感知：员工权限编辑面板）
2. **数据同步**：触发 WorkFine → PG 全量/增量同步（感知：同步按钮 + 进度/结果展示）
3. **操作日志**：按时间/操作人/目标实体查看操作日志（感知：日志列表 + 筛选器）
4. **数据看板**：查看核心经营指标——客流/客量/业绩/消耗（感知：指标卡片 + 图表）

**意义闭合**: 管理层掌握系统全貌，保障数据质量和安全合规
**内在动机**: 自主——对系统有完全掌控感
**依赖**: 需要 MAS-1、MAS-2
**超出范围**: 系统监控告警（运维层面）、审计报告导出

---

## 4. 可供性目录

### 4.1 主要可供性（立即可感知）

---

#### AFF-01 组织架构管理

**级别**: 主要
**启用的行动**: 查看/新增/编辑/删除 `org_nodes`

**操作对象**: PG `org_nodes` 表

**功能规格**:

| 操作 | 说明 | 权限 |
|------|------|------|
| 树形查看 | 以树形结构展示 headquarters → market → store → department 层级 | admin, hr |
| 新增节点 | 填写 name、type、parent_id、sort_order | admin, hr |
| 编辑节点 | 修改 name、sort_order、is_active | admin, hr |
| 删除节点 | 软删除（`is_active = false`）；有子节点时禁止删除 | admin, hr |

**层级约束**（应用层校验，同 `backend.pr.spec.md` §4.1）:

| 节点类型 | parent 必须是 |
|----------|--------------|
| headquarters | NULL（仅一个根节点） |
| market | headquarters |
| store | market |
| department | headquarters / market / store（不能挂在 department 下） |

**UI 参考**: 左侧树形导航 + 右侧节点详情编辑面板

---

#### AFF-02 门店信息管理

**级别**: 主要
**启用的行动**: 查看/新增/编辑 `stores` + 关联 `org_nodes`

**操作对象**: PG `stores` 表

**功能规格**:

| 操作 | 说明 | 权限 |
|------|------|------|
| 列表查看 | 表格展示门店列表，含名称/地址/营业状态/床位数 | admin, hr |
| 新增门店 | 创建 stores 记录 + 对应 org_nodes（type='store'）记录 | admin, hr |
| 编辑门店 | 修改门店详情字段（地址、经纬度、营业时间、封面图、环境图、停车信息等） | admin, hr |
| 关闭门店 | 设置 `is_closed = true`（不物理删除） | admin, hr |

**填报字段分组**:

| 分组 | 字段 | 说明 |
|------|------|------|
| 基本信息 | store_name, opening_date, bed_count, business_hours, phone | 门店基本属性 |
| 地理位置 | district, street_address, latitude, longitude | 支持地图选点或手动输入经纬度 |
| 展示内容 | cover_image, images[], description, announcement, parking_info | 图片上传至 CloudBase 云存储 |

**约束**:
- `store_name` 唯一索引
- 新增门店时必须选择所属市场（parent org_node type='market'）
- 经纬度格式校验：latitude [-90, 90]，longitude [-180, 180]

---

#### AFF-03 员工档案管理

**级别**: 主要
**启用的行动**: 查看/新增/编辑/离职 `employees`

**操作对象**: PG `employees` 表

**功能规格**:

| 操作 | 说明 | 权限 |
|------|------|------|
| 列表查看 | 表格展示员工列表，支持按门店/部门/在职状态筛选 | admin, hr |
| 新增员工 | 填写员工基本信息，指定门店和部门 | admin, hr |
| 编辑员工 | 修改员工信息（门店/部门调动、职位变更、技能标签等） | admin, hr |
| 标记离职 | `is_resigned = true`（不物理删除）；同步作废其 permission_roles 记录 | admin, hr |

**填报字段**:

| 分组 | 字段 | 说明 |
|------|------|------|
| 身份信息 | employee_id, name, gender, phone, id_card | id_card AES-256-GCM 加密存储 |
| 组织归属 | store_id（选择门店）, org_node_id（选择部门）, position_name | 联动选择：先选门店再选该门店下的部门 |
| 个人档案 | birthday, skills[] | skills 为多选标签 |

**约束**:
- `employee_id` 格式 `FY-{YYMMDD}{序号}`，系统自动生成
- `phone` 唯一（用于员工端绑定匹配）
- 编辑门店/部门时需同步更新 `permission_roles` 中 scope（如果角色 scope 为 store 级别）
- `id_card` 在表单中显示为脱敏格式（`3601**********1234`），编辑时可完整输入

---

#### AFF-04 商品目录管理

**级别**: 主要
**启用的行动**: 品项分类/商品/SKU 的完整 CRUD

**操作对象**: PG `product_categories` + `products` + `product_skus`

**功能规格 — 品项分类（product_categories）**:

| 操作 | 说明 | 权限 |
|------|------|------|
| 列表 | 按 product_kind 分 Tab（福利活动/护理项目/家居产品/充值卡），每个 Tab 展示该类型下的分类列表 | admin, product |
| 新增 | 填写 category_name, product_kind, sort_order | admin, product |
| 编辑 | 修改 category_name, sort_order, is_valid | admin, product |
| 删除 | 软删除（`is_valid = false`）；下属有有效商品时警告 | admin, product |

**功能规格 — 商品（products）**:

| 操作 | 说明 | 权限 |
|------|------|------|
| 列表 | 支持按分类/商品类型/上架状态筛选；显示名称、封面图、标价、有效期 | admin, product |
| 新增 | 填写商品信息 + 上传封面图和详情图 | admin, product |
| 编辑 | 修改商品信息（价格变更不影响已有订单，因为开单时已快照） | admin, product |
| 下架 | 设置 `valid_end` 为当前日期（不物理删除） | admin, product |

**商品填报字段**:

| 分组 | 字段 | 说明 |
|------|------|------|
| 基本信息 | name, category_id, description, is_shengmei, is_bundle | category_id 联动 product_kind |
| 价格 | price, special_price | price = 标价，special_price = 特价（可选） |
| 销售属性 | sales_category, manage_scope, market_scope | sales_category 下拉选择 |
| 展示 | cover_image, detail_images[] | 图片上传 |
| 有效期 | valid_start, valid_end, sort_order | null = 永久有效 |

**功能规格 — SKU（product_skus）**:

| 操作 | 说明 | 权限 |
|------|------|------|
| 列表 | 在商品详情页展示该商品下的 SKU 列表 | admin, product |
| 新增 | 填写 SKU 规格信息 | admin, product |
| 编辑 | 修改 SKU 信息（价格变更不影响已有订单） | admin, product |
| 删除 | 软删除（设 `valid_end`）；被 sale_items 引用的 SKU 不可物理删除 | admin, product |

**SKU 填报字段**:

| 字段 | 说明 |
|------|------|
| spec_name | 规格名（如"10次卡"、"单次体验"） |
| product_type | 疗程卡 / 单品 / 院装产品 |
| price | 标价/零售价 |
| special_price | 会员价（可选） |
| session_count | 疗程次数（疗程卡≥2，单品=1，院装产品留空） |
| service_fee | 手工费 |
| is_bundle_sku | 是否套餐组件 |
| valid_start, valid_end | 有效期 |

**约束**:
- `price >= 0`，`service_fee >= 0`，`session_count >= 1`（非 null 时）
- 套餐赠品：`price = 0`
- 有效期叠加校验：商品有效 AND SKU 有效才展示

---

#### AFF-05 提成比例矩阵配置

**级别**: 主要
**启用的行动**: 查看/新增/编辑/删除 `commission_rate_matrix`

**操作对象**: PG `commission_rate_matrix` 表

**功能规格**:

| 操作 | 说明 | 权限 |
|------|------|------|
| 矩阵查看 | 按市场分组展示提成比例矩阵，支持按 order_type/role_type/sales_category 筛选 | admin |
| 新增规则 | 选择市场 → 填写 order_type, role_type, sales_category, 金额阶段, commission_rate | admin |
| 编辑规则 | 修改 commission_rate 或金额阶段范围 | admin |
| 删除规则 | 物理删除（提成矩阵行无历史引用问题，已分配的快照在 sale_allocations 中） | admin |

**填报字段**:

| 字段 | 说明 |
|------|------|
| org_id | 市场节点（下拉选择 org_nodes type='market'） |
| order_type | "sale" / "service" |
| role_type | "技师" / "推广" |
| sales_category | "自采自销" / "他销自耗" / "他销他耗" / "生态合作" |
| amount_tier_min | 金额阶段下限（含） |
| amount_tier_max | 金额阶段上限（不含，null = 无上限） |
| commission_rate | 提成比例（如 0.08 = 8%） |

**约束**:
- UNIQUE `(org_id, order_type, role_type, sales_category, amount_tier_min)`
- `commission_rate` 范围 [0, 1]
- 金额阶段不可重叠（同 org_id + order_type + role_type + sales_category 组合下，区间不可交叉）

---

#### AFF-06 顾客档案管理

**级别**: 主要
**启用的行动**: 查看/编辑 `client_wechat_users` 的档案字段

**操作对象**: PG `client_wechat_users` 表

**功能规格**:

| 操作 | 说明 | 权限 |
|------|------|------|
| 列表查看 | 表格展示顾客列表，支持按门店/会员等级/顾客分类筛选 | manager, finance（只读）, customer_mgr |
| 详情查看 | 顾客完整档案 + 消费统计 + 疗程卡余次 | manager, finance（只读）, customer_mgr |
| 编辑档案 | 修改美容档案字段（手动维护部分） | manager, customer_mgr |
| 新增顾客 | 手动创建顾客记录（phone 为必填，生成 user_id） | manager, customer_mgr |

**可编辑字段**（非微信身份层、非系统自动字段）:

| 字段 | 说明 |
|------|------|
| name | 顾客姓名 |
| store_id | 归属门店（下拉选择） |
| primary_beautician | 所属美容师 |
| member_level | 会员等级 |
| customer_source | 顾客来源 |
| category | 顾客分类 |
| birthday | 生日 |
| occupation | 职业 |
| is_married | 是否已婚 |
| wechat_name | 微信名 |
| skin_type | 肤质类型 |
| improvement_focus | 改善重点 |
| skin_issue | 皮肤问题 |
| wellness_preference | 接受养生方式 |

**不可编辑字段**（系统自动管理）:
- `user_id`, `openid`, `session_key`, `phone`, `bound_store_id`, `registered_at`, `last_login_at`, `created_at`, `updated_at`

**约束**:
- `phone` 唯一索引，新增时校验不重复
- 编辑不影响微信身份层字段

---

### 4.2 次要可供性（交互中揭示）

---

#### AFF-07 权限角色管理

**级别**: 次要
**启用的行动**: 为员工分配/撤销角色

**操作对象**: PG `permission_roles` 表

**功能规格**:

| 操作 | 说明 | 权限 |
|------|------|------|
| 权限查看 | 在员工详情页展示该员工的所有角色 + scope 组合 | admin, hr |
| 分配角色 | 选择 role + scope_id → 创建 permission_roles 记录 | admin, hr |
| 撤销角色 | 软删除（`is_void = true, voided_at`） | admin, hr |
| 批量查看 | 按角色/门店筛选，展示权限分配总览 | admin, hr |

**scope 传递约束**:
- hr 分配权限时，被分配的 `scope_id` 必须在操作者 scope 范围内
- 只有 admin 可分配/撤销 admin 角色
- admin 不受 scope 限制

**admin 角色特殊规则**:
- admin 的 `scope_id` 固定指向 headquarters 节点
- 分配 admin 需二次确认弹窗
- admin 角色变更记录强制写入 `operation_logs`

---

#### AFF-08 业务操作（adminApi 独立实现）

**级别**: 次要
**启用的行动**: 在 Web 端执行员工端的核心业务操作

管理后台通过 adminApi 独立实现全部接口。adminApi 是 Web 后端，与小程序云函数（staffApi/clientApi）完全独立，自包含全部业务逻辑、DB 连接和权限校验。

**8a. 开单**

| 对比项 | 员工端（staffApi） | 管理后台（adminApi） |
|--------|--------|----------|
| 交互形式 | 四级导航 + 购物车 + 3步弹层 | 向导式表单（大屏适配） |
| 顾客选择 | 手机号搜索 | 手机号搜索 + 顾客列表筛选 |
| 二维码 | 生成小程序内二维码 | 生成可打印二维码图片（含支付链接） |
| 认证 | 微信 openid | JWT Token |

**8b. 订单管理**

| 功能 | 说明 |
|------|------|
| 订单列表 | 表格展示，支持多维筛选（状态/门店/日期范围/顾客/开单人） |
| 订单详情 | 完整订单信息 + 商品明细 + 分配信息 + 操作日志 |
| 确认收款 | adminApi `order.confirmOffline` |
| 关闭订单 | adminApi `order.close` |
| 重置失败 | adminApi `order.resetFailed` |
| 批量导出 | 导出订单列表为 Excel（P2） |

**8c. 营业额分配**

| 功能 | 说明 |
|------|------|
| 待分配列表 | 表格展示待分配订单 |
| 分配编辑 | 选部门 → 选员工 → 设金额 → 保存 |

**8d. 服务单管理**

| 功能 | 说明 |
|------|------|
| 服务单列表 | 表格展示，支持按状态/门店/美容师筛选 |
| 创建/推进/取消 | adminApi `service.*` |

**8e. 预约管理**

| 功能 | 说明 |
|------|------|
| 预约列表 | 表格展示，支持按状态/门店/美容师/日期筛选 |
| 确认/签到 | adminApi `appointment.*` |

---

#### AFF-09 数据同步

**级别**: 次要
**启用的行动**: 触发/查看 WorkFine → PG 数据同步

**功能规格**:

| 操作 | 说明 | 权限 |
|------|------|------|
| 触发全量同步 | 手动触发 WorkFine → PG 全量同步（org_nodes, stores, employees, client_wechat_users, commission_rate_matrix） | admin |
| 同步状态 | 展示最近同步时间、同步结果（成功/失败/部分失败）、影响行数 | admin |
| 同步日志 | 查看同步详细日志（新增/更新/跳过的记录） | admin |

**约束**:
- 同步使用 UPSERT，不锁表不中断在线查询
- 同步脚本不覆盖 `created_by != 'sync'` 的手动分配记录（permission_roles）
- 同步进行中禁止再次触发（互斥锁）

---

#### AFF-10 操作日志查看

**级别**: 次要
**启用的行动**: 按条件查询 `operation_logs`

**操作对象**: PG `operation_logs` 表（只读）

**功能规格**:

| 筛选维度 | 说明 |
|----------|------|
| 时间范围 | 日期选择器 |
| 操作人 | 按员工姓名/编号搜索 |
| 操作类型 | action 下拉（如 `sale_order.create`, `service.complete`） |
| 目标实体 | target_type + target_id 搜索 |

**展示字段**: 时间、操作人、角色、动作、目标、详情（JSON 可展开）

**权限**: 仅 admin

---

#### AFF-14 优惠券管理

**级别**: 次要
**启用的行动**: 优惠券模板的 CRUD + 发放管理

**操作对象**: PG `coupon_templates`（待建）+ `coupon_instances`（待建）

**券种类型**:

| 券类型 | 说明 | 优惠方式 |
|--------|------|----------|
| 现金券 | 满减/无门槛抵扣 | 固定金额抵扣（如满 500 减 50） |
| 项目券 | 指定项目免费/折扣体验 | 绑定 product_id 或 category_id |
| 折扣券 | 订单整单折扣 | 百分比折扣（如 8.5 折） |

**功能规格**:

| 操作 | 说明 | 权限 |
|------|------|------|
| 模板列表 | 表格展示优惠券模板，支持按类型/状态筛选 | admin, product |
| 创建模板 | 填写券名称、类型、面值/折扣率、使用条件、有效期、发放总量 | admin, product |
| 编辑模板 | 修改模板信息（已发放的券不受影响） | admin, product |
| 停用模板 | 设置 `is_active = false`，停止发放（已发放的券仍可使用至过期） | admin, product |
| 发放记录 | 查看每张券的领取/使用状态 | admin, product |

**模板字段**:

| 字段 | 说明 |
|------|------|
| name | 券名称 |
| coupon_type | 现金券 / 项目券 / 折扣券 |
| value | 面值（现金券：金额；折扣券：折扣率如 0.85） |
| min_spend | 最低消费门槛（0 = 无门槛） |
| product_id / category_id | 项目券绑定的商品/分类（可选） |
| total_count | 发放总量 |
| valid_days | 领取后有效天数 |
| valid_start, valid_end | 模板有效期（发放窗口） |
| is_active | 是否启用 |

**约束**:
- 折扣券 `value` 范围 (0, 1)
- 现金券 `value > 0`
- 已使用的券不可撤回
- 优惠券核销在开单时扣减订单金额，记入 `sale_items` 或订单级折扣字段

---

### 4.3 潜在可供性（探索发现）

---

#### AFF-11 数据看板

**级别**: 潜在（P1）
**启用的行动**: 查看经营数据指标

**核心指标**: 同 `staff.pr.spec.md` §3.12（权威定义），此处不再重复。

**角色视角**:
- manager：scope 内数据
- finance：scope 内数据

---

#### AFF-12 门店解绑申请审批

**级别**: 潜在
**启用的行动**: 审批顾客的门店解绑申请

**操作对象**: PG `store_unbind_requests` 表

| 操作 | 说明 | 权限 |
|------|------|------|
| 列表 | 展示待审批的解绑申请 | manager |
| 审批通过 | `approved` → 清除 `client_wechat_users.bound_store_id` | manager |
| 拒绝 | `rejected` + 填写拒绝原因 | manager |

---

#### AFF-13 系统配置

**级别**: 潜在
**启用的行动**: 管理系统级配置参数

**仅 admin 可操作**:

| 配置项 | 说明 |
|--------|------|
| 订单号前缀 | 各类型单据的编号前缀 |
| 新会员消费门槛 | 首次消费达标金额（默认 1980） |
| 订单自动关闭时间 | 待支付订单超时自动关闭（P2） |

#### AFF-15 数据中心

**级别**: 潜在（P2）
**启用的行动**: 查看经营数据多维度报表

> 从员工端 staff.pr.spec.md 原 §3.22 迁入。员工端仅保留简单指标看板（§3.12），完整报表在管理后台展示。

**经营数据模块**:

| 子模块 | 内容 | 图表 |
|--------|------|------|
| 客户回店率 | 保有会员人数、客户活跃度、回访人数、客淘率 | 列表 |
| 品项占比 | 按品项分类的消耗/销售占比 | 环形饼图 |
| 经营动线 | 消费档位分布、去年基数今年被经营、持卡数 | 表格 + 环形饼图 |
| 人效分析 | 员工英雄榜、人效达标率、排名数据 | 表格 |

**首页 Tab**: 数据管理 / 门店管理 / 产品数据 / 盘点数据

**排行榜**: 门店排名、员工排名

**角色视角**:
- manager：scope 内数据
- finance：scope 内数据

**权限**: manager, finance

---

## 5. 页面结构

### 5.1 导航结构

```
管理后台
├── 工作台（Dashboard）
│   ├── 核心指标卡片（今日/本月）
│   ├── 待办事项汇总
│   └── 快捷入口
├── 业务管理
│   ├── 订单管理（order）
│   │   ├── 订单列表（多维筛选 + 表格）
│   │   └── 订单详情（含操作按钮）
│   ├── 营业额分配（allocation）
│   │   ├── 待分配列表
│   │   └── 分配编辑
│   ├── 服务单管理（service）
│   │   ├── 服务单列表
│   │   └── 服务单详情
│   ├── 预约管理（appointment）
│   │   ├── 预约列表
│   │   └── 预约详情
│   └── 开单（order-create）
│       └── 向导式开单表单
├── 数据管理
│   ├── 组织架构（org）
│   │   └── 树形管理界面
│   ├── 门店管理（store）
│   │   ├── 门店列表
│   │   └── 门店编辑
│   ├── 员工管理（employee）
│   │   ├── 员工列表
│   │   └── 员工详情/编辑
│   ├── 商品管理（product）
│   │   ├── 品项分类管理
│   │   ├── 商品列表
│   │   └── 商品详情/编辑（含 SKU 管理）
│   ├── 提成矩阵（commission）
│   │   └── 矩阵配置表格
│   ├── 顾客管理（customer）
│   │   ├── 顾客列表
│   │   └── 顾客详情/编辑
│   └── 优惠券管理（coupon）
│       ├── 模板列表
│       ├── 模板编辑/新增
│       └── 发放记录
├── 数据中心（data-center）
│   ├── 经营数据（客户回店率/品项占比/经营动线/人效分析）
│   └── 排行榜（门店排名/员工排名）
├── 系统管理
│   ├── 权限管理（permission）
│   │   ├── 权限分配总览
│   │   └── 员工权限编辑
│   ├── 数据同步（sync）
│   │   └── 同步面板
│   ├── 操作日志（log）
│   │   └── 日志查询
│   └── 系统配置（config）
│       └── 参数配置（仅 admin）
└── 个人中心
    ├── 个人信息
    └── 退出登录
```

### 5.2 左侧菜单可见性

| 菜单 | admin | manager | finance | hr | product | customer_mgr |
|------|-------|---------|---------|-----|---------|-------------|
| 工作台 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 开单 | - | ✅ | - | - | - | - |
| 订单管理 | - | ✅ | ✅（只读） | - | - | - |
| 营业额分配 | - | ✅ | ✅（只读） | - | - | - |
| 服务单管理 | - | ✅ | - | - | - | - |
| 预约管理 | - | ✅ | - | - | - | - |
| 组织架构 | ✅ | - | - | ✅ | - | - |
| 门店管理 | ✅ | - | - | ✅ | - | - |
| 员工管理 | ✅ | - | - | ✅ | - | - |
| 商品管理 | ✅ | - | - | - | ✅ | - |
| 提成矩阵 | ✅ | - | - | - | - | - |
| 顾客管理 | - | ✅ | ✅（只读） | - | - | ✅ |
| 优惠券管理 | ✅ | - | - | - | ✅ | - |
| 数据中心 | - | ✅ | ✅ | - | - | - |
| 权限管理 | ✅ | - | - | ✅ | - | - |
| 数据同步 | ✅ | - | - | - | - | - |
| 操作日志 | ✅ | - | - | - | - | - |
| 系统配置 | ✅ | - | - | - | - | - |

---

## 6. 环境约束（引用 real.md）

### 6.1 继承自 real.md 的约束

| 约束 | 管理后台适用说明 |
|------|-----------------|
| 疗程次数原子扣减 | adminApi 独立实现，须遵循相同的原子 UPDATE 规则 |
| 价格快照不可变 | 管理后台修改商品价格不影响已有订单 |
| 支付幂等 | adminApi 独立实现确认收款，须遵循相同的幂等规则 |
| 状态单向推进 | 管理后台不可绕过状态机（即使 admin 也不行） |
| 角色权限中间件 | 管理后台请求同样经过 `requirePermission` 校验 |
| 门店数据隔离 | admin 角色 `buildScopeWhere()` 返回空条件；其他角色遵循 scope 过滤 |

### 6.2 管理后台特有约束

| 约束 | 说明 |
|------|------|
| Web 端技术选型 | 待定（React / Vue 均可），不影响 PRD 级别的功能定义 |
| API 独立 | adminApi 是 Web 后端，与小程序云函数完全独立，自包含全部逻辑，不引用 staffApi/clientApi 代码 |
| 图片上传 | 图片上传至 CloudBase 云存储，返回 `cloud://` 协议 URL |
| 会话安全 | JWT Token + HTTPS；敏感操作（权限变更、admin 分配）需二次确认 |
| 操作审计 | 数据管理的增删改操作写入 `operation_logs` |
| 并发编辑 | 使用乐观锁（`updated_at` 时间戳校验）防止数据覆盖 |

---

## 7. 验收标准

### P0 核心功能（数据管理 + 权限管理）

| ID | 标准 | 验证方式 |
|----|------|----------|
| AC-01 | admin 可登录管理后台，staff 不可登录 | admin 登录成功；staff 登录被拒 |
| AC-02 | 新增组织节点后，门店列表和员工归属选择器同步更新 | 新增 → 刷新 → 可选择 |
| AC-03 | 编辑门店信息后，顾客端小程序门店详情页展示更新值 | 编辑 → 顾客端查看 → 一致 |
| AC-04 | 新增员工后，该员工可在员工端小程序绑定手机号 | 新增 → 员工端绑定 → 成功 |
| AC-05 | 新增商品+SKU 后，员工端开单页可选择该商品 | 新增 → 员工端开单 → 可选 |
| AC-06 | 修改 SKU 价格后，已有订单的 unit_price 不变 | 修改 → 查旧订单 → 价格未变 |
| AC-07 | 配置提成矩阵后，营业额分配时提成比例查询正确 | 配置 → 开单 → 分配 → 比例匹配 |
| AC-08 | 编辑顾客档案后，员工端顾客详情展示更新值 | 编辑 → 员工端查看 → 一致 |
| AC-09 | admin 可为员工分配 admin 角色；manager/hr 不可 | admin 分配 → 成功；manager 分配 admin → -403 |
| AC-10 | 权限撤销后，被撤销者在员工端立即失去对应权限 | 撤销 → 员工端操作 → -403 |
| AC-11 | 所有数据管理操作写入 operation_logs | 增删改操作 → 查日志 → 有记录 |

### P0 核心功能（业务操作）

| ID | 标准 | 验证方式 |
|----|------|----------|
| AC-12 | 管理后台开单后，PG 订单表能查到同一笔记录 | 开单 → 查数据库 |
| AC-13 | 管理后台确认收款后，订单状态变为已支付 | 确认 → 检查状态 |
| AC-14 | 管理后台营业额分配保存后，PG 分配表有分配明细 | 分配 → 查数据库 |
| AC-15 | 管理后台完成服务单后，remaining_sessions 正确扣减 | 完成 → 查余次 |

### P1 增强功能

| ID | 标准 | 验证方式 |
|----|------|----------|
| AC-16 | 数据看板指标与 PG 聚合值一致 | 对比数据库 |
| AC-17 | 触发同步后，PG 数据与 WorkFine 一致 | 同步 → 对比 |
| AC-18 | 操作日志支持按时间/操作人/类型筛选 | 各维度筛选 → 结果正确 |

---

## 8. 非可供性（明确禁止的行动及理由）

| 行动 | 禁止理由 |
|------|----------|
| 直接修改订单金额 | 价格快照不可变原则；需作废重开 |
| 直接修改 remaining_sessions | 防超卖核心约束；只能通过服务单完成流程扣减 |
| 物理删除有 FK 引用的记录 | 数据完整性；使用软删除 |
| 绕过状态机修改订单/服务单状态 | 状态单向推进约束；即使 admin 也不可 |
| staff 角色登录管理后台 | staff 权限仅限移动端操作场景 |
| 管理后台发起微信支付 | 微信支付依赖小程序环境（JSAPI），Web 端无此能力 |
| 管理后台扫码 | Web 端无扫码能力，二维码仅可生成/展示/打印 |
| 编辑 openid / session_key 等微信身份字段 | 系统自动管理的身份数据 |
| 跨 scope 操作数据（admin 除外） | 门店数据隔离约束 |

---

## 9. 技术实现要点

### 9.1 API 架构

**方案**: adminApi 作为独立 Web 后端，与小程序云函数完全分离

adminApi 是管理后台的专属后端服务，与小程序端的 clientApi/staffApi 没有代码依赖关系。三端各自独立维护全部逻辑（DB 连接、权限校验、业务规则、路由），以 `backend.pr.spec.md` 为唯一业务规则真相源。

**技术选型**（待定，以下为候选方案）:

| 方案 | 说明 |
|------|------|
| CloudBase 云函数 | 与小程序端同基础设施，部署简单，HTTP 访问服务暴露 REST 端点 |
| 独立 Node.js 服务 | Express/Koa/Hono，部署在云服务器或容器，更灵活 |
| CloudBase 云托管 | 容器化部署，兼顾 CloudBase 生态和独立服务的灵活性 |

> 技术选型不影响本 PRD 的功能定义，实现阶段确定。

**adminApi 职责边界**:
- 自包含 PG 连接池（独立于 staffApi 的连接池）
- 自包含权限校验中间件（JWT 认证 + PERMISSION_MATRIX）
- 自包含全部业务逻辑（订单、服务单、分配、数据管理等）
- 业务规则（状态机、原子扣减、幂等、序号生成等）须与 staffApi 保持一致

### 9.2 认证

- 认证方式：手机号 + 密码 → 校验 `admin_passwords` 密码哈希 → 查 PG `employees` → 查 `permission_roles` → 签发 JWT
- 每次请求在 Header 携带 JWT（`Authorization: Bearer <token>`），adminApi 中间件校验并构造 `ctx.auth`
- `ctx.auth` 结构参照 staffApi 设计（包含 `roles[]`、`scopeStoreIds`、`permissions.actions[]`），便于权限校验逻辑一致

### 9.3 数据管理接口

数据管理 CRUD 接口遵循统一模式：

```
// 列表查询
{ action: 'module.list', payload: { filters, page, pageSize, sort } }

// 详情
{ action: 'module.detail', payload: { id } }

// 创建
{ action: 'module.create', payload: { ...fields } }

// 更新（乐观锁）
{ action: 'module.update', payload: { id, ...fields, updated_at } }

// 删除（软删除）
{ action: 'module.delete', payload: { id } }
```

乐观锁：更新时 `WHERE id = $1 AND updated_at = $2`，`rowCount = 0` 返回"数据已被其他人修改，请刷新后重试"。

### 9.4 adminApi 接口汇总

#### 认证与系统

| 模块 | 接口 | 说明 | 权限 |
|------|------|------|------|
| auth | login | 手机号 + 密码登录，签发 JWT | 无（登录前） |
| auth | refresh | 刷新 JWT Token | 已登录 |
| auth | logout | 登出（客户端清除 Token） | 已登录 |
| auth | changePassword | 修改密码（需旧密码验证） | 已登录 |
| auth | resetPassword | 重置员工密码（生成临时密码） | `permission:assign` |

#### 数据管理

| 模块 | 接口 | 说明 | 权限 |
|------|------|------|------|
| org | list, detail, create, update, delete | 组织架构 CRUD | `org:*` |
| store | list, detail, create, update, delete | 门店 CRUD | `store:*` |
| employee | list, detail, create, update, delete | 员工 CRUD | `employee:*` |
| product_category | list, create, update, delete | 品项分类 CRUD | `product:*` |
| product | list, detail, create, update, delete | 商品 CRUD（含 SKU） | `product:*` |
| product_sku | list, create, update, delete | SKU CRUD（嵌在商品详情中） | `product:*` |
| commission | list, create, update, delete | 提成矩阵 CRUD | `commission:*` |
| customer | list, detail, update, create | 顾客档案 CRUD | `customer:*` |
| permission | list, assign, revoke | 权限管理 | `permission:*` |
| sync | trigger, status, log | 数据同步 | `sync:*` |
| operation_log | list | 操作日志查询 | `operation_log:list` |

#### 业务操作（adminApi 独立实现，业务规则遵循 `backend.pr.spec.md`）

| 模块 | 接口 | 说明 | 权限 |
|------|------|------|------|
| order | create | 开单 | `sale_order:create` |
| order | list, detail | 订单查询 | `sale_order:list` / `sale_order:detail` |
| order | confirmOffline | 确认线下收款 | `sale_order:confirmOffline` |
| order | close | 关闭订单 | `sale_order:close` |
| order | resetFailed | 重置支付失败 | `sale_order:resetFailed` |
| allocation | save, deleteAllocation | 营业额分配操作 | `allocation:save` / `allocation:delete` |
| allocation | getCommissionRates, pendingList, suggest | 分配辅助查询 | `allocation:list` |
| service | create, start, complete, cancel | 服务单操作 | `service:*` |
| service | list, detail | 服务单查询 | `service:list` / `service:detail` |
| appointment | list, detail | 预约查询 | `appointment:list` / `appointment:detail` |
| appointment | confirm, checkin | 预约操作 | `appointment:confirm` / `appointment:checkin` |
| product | categories, spuList, skuDetail, spuDetail | 商品浏览（开单用） | `product:list` / `product:detail` |
| employee | departments | 部门列表（分配用） | `employee:list` |
| employee | todayCommission, monthlyCalendar, todoList | 工作台数据 | `workbench:dashboard` |
