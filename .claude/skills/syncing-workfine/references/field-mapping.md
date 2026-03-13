# WorkFine → PG 字段映射速查表

## 1. 门店（UDT_M_219 → org_nodes + stores）

| WorkFine 字段 | 含义 | → PG 字段 | 备注 |
|---------------|------|-----------|------|
| UDF_M_437 | 市场 | org_nodes (type='market') name | 去重后构建市场节点 |
| UDF_M_438 | 门店 | stores.store_name | 匹配键 |
| UDF_M_1777 | 开业时间 | stores.opening_date | 日期 |
| UDF_M_8590 | 可用床位 | stores.bed_count | 整数 |
| UDF_M_11956 | 是否停止营业 | stores.is_closed | '是' → true |
| — | 关联 org_nodes | stores.org_node_id | 查找对应 type='store' 的 org_nodes.id 写入 |

## 2. 员工（UDT_S_287 → employees）

| WorkFine 字段 | 含义 | → PG 字段 | 备注 |
|---------------|------|-----------|------|
| UDF_S_1147 | 员工编号 | employee_id (PK) | 匹配键 |
| UDF_S_1155 | 姓名 | name | |
| UDF_S_1148 | 性别 | gender | |
| UDF_S_1152 | 手机号码 | phone | |
| UDF_S_1154 | 身份证号码 | id_card | 高敏 PII |
| UDF_S_1163 | 所属分院 | → store_id | 查 stores.store_name 匹配 |
| UDF_S_1513 | 职能部门 | → org_node_id | 查 org_nodes(type=department) |
| UDF_S_1161 | 工作职位 | position_name | |
| UDF_S_1149 | 出生日期 | birthday | |
| UDF_S_1624 | 是否离职 | is_resigned | '是' → true |

**不同步的字段：** UDF_S_1164（第二工作职位）、UDF_S_12921（第二部门）、UDF_S_10085/UDF_S_10086（职级）、UDF_S_1159（试用开始时间）、UDF_S_1162（转正日期）、UDF_S_1626（离职日期）、UDF_S_1150（年龄，非核心）。

**手动维护字段（同步不覆盖）：** `skills`（技能标签数组），由员工端手动编辑。

## 3. 顾客档案（UDT_S_311 → client_wechat_users）

| WorkFine 字段 | 含义 | → PG 字段 | varchar 限制 |
|---------------|------|-----------|-------------|
| UDF_S_1475 | 顾客编号 | customer_id | 30 |
| UDF_S_1476 | 顾客姓名 | name | 50 |
| UDF_S_1478 | 手机号码 | phone | **30**（实际最长 23） |
| UDF_S_6443 | 所属分院 | → store_id | 查 stores |
| UDF_S_6444 | 所属美容师 | primary_beautician | 50 |
| UDF_S_1477 | 会员等级 | member_level | 20 |
| UDF_S_6446 | 顾客来源 | customer_source | 50 |
| UDF_S_1712 | 顾客分类 | category | 50 |
| UDF_S_1479 | 生日 | birthday | date |
| UDF_S_1481 | 职业 | occupation | 50 |
| UDF_S_1482 | 是否已婚 | is_married | bool |
| UDF_S_6445 | 微信名 | wechat_name | 50 |
| UDF_S_1474 | 登记时间 | registered_at | date |
| UDF_S_6447 | 肤质类型 | skin_type | 50 |
| UDF_S_6448 | 改善重点 | improvement_focus | 200 |
| UDF_S_19093 | 皮肤问题 | skin_issue | 200 |
| UDF_S_19094 | 接受养生方式 | wellness_preference | 200 |

**UPSERT 三步策略：**
1. 有 phone → `ON CONFLICT (phone) DO UPDATE`（匹配已绑定手机的微信用户或已导入顾客）
2. 无 phone、有 customer_id → `UPDATE ... WHERE customer_id = $1`（更新已有 customer_id 的行）；若无匹配行 → INSERT（openid = null）
3. 无 phone 且无 customer_id → 跳过

**不覆盖字段：** openid, session_key, last_login_at, bound_store_id（微信身份字段）。

