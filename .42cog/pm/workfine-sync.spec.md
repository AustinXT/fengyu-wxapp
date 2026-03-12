# 凤御双美容院 — WorkFine → PG 迁移与同步方案

> **文档版本**: 1.0.0
> **范围**: WorkFine SQL Server → PostgreSQL 数据迁移、定期同步、一次性导入
> **关联文档**: `backend.pr.spec.md` v3.0.0（PG 数据模型定义）
> **日期**: 2026-03-11
>
> **核心原则**: 运行时业务查询 100% 走 PG，WorkFine SQL Server 仅作为同步源，不参与在线请求链路。

---

## 1. 概述

本文档定义 WorkFine（万应低代码平台）数据库到 PostgreSQL 的数据迁移与同步方案。涵盖：
- **组织与人员域**（门店、员工、顾客、提成比例矩阵）— 定期同步
- **商品域**（品项分类、商品、商品规格）— 一次性导入，后续手动维护

---

## 2. WorkFine 连接信息

| 项 | 值 |
|----|-----|
| 服务器 | `47.96.87.33:1433` |
| 数据库 | `wkdb_20220804_86cd3292` |
| 平台 | WorkFine 万应低代码平台 |
| 访问模式 | **只读**，小程序不直接写入 WorkFine |
| SQL Server 驱动 | `mssql`（node-mssql）npm 包，仅同步模块使用 |
| MSSQL 连接池 | 同步时按需建立，业务函数不维护常驻连接 |

---

## 3. 数据分布策略

### 3.1 同步域与导入域划分

| 类别 | 数据域 | WorkFine 源表 | PG 目标表 | 策略 |
|------|--------|--------------|-----------|------|
| **定期同步** | 组织架构 | UDT_M_219 | `org_nodes` + `stores` | 每日全量同步（先建 org_nodes 层级，再同步 stores 详情） |
| **定期同步** | 员工信息 | UDT_S_287 | `employees` | 每日全量同步 |
| **定期同步** | 顾客档案 | UDT_S_311 | `customers` | 每日全量同步 |
| **定期同步** | 提成比例矩阵 | UDT_S_1962 + UDT_M_1964 | `commission_rate_matrix` | 每日全量同步 |
| **一次性导入** | 品项分类 | UDT_M_229 | `product_categories` | 导入后手动维护 |
| **一次性导入** | 可售项目 | UDT_M_1281 + UDT_M_1383 | `products` + `product_skus` | 导入后手动维护 |
| **一次性导入** | 院装产品 | UDT_M_341 | `products` + `product_skus` | 导入后手动维护 |
| **一次性导入** | 促销方案 | UDT_S_1459 + UDT_M_1460 | `products` + `product_skus` | 导入后手动维护 |

### 3.2 不同步的 WorkFine 表

| WorkFine 表 | 说明 | 原因 |
|-------------|------|------|
| UDT_M_312 | 顾客消费明细子表 | WorkFine 内部汇总视图，小程序从 PG 订单表查询 |
| UDT_M_331 | 顾客护理明细子表 | 同上，从 PG 护理单表查询 |
| UDT_S_209 / UDT_M_213 | 分院销售单 | PG 已建立原生订单表，WorkFine 仅历史查阅 |
| UDT_S_259 / UDT_M_260 | 售后护理单 | PG 已建立原生护理单表 |
| UDT_S_762 / UDT_M_763 | 售前护理单 | 同上 |
| UDT_M_217 | 营业额分配明细 | PG 已建立原生分配表 |
| UDT_M_1259 | 收款方式明细 | PG 订单表已包含支付信息 |

---

## 4. 同步机制

### 4.1 同步方向

WorkFine（上游权威源） → PG（本地工作副本），**单向只读同步**。

### 4.2 触发方式

| 触发方式 | 说明 |
|----------|------|
| 定时全量同步 | 每日凌晨自动执行一次全量同步（覆盖所有域） |
| 手动触发 | 员工端管理 API `sync.full`，店长权限，按需触发全量同步 |
| 冷启动预检 | 云函数冷启动时检查 `updated_at`，若超过 24 小时则触发增量同步 |

### 4.3 同步顺序（存在依赖）

```
1. org_nodes（组织架构树）— 无依赖
2. stores（门店详情）— 依赖 org_nodes
3. employees（员工）— 依赖 stores
4. customers（顾客档案）— 依赖 stores
5. commission_rate_matrix（提成比例）— 无依赖
```

### 4.4 同步规则

| 规则 | 说明 |
|------|------|
| 匹配键 | 以 WorkFine 主键（员工编号/顾客编号/门店名）为匹配键 |
| UPSERT | 存在则更新，不存在则插入（`INSERT ... ON CONFLICT ... DO UPDATE`） |
| 不物理删除 | PG 侧不删除 WorkFine 中已不存在的记录（软标记：员工 `is_resigned = true`，门店 `is_closed = true`） |
| 时间戳 | UPSERT 时自动更新 `updated_at` 时间戳 |
| 事务 | 每个域的同步在独立事务中执行，单域失败不影响其他域 |
| 不锁表 | 使用 UPSERT 而非 DELETE + INSERT，同步期间不影响业务读取 |
| 错误处理 | 失败时回滚并记录错误日志 |

### 4.5 org_nodes 同步附加逻辑：组织架构树生成

同步脚本在读取 WorkFine 门店数据后，自动构建 org_nodes 层级树：
1. UPSERT 根节点：`type='headquarters', name='总部', parent_id=NULL`
2. 遍历现有门店的 `market_name` 去重，为每个市场 UPSERT 一条 `type='market'` 节点（`parent_id` 指向总部）
3. 为每个门店 UPSERT 一条 `type='store'` 节点（`parent_id` 指向所属市场节点，`parent_name` 写入市场名）
4. org_nodes 节点作为 `permission_roles.scope_id` 的 FK 目标（替代原 stores 虚拟条目方案）
5. stores 表仅存 `type='store'` 的门店业务详情，通过 `org_node_id` 关联对应 org_nodes 节点

### 4.6 permission_roles 自动推导

员工同步完成后，同步脚本遍历 `employees`（`is_resigned = false`），自动推导权限角色：

| 推导规则 | role | scope_id（→ org_nodes.id） |
|----------|------|----------|
| `position_name = '门店经理'` | `manager` | 员工所在门店对应的 org_nodes 节点 |
| `org_node_name = '财智部'`（通过 org_node_id JOIN org_nodes） | `finance` | 员工所在门店对应的 org_nodes 节点 |
| `position_name = '市场总监'` 或 `'片区经理'` | `manager` | 员工所属市场对应的 org_nodes 节点 |
| 其他 | `staff` | 员工所在门店对应的 org_nodes 节点 |

- `created_by = 'sync'` 标记为同步脚本自动创建
- 代理经理（position_name 包含"代理"）默认推导为 `role=staff`，需手动升级
- 已手动分配的记录（`created_by != 'sync'`）不被同步脚本覆盖

---

## 5. 架构收益

全部数据域迁移到 PG 后的关键收益：

| 收益 | 说明 |
|------|------|
| **运行时零 MSSQL 依赖** | clientApi / staffApi 业务请求 100% 走 PG，不再运行时连接 SQL Server |
| **WorkFine 故障不影响业务** | MSSQL 不可用时，仅同步模块受影响，所有在线查询正常 |
| **查询性能提升** | PG 本地查询取代远程 MSSQL 查询，可建索引优化 |
| **取消价格缓存** | 不再需要 5 分钟 TTL 模块级缓存（原为减轻 MSSQL 压力） |
| **MSSQL 连接池仅限同步** | 同步时按需建立，业务函数不维护常驻连接 |
| **商品数据自包含** | 价格/次数直接存在 PG 商品表中，无需运行时 JOIN 或查询 WorkFine |

---

## 6. WorkFine → PG 字段映射（定期同步域）

### 6.1 门店（UDT_M_219 → PG `org_nodes` + `stores`）