**`bound_store_id` vs `store_id` 区分：** `store_id` 是 WorkFine 同步写入的归属门店（UDF_S_6443）；`bound_store_id` 是顾客在小程序中主动绑定的门店，同步不修改。

**age 字段状态：** spec 中有 UDF_S_1480（年龄）→ `age` 映射，但当前 PG schema 无 `age` 列，暂不同步。

**不同步的字段：** UDF_S_18105（会员分类标签）、UDF_S_1486（是否共享）、UDF_S_1717（累计消费金额）、UDF_S_1718（单笔最高金额）、UDF_S_17850（未到店时间间隔）、UDF_S_17758～UDF_S_17858（年度消费档位/累计消费）。

## 4. 品项分类（UDT_M_229 → product_categories）

| WorkFine 字段 | 含义 | → PG 字段 |
|---------------|------|-----------|
| UDF_M_521 | 序号 | sort_order |
| UDF_M_522 | 项目类型 | category_name |
| UDF_M_15996 | 是否可用 | is_valid |
| UDF_M_17416 | 大分类 | → product_kind 枚举映射 |

**product_kind 映射规则：**
- 含"充值" → 充值卡
- 含"家居"/"院装" → 家居产品
- 含"福利"/"促销"/"活动" → 福利活动
- 其他 → 护理项目

## 5. 可售项目（UDT_M_1281 + UDT_M_1383 → products + product_skus）

| WorkFine 字段 | 含义 | → PG 字段 |
|---------------|------|-----------|
| UDF_M_14503 | 疗程项目编号 | hashId 输入 |
| UDF_M_14505 | 项目名称 | products.name |
| UDF_M_14504 | 品项分类 | → products.category_id |
| UDF_M_14506 | 疗程服务次数 | product_skus.session_count |
| UDF_M_14508 | 原价 | product_skus.price |
| UDF_M_14502 | 产品库 | → product_skus.product_type |
| UDF_M_17783 | 是否生美 | products.is_shengmei |

**分组规则：** 同 (category_name, name) → 一条 products，各规格生成 product_skus。

## 6. 院装产品（UDT_M_341 → products + product_skus）

| WorkFine 字段 | 含义 | → PG 字段 |
|---------------|------|-----------|
| UDF_M_1870 | 商品编号 | hashId 输入 |
| UDF_M_1871 | 名称 | products.name |
| UDF_M_1872 | 规格 | product_skus.spec_name |
| UDF_M_1874 | 产品系列 | → category_name 匹配 |
| UDF_M_1875 | 顾客零售价 | product_skus.price |
| UDF_M_7494 | 是否可报货 | 过滤条件（仅导入 '是'） |

**规则：** 每条 1:1 product + sku，product_type='院装产品'。

## 7. 促销方案（UDT_S_1459 + UDT_M_1460 → products + product_skus）

**主表 UDT_S_1459：**

| WorkFine 字段 | → PG products |
|---------------|---------------|
| UDF_S_17159 | hashId 输入 |
| UDF_S_17175 | name |
| UDF_S_17193 | price |
| UDF_S_17793 | market_scope |

**子表 UDT_M_1460：**

| WorkFine 字段 | → PG product_skus |
|---------------|-------------------|
| UDF_M_17163 | hashId 输入 |
| UDF_M_17165 | spec_name |
| UDF_M_17171 | price |
| UDF_M_17174 | 是否赠送 → price=0 |
| UDF_M_17167 | session_count |
| UDF_M_17162 | → product_type |

**规则：** products.is_bundle=true, product_skus.is_bundle_sku=true。

## 8. 权限推导规则（PG 内部，无 MSSQL 查询）

| 条件 | role | scope_id |
|------|------|----------|
| position_name = '门店经理' | manager | 门店 org_node |
| position_name = '市场总监' / '片区经理' | manager | 市场 org_node |
| dept_name = '财智部' | finance | 门店 org_node |
| position_name 含 '代理' | staff | 门店 org_node |
| 其他 | staff | 门店 org_node |

`created_by = 'sync'` 标记自动推导记录；手动创建的不被覆盖。