**来源**: Form 216，UDT_S_218（市场门店对应表主表）→ UDT_M_219（门店列表子表，一对多）

**同步流程**: 先构建 org_nodes 层级树，再同步 stores 详情。

#### org_nodes 层级构建

| 步骤 | org_nodes 操作 |
|------|---------------|
| 1 | UPSERT 根节点：`type='headquarters', name='总部', parent_id=NULL` |
| 2 | 遍历 `UDF_M_437`（市场）去重，UPSERT `type='market'` 节点，`parent_id` → 总部，`parent_name='总部'` |
| 3 | 为每个门店 UPSERT `type='store'` 节点，`parent_id` → 所属市场节点，`parent_name` → 市场名 |

#### stores 字段映射

| WorkFine 字段 | 含义 | 类型 | → PG `stores` 字段 |
|---------------|------|------|-------------------|
| UDF_M_437 | 市场 | 文本 | `market_name`（冗余） |
| UDF_M_438 | **门店** | 文本 | `store_name` (UNIQUE) |
| UDF_M_1777 | 开业时间 | 日期 | `opening_date` |
| UDF_M_8590 | 可用床位 | 整数 | `bed_count` |
| UDF_M_11956 | 是否停止营业 | 文本 | `is_closed`（'是' → true） |
| — | 关联 org_nodes | — | `org_node_id`（查找对应 type='store' 的 org_nodes.id 写入） |

**匹配键**: `UDF_M_438`（门店名）→ `store_name`

**常用查询条件**: `WHERE UDF_M_11956 != '是'` → PG: `WHERE is_closed = false`

### 6.2 员工（UDT_S_287 → PG `employees`）

**来源**: Form 264，数据量 2,846 条（含在职 + 离职）

| WorkFine 字段 | 含义 | 类型 | → PG `employees` 字段 |
|---------------|------|------|----------------------|
| UDF_S_1147 | **员工编号** | 文本 | `employee_id` (PK) |
| UDF_S_1155 | 姓名 | 文本 | `name` |
| UDF_S_1148 | 性别 | 文本 | `gender` |
| UDF_S_1152 | 手机号码 | 手机 | `phone` |
| UDF_S_1154 | 身份证号码 | 身份证 | `id_card`（高敏 PII，需评估加密方案） |
| UDF_S_1163 | 所属分院 | 文本 | → 查找 `stores.store_name` 匹配后写入 `store_id` |
| UDF_S_1160 | 所属市场 | 文本 | → 辅助匹配 stores（不再冗余存储） |
| UDF_S_1513 | 职能部门 | 文本 | → 查找 `org_nodes`（type='department'）匹配后写入 `org_node_id`；同时冗余写入 `org_node_name`（部门名）和 `org_parent_node_name`（部门父节点名） |
| UDF_S_1161 | 工作职位 | 文本 | `position_name` |
| UDF_S_1149 | 出生日期 | 日期 | `birthday` |
| UDF_S_1624 | 是否离职 | 文本 | `is_resigned`（'是' → true） |
| UDF_S_1150 | 年龄 | 整数 | — 不同步（非核心） |

**不再同步的字段**: UDF_S_1164（第二工作职位）、UDF_S_12921（第二部门）、UDF_S_10085/UDF_S_10086（职级）、UDF_S_1159（试用开始时间）、UDF_S_1162（转正日期）、UDF_S_1626（离职日期）

**手动维护字段（不来自 WorkFine）**: `skills`（技能标签数组），由员工端手动编辑，同步时不覆盖

**匹配键**: `UDF_S_1147`（员工编号）→ `employee_id`

**store_id 映射**: 同步脚本读取 UDF_S_1163（所属分院），通过 `store_name` 查找 PG stores 表得到 `store_id` 写入。`market_name` 不再冗余存储于 employees，需要时通过 JOIN stores 获取。

**常用查询条件**:
- 在职员工: `WHERE UDF_S_1624 = '否'` → PG: `WHERE is_resigned = false`
- 门店经理: `WHERE UDF_S_1161 = '门店经理'` → PG: `WHERE position_name = '门店经理'`

### 6.3 顾客档案（UDT_S_311 → PG `customers`）

**来源**: Form 295，数据量 51,117 条

#### 表间关联

```
UDT_S_311（顾客档案主表）
  ├── RID ──→ UDT_M_312（消费明细，一对多）— 不同步
  └── RID ──→ UDT_M_331（护理明细，一对多）— 不同步
```

#### 字段映射

| WorkFine 字段 | 含义 | 类型 | → PG `customers` 字段 |
|---------------|------|------|----------------------|
| UDF_S_1475 | **顾客编号** | 文本 | `customer_id` (PK) |
| UDF_S_1476 | 顾客姓名 | 文本 | `name` |
| UDF_S_1478 | 手机号码 | 手机 | `phone` (UNIQUE) |
| UDF_S_1480 | 年龄 | 整数 | `age` |
| UDF_S_6443 | 所属分院 | 文本 | → 查找 `stores.store_name` 匹配后写入 `store_id` |
| UDF_S_6486 | 所属市场 | 文本 | → 辅助匹配 stores（不再冗余存储） |
| UDF_S_6444 | 所属美容师 | 文本 | `primary_beautician` |
| UDF_S_1477 | 会员等级 | 文本 | `member_level` |
| UDF_S_6446 | 顾客来源 | 文本 | `customer_source` |
| UDF_S_1712 | 顾客分类 | 文本 | `category` |
| UDF_S_1479 | 生日 | 日期 | `birthday` |
| UDF_S_1481 | 职业 | 文本 | `occupation` |
| UDF_S_1482 | 是否已婚 | 文本 | `is_married` |
| UDF_S_6445 | 微信名 | 文本 | `wechat_name` |
| UDF_S_1474 | 登记时间 | 日期 | `registered_at` |
| UDF_S_6447 | 肤质类型 | 文本 | `skin_type` |
| UDF_S_6448 | 改善重点 | 文本 | `improvement_focus` |
| UDF_S_19093 | 皮肤问题 | 文本 | `skin_issue` |
| UDF_S_19094 | 接受养生方式 | 文本 | `wellness_preference` |

**不再同步的字段**: UDF_S_18105（会员分类标签）、UDF_S_1486（是否共享）、UDF_S_1717（累计消费金额）、UDF_S_1718（单笔最高金额）、UDF_S_17850（未到店时间间隔）、UDF_S_17758～UDF_S_17858（年度消费档位/累计消费）

**匹配键**: `UDF_S_1475`（顾客编号）→ `customer_id`

**store_id 映射**: 同步脚本读取 UDF_S_6443（所属分院），查找 stores.store_id 写入。`market_name` 不再冗余存储，需要时 JOIN stores 获取。

#### 顾客消费明细子表 — UDT_M_312（不同步）

每位顾客的购买记录明细，通过 `RID` 关联主表 UDT_S_311。关联 `UDF_M_1499`（销售流水号）= `UDT_M_213.UDF_M_852`。

| 字段名 | 含义 | 类型 | 说明 |
|--------|------|------|------|
| UDF_M_1494 | 所属市场 | 文本 | — |
| UDF_M_1495 | 所属门店 | 文本 | — |
| UDF_M_1496 | 销售日期 | 日期 | — |
| UDF_M_1497 | 业绩类型 | 文本 | 售前一次 / 售后 / 老带新等 |
| UDF_M_1498 | 销售单号 | 文本 | 关联 UDT_S_209.UDF_S_372 |
| UDF_M_1499 | 销售流水号 | 文本 | 关联 UDT_M_213.UDF_M_852 |
| UDF_M_1500 | 品项分类 | 文本 | — |
| UDF_M_1501 | 项目名称 | 文本 | — |
| UDF_M_1502 | 疗程服务次数 | 金额 | — |
| UDF_M_1503 | 销售金额 | 金额 | — |
| UDF_M_1504 | 单价优惠 | 金额 | — |

#### 顾客护理明细子表 — UDT_M_331（不同步）

每位顾客的到店护理记录，通过 `RID` 关联主表 UDT_S_311。关联 `UDF_M_1752`（护理单编号）。

| 字段名 | 含义 | 类型 | 说明 |
|--------|------|------|------|
| UDF_M_1748 | 所属市场 | 文本 | — |
| UDF_M_1749 | 所属门店 | 文本 | — |
| UDF_M_1750 | 服务日期 | 日期 | — |
| UDF_M_1751 | 顾客类型 | 文本 | — |
| UDF_M_1752 | 护理单编号 | 文本 | 关联 UDT_S_259/UDT_S_762 |
| UDF_M_1753 | 项目名称 | 文本 | — |
| UDF_M_1754 | 划卡次数 | 金额 | — |
| UDF_M_1755 | 员工职位 | 文本 | — |
| UDF_M_1756 | 员工姓名 | 文本 | — |
| UDF_M_1757 | 服务费 | 金额 | — |

### 6.4 提成比例矩阵（UDT_S_1962 + UDT_M_1964 → PG `commission_rate_matrix`）

> **WorkFine 字段详情待补充**: UDT_S_1962 + UDT_M_1964 的具体字段未记录，PG 设计基于已知维度（市场、部门、销售分类、金额阶段、比例）。待 WorkFine 表结构补充后调整映射。

---

## 7. 商品域一次性导入方案

> 商品域从 WorkFine 一次性导入后由员工手动维护，**不再定期同步**。以下 WorkFine 表结构作为导入脚本参考。

### 7.1 品项分类（UDT_M_229 → PG `product_categories`）

子表 38 条（21 种当前可用）。

| 字段名 | 含义 | → PG `product_categories` 字段 |
|--------|------|------|
| UDF_M_521 | 序号 | `sort_order` |
| UDF_M_522 | 项目类型 | `category_name` |
| UDF_M_15996 | 是否可用 | `is_valid`（'是' → true） |
| UDF_M_17416 | 大分类 | → 导入时根据业务含义映射为 `product_kind` 枚举 |

**枚举映射**: 原 `big_category` 的 `生美` / `非生美` 不再使用，导入时根据实际业务含义映射为 `product_kind`（`福利活动` / `护理项目` / `家居产品` / `充值卡`）。

**当前可用品项分类（21 种）**: 缦之羽、蜜语生玑、中华神灸、歆笙泰妍、圣源养心、悠妃曼、美芯、安吉丽美颜之爱、科颜美、诺纤金、自定义-生美、自定义-单品、自定义-KS、自定义-SM、自定义-YM、娇莉芙-生美、娇莉芙-家居产品、娇莉芙-招牌、娇莉芙-王牌、娇莉芙-改变、娇莉芙-对外合作。

### 7.2 院装产品（UDT_S_340 主表 + UDT_M_341 子表 → PG `products` + `product_skus`）

院装产品供应商档案（19 条），子表为产品明细（1,940 条）。

**UDT_M_341 关键字段**:

| 字段名 | 含义 | 类型 | → PG 导入目标 |
|--------|------|------|------|
| UDF_M_1870 | **商品编号** | 文本 | 导入参考（不保留在 PG 中） |
| UDF_M_1871 | 名称 | 文本 | `products.name` |
| UDF_M_1872 | 规格 | 文本 | `product_skus.spec_name` |
| UDF_M_12636 | 品牌 | 文本 | — 不保留 |
| UDF_M_1874 | 产品系列 | 文本 | — 不保留 |
| UDF_M_1875 | 顾客零售价 | 金额 | `product_skus.price` |
| UDF_M_1876 | 核算价 | 金额 | — 不保留 |
| UDF_M_7494 | 是否可报货 | 文本 | `product_skus.is_active`（'是' → true） |

**导入规则**: 每条院装产品生成一条 `products`（product_kind='家居产品'）+ 一条 `product_skus`（product_type='院装产品'）。

### 7.3 可售项目（UDT_S_1280 主表 + UDT_M_1281 子表 → PG `products` + `product_skus`）

面向顾客的服务项目/疗程卡目录，按有效期版本管理。主表 16 条，子表 481 条。

**UDT_M_1281 关键字段**:

| 字段名 | 含义 | 类型 | → PG 导入目标 |
|--------|------|------|------|
| UDF_M_14503 | **疗程项目编号** | 文本 | 导入参考（不保留在 PG 中） |
| UDF_M_14502 | 产品库 | 文本 | `product_skus.product_type`（疗程卡/单品） |
| UDF_M_14504 | 品项分类 | 文本 | → 匹配 `product_categories.category_name` → `products.category_id` |
| UDF_M_14505 | 项目名称 | 文本 | `products.name` |
| UDF_M_14506 | 疗程服务次数 | 整数 | `product_skus.session_count` |
| UDF_M_14508 | 原价 | 金额 | `product_skus.price` / `products.price` |
| UDF_M_17783 | 是否生美 | 文本 | `products.is_shengmei`（'生美' → true） |
| UDF_M_17477 | 招牌定位 | 文本 | — 参考 |

**导入规则**:
- 产品库 = "疗程卡" → `product_type='疗程卡'`，核销流程
- 产品库 = "单品" → `product_type='单品'`，支付即结束
- 同一品项分类+项目名称可合并为一条 `products`，不同规格（次数/价格）各生成一条 `product_skus`

### 7.4 门店自定义项目（UDT_S_1382 主表 + UDT_M_1383 子表 → PG `products` + `product_skus`）

主表 35 条，子表 401 条。字段与 UDT_M_1281 高度一致，增加市场/门店范围字段。导入至 `products` + `product_skus`，`products.manage_scope` / `products.market_scope` 写入门店/市场范围。

### 7.5 促销方案（UDT_S_1459 主表 + UDT_M_1460 子表 → PG `products` + `product_skus`）

主表 56 条，子表 285 条。

**UDT_S_1459 关键字段** → PG `products`:

| WorkFine 字段 | 含义 | → PG 导入目标 |
|---------------|------|-----------|
| UDF_S_17159 | 促销单编号 | 导入参考（不保留在 PG 中） |
| UDF_S_17175 | 方案名 | `products.name` |
| UDF_S_17193 | 方案售价 | `products.price` |
| UDF_S_17793 | 促销范围 | `products.market_scope` |

**UDT_M_1460 关键字段** → PG `product_skus`:

| WorkFine 字段 | 含义 | → PG 导入目标 |
|---------------|------|-----------|
| UDF_M_17163 | 疗程项目编号（关联 UDT_M_1281） | 导入参考（匹配已导入的 SKU） |
| UDF_M_17171 | 促销售价 | `product_skus.price` |
| UDF_M_17174 | 是否赠送 | `product_skus.price = 0`（赠品） |

**导入规则**: 每条促销方案生成一条 `products`（is_bundle=true, product_kind='福利活动'），方案明细各生成一条 `product_skus`（is_bundle_sku=true）。赠品项的 `price = 0`。

---

## 8. WorkFine → PG 同步交叉引用

```
WorkFine → PG 定期同步（组织与人员域）:
  UDT_M_219 (门店)            ──sync──→ PG org_nodes + stores
  UDT_S_287 (员工)            ──sync──→ PG employees
  UDT_S_311 (顾客)            ──sync──→ PG customers
  UDT_S_1962/UDT_M_1964 (提成) ──sync──→ PG commission_rate_matrix

WorkFine → PG 一次性导入（商品域，后续手动维护）:
  UDT_M_229 (品项分类)         ──import──→ PG product_categories
  UDT_M_1281 + UDT_M_1383 (可售项目) ──import──→ PG products + product_skus
  UDT_M_341 (院装产品)         ──import──→ PG products + product_skus
  UDT_S_1459 + UDT_M_1460 (促销) ──import──→ PG products (is_bundle=true) + product_skus (is_bundle_sku=true)
```

---

## 9. WorkFine 参考结构（不同步，仅历史查阅）

以下 WorkFine 表对应的 PG 实体已独立建立，WorkFine 数据仅供历史查阅参考。

### 9.1 分院销售单主表 — UDT_S_209（Form 210，62,119 条）

| 字段名 | 含义 | 类型 | 说明 |
|--------|------|------|------|
| UDF_S_372 | **销售单号** | 文本 | 主键，格式 FY-XSD{YYMMDD}{序号} |
| UDF_S_348 | 市场 | 文本 | — |
| UDF_S_349 | 门店 | 文本 | — |
| UDF_S_350 | 日期 | 日期 | — |
| UDF_S_371 | 业绩类型 | 文本 | 售后 / 售前一次等 |
| UDF_S_1485 | 顾客编号 | 文本 | 关联 UDT_S_311.UDF_S_1475 |
| UDF_S_370 | 顾客姓名 | 文本 | 冗余存储 |
| UDF_S_507 | 收款合计 | 金额 | — |
| UDF_S_17178 | 促销方案选取 | 文本 | 关联 UDT_S_1459.UDF_S_17159 |
| UDF_S_844 | 本单业绩 | 金额 | — |
| UDF_S_4729 | 本单欠款合计 | 金额 | — |
| UDF_S_13710 | 销售类型 | 文本 | 全额销售 / 回单销售 |
| UDF_S_17315 | 是否锁客 | 文本 | — |
| UDF_S_18162 | 是否纳客 | 文本 | — |

### 9.2 销售明细子表 — UDT_M_213

| 字段名 | 含义 | 类型 | 说明 |
|--------|------|------|------|
| UDF_M_852 | **销售流水号** | 文本 | 主键，格式 XSLSH-{YYYYMMDD}{序号} |
| UDF_M_4728 | 产品类型 | 文本 | 疗程卡 / 单品 / 自定义-疗程 / 自定义-单品 |
| UDF_M_14495 | 疗程项目编号 | 文本 | 关联 UDT_M_1281 |
| UDF_M_392 | 品项分类 | 文本 | — |
| UDF_M_393 | 项目名称 | 文本 | — |
| UDF_M_394 | 疗程服务次数 | 整数 | — |
| UDF_M_4949 | 原价 | 金额 | — |
| UDF_M_14494 | 销售数量 | 金额 | — |
| UDF_M_396 | 单价优惠 | 金额 | — |
| UDF_M_395 | 销售金额 | 金额 | 优惠后 |
| UDF_M_398 | 应收金额 | 金额 | — |
| UDF_M_399 | 实收金额 | 金额 | — |
| UDF_M_4939 | 赠送 | 文本 | 是 / 否 |
| UDF_M_7122 | 有效日期 | 日期 | — |
| UDF_M_4938 | 单次价格 | 金额 | — |
| UDF_M_400 | 顾客欠款 | 金额 | — |

### 9.3 营业额分配明细子表 — UDT_M_217

| 字段名 | 含义 | 类型 | 说明 |
|--------|------|------|------|
| UDF_M_2316 | 员工编号 | 文本 | 关联 UDT_S_287.UDF_S_1147 |
| UDF_M_419 | 员工姓名 | 文本 | — |
| UDF_M_418 | 职位 | 文本 | — |
| UDF_M_13713 | 职位所属部门 | 文本 | — |
| UDF_M_13714 | 部门代码 | 文本 | — |
| UDF_M_420 | 个人业绩1眉眼 | 金额 | — |
| UDF_M_421 | 个人业绩2唇 | 金额 | — |
| UDF_M_422 | 祛斑点痣业绩 | 金额 | — |
| UDF_M_423 | 单品业绩 | 金额 | — |
| UDF_M_13715 | 核算金额 | 金额 | — |

### 9.4 收款方式明细子表 — UDT_M_1259

| 字段名 | 含义 | 类型 | 说明 |
|--------|------|------|------|
| UDF_M_14335 | 收款方式 | 文本 | 现金 / 扫码 / 刷卡 / 抖音收款 / 美团收款 / 第三方收款 |
| UDF_M_14336 | 金额 | 金额 | — |
| UDF_M_14337 | 说明 | 文本 | — |

### 9.5 售前护理单（Form 763，84,096 条）

记录顾客**购买前**的体验/引流服务。

**主表 UDT_S_762 关键字段**: `UDF_S_821`（护理单编号）、`UDF_S_822`（服务日期）、`UDF_S_1491`（顾客编号）、`UDF_S_843`（预约/到店时间，售前独有）。

**子表 UDT_M_763 关键字段**: `UDF_M_835`（项目名称）、`UDF_M_4904`（拓客卡流水号，`TKKLS-` 前缀）、`UDF_M_836`（划卡次数）、`UDF_M_2472`（员工编号）。

### 9.6 售后护理单（Form 246，463,841 条）

记录顾客**购买疗程卡后**的每次到店消耗。

**主表 UDT_S_259 关键字段**: `UDF_S_821`（护理单编号）、`UDF_S_822`（服务日期）、`UDF_S_1491`（顾客编号）。

**子表 UDT_M_260 关键字段**: `UDF_M_835`（项目名称）、`UDF_M_4904`（销售流水号，`XSLSH-` 前缀，关联 UDT_M_213 核销疗程卡）、`UDF_M_836`（划卡次数）、`UDF_M_2472`（员工编号）。

### 9.7 售前 vs 售后护理单对比

| 维度 | 售前 (UDT_S_762) | 售后 (UDT_S_259) |
|------|-----------------|-----------------|
| 业务含义 | 购买前体验/引流 | 购买后疗程卡消耗 |
| 主要顾客类型 | 售前一次（87%） | 售后（96%） |
| 明细流水号前缀 | `TKKLS-`（拓客卡） | `XSLSH-`（销售流水号） |
| 是否关联销售单 | 否 | 是（核销疗程卡） |

---

## 10. 数据量参考

| 表 | 记录数 | 同步/导入目标 |
|----|--------|------|
| UDT_S_311 顾客档案 | 51,117 | → PG customers 同步量 |
| UDT_S_287 人事档案 | 2,846 | → PG employees 同步量 |
| UDT_M_219 门店列表 | ~100 | → PG stores 同步量 |
| UDT_S_1962 + UDT_M_1964 提成比例矩阵 | 待查 | → PG commission_rate_matrix 同步量 |
| UDT_M_341 产品明细 | 1,940 | → PG products + product_skus 一次性导入量 |
| UDT_M_1281 可售项目 | 481 | → PG products + product_skus 一次性导入量 |
| UDT_M_1383 门店自定义项目 | 401 | → PG products + product_skus 一次性导入量 |
| UDT_S_1459 促销方案主表 | 56 | → PG products (is_bundle=true) 一次性导入量 |
| UDT_M_1460 促销方案明细 | 285 | → PG product_skus (is_bundle_sku=true) 一次性导入量 |
| UDT_M_229 品项分类 | 38 | → PG product_categories 一次性导入量（21 种当前可用） |
| UDT_S_259 售后护理单 | 463,841 | 不同步（仅参考） |
| UDT_S_762 售前护理单 | 84,096 | 不同步（仅参考） |
| UDT_S_209 分院销售单 | 62,119 | 不同步（仅参考） |

---

## 11. 字段待补充清单

以下 WorkFine 表的字段详情未记录，需查询实际表结构后补充：

| 表 | Form ID | 说明 | 影响 |
|----|---------|------|------|
| UDT_S_218 | 216 | 市场门店对应表主表 | stores 表同步（市场级字段） |
| UDT_S_228 | 222 | 品相类型主表 | product_categories 一次性导入（主表关系） |
| UDT_S_1962 | — | 提成比例矩阵主表 | commission_rate_matrix 同步 |
| UDT_M_1964 | — | 提成比例矩阵子表 | 同上，具体字段待查询 WorkFine |
