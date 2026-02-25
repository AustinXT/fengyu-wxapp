# 前后端联调测试计划

> 测试日期: 2026-02-25
> 测试范围: 客户端小程序 + clientApi 云函数

---

## 一、测试环境确认

### 1.1 云函数部署状态
- [x] clientApi 云函数已部署到 `fengyu-8gz6p2d7f9f54217` (腾讯云 CloudBase)
- [ ] 需要部署到 `cloud1-3gpht4b01ff88838` (微信云开发环境) - **待用户通过微信开发者工具手动部署**

### 1.2 数据库连接
- [ ] PostgreSQL 数据库表结构已创建
- [ ] WorkFine SQL Server 连接测试通过
- [ ] 环境变量已配置

---

## 二、核心接口测试清单

### 2.1 认证模块 (`auth.*`)

#### ✅ auth.login - 微信登录
**测试目的**: 验证新用户注册、老用户登录、最后登录时间更新

**测试步骤**:
1. 首次调用,验证返回 `isNewUser: true`
2. 再次调用,验证返回 `isNewUser: false` 且 `lastLoginAt` 已更新

**预期结果**:
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "isNewUser": true/false,
    "userId": "user_xxx",
    "phone": null,
    "boundStoreName": null
  }
}
```

**数据库验证**:
```sql
SELECT * FROM client_wechat_users WHERE openid = 'xxx';
```

---

#### ✅ auth.bindPhone - 绑定手机号
**测试目的**: 验证手机号绑定、历史订单补全机制

**测试步骤**:
1. 先创建一个员工开单(无 client_user_id,仅 client_phone)
2. 调用 `bindPhone` 绑定相同手机号
3. 验证返回 `updatedOrdersCount > 0`
4. 查询订单表确认 `client_user_id` 已补全

**预期结果**:
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "success": true,
    "userId": "user_xxx",
    "phone": "13800138000",
    "updatedOrdersCount": 1
  }
}
```

**数据库验证**:
```sql
SELECT client_user_id FROM orders WHERE client_phone = '13800138000';
```

---

### 2.2 门店模块 (`store.*`)

#### ✅ store.list - 门店列表
**测试目的**: 验证从 WorkFine 查询门店数据

**测试步骤**:
1. 调用接口获取门店列表
2. 验证返回数据包含市场名、门店名、开业时间等字段
3. 验证已停止营业的门店已被排除

**预期结果**:
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "stores": [
      {
        "market_name": "南商市场",
        "store_name": "南昌梦祥店",
        "open_date": "2020-01-01",
        "available_beds": 10,
        "store_region": "江西"
      }
    ]
  }
}
```

**WorkFine 验证**:
```sql
SELECT UDF_M_437, UDF_M_438 FROM UDT_M_219 WHERE UDF_M_11956 != '是';
```

---

### 2.3 商品模块 (`product.*`)

#### ✅ product.categories - 品项分类列表
**测试目的**: 验证从 PG 动态派生分类,仅显示含有效 SKU 的分类

**测试步骤**:
1. 在 `product_spu` 和 `product_spu_sku_map` 插入测试数据
2. 调用接口获取分类列表
3. 验证分类按 `sort_order` 排序
4. 验证院装产品分类在末尾

**预期结果**:
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "categories": [
      {
        "category": "蜜语生玑",
        "big_category": "生美",
        "category_order": 1
      },
      {
        "category": "院装产品",
        "big_category": "院装产品",
        "category_order": 999
      }
    ]
  }
}
```

---

#### ✅ product.spuList - SPU 列表
**测试目的**: 验证 PG 查询 SPU + WorkFine 实时读取 SKU 价格

**测试步骤**:
1. 调用接口,传入 `category` 参数
2. 验证返回 SPU 列表包含 `skuList` 和 `priceFrom`
3. 验证 SKU 价格来自 WorkFine (`originalPrice`, `sessionCount`)

**预期结果**:
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "spuList": [
      {
        "spu_id": "spu_xxx",
        "name": "蜜语生玑精华护理",
        "category": "蜜语生玑",
        "big_category": "生美",
        "priceFrom": 298,
        "skuList": [
          {
            "sku_id": "sku_xxx",
            "sku_display_name": "10次卡",
            "originalPrice": 2980,
            "sessionCount": 10,
            "isShengmei": "生美"
          }
        ]
      }
    ]
  }
}
```

**WorkFine 验证**:
```sql
SELECT UDF_M_14503, UDF_M_14505, UDF_M_14506, UDF_M_14508
FROM UDT_M_1281
WHERE UDF_M_14503 = '疗程项目编号';
```

---

#### ✅ product.skuDetail - SKU 详情
**测试目的**: 验证实时从 WorkFine 读取价格/次数

**测试步骤**:
1. 调用接口,传入 `skuId` 参数
2. 验证返回 SKU 详情包含 SPU 名称、价格、次数等信息

**预期结果**:
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "sku": {
      "sku_id": "sku_xxx",
      "spu_id": "spu_xxx",
      "spu_name": "蜜语生玑精华护理",
      "sku_display_name": "10次卡",
      "workfine_item_id": "MYSJ001",
      "workfine_source": "UDT_M_1281",
      "product_type": "疗程卡",
      "originalPrice": 2980,
      "sessionCount": 10,
      "isShengmei": "生美"
    }
  }
}
```

---

### 2.4 员工模块 (`staff.*`)

#### ✅ staff.list - 美容师列表
**测试目的**: 验证从 WorkFine 查询在职美容师

**测试步骤**:
1. 调用接口,传入 `storeName` 参数
2. 验证返回员工列表包含姓名、职位、编号等字段
3. 验证已离职员工已被排除

**预期结果**:
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "staff": [
      {
        "employee_id": "FY-20200101001",
        "name": "张三",
        "position": "美容师",
        "department": "美容部",
        "store_name": "南昌梦祥店"
      }
    ]
  }
}
```

**WorkFine 验证**:
```sql
SELECT UDF_S_1147, UDF_S_1155, UDF_S_1161, UDF_S_1513
FROM UDT_S_287
WHERE UDF_S_1624 = '否' AND UDF_S_1163 = '南昌梦祥店';
```

---

## 三、数据一致性测试

### 3.1 WorkFine 数据对照测试

**测试方法**: 随机抽取 10 条数据,对比 WorkFine 查询结果与云函数返回结果

| 数据类型 | WorkFine 表 | 验证字段 |
|---------|-----------|---------|
| 门店 | UDT_M_219 | 市场、门店名、开业时间 |
| 员工 | UDT_S_287 | 员工编号、姓名、职位 |
| 可售项目 | UDT_M_1281 | 疗程项目编号、项目名称、原价、服务次数 |
| 院装产品 | UDT_M_341 | 商品编号、名称、规格、零售价 |

---

## 四、边界场景测试

### 4.1 参数校验
- [ ] 缺少必填参数时返回明确错误提示
- [ ] 无效参数值时返回明确错误提示

### 4.2 数据不存在
- [ ] 查询不存在的 SKU 时返回 `SKU 不存在` 错误
- [ ] 查询不存在的门店时返回空列表

### 4.3 并发测试
- [ ] 同一用户同时多次调用 `login` 不会创建重复记录
- [ ] 同一手机号被多个用户绑定时被拒绝

---

## 五、测试数据准备

### 5.1 PostgreSQL 初始化数据

```sql
-- 1. 插入测试 SPU
INSERT INTO product_spu (spu_id, name, category, big_category, cover_image, sort_order)
VALUES
  ('spu_test_001', '蜜语生玑精华护理', '蜜语生玑', '生美', 'https://xxx.jpg', 1),
  ('spu_test_002', '院装护肤套装', '院装产品', '院装产品', 'https://yyy.jpg', 999);

-- 2. 插入测试 SKU 映射
INSERT INTO product_spu_sku_map (sku_id, spu_id, workfine_item_id, workfine_source, product_type, sku_display_name, sort_order, is_active)
VALUES
  ('sku_test_001', 'spu_test_001', 'MYSJ001', 'UDT_M_1281', '疗程卡', '10次卡', 1, true),
  ('sku_test_002', 'spu_test_002', 'MZHAJL0910-015', 'UDT_M_341', '院装产品', '285ml/瓶', 1, true);

-- 3. 插入测试订单(用于手机号补全测试)
INSERT INTO orders (order_no, status, market_name, store_name, order_datetime, client_phone, payment_method, order_source)
VALUES
  ('FY-XSD-WX-250225001', '待支付', '南商市场', '南昌梦祥店', '2026-02-25 10:00:00', '13800138000', 'wechat', 'staff');
```

---

## 六、测试执行清单

### 6.1 基础功能测试
- [ ] auth.login - 新用户注册
- [ ] auth.login - 老用户登录
- [ ] auth.bindPhone - 手机号绑定
- [ ] auth.bindPhone - 历史订单补全
- [ ] store.list - 门店列表
- [ ] product.categories - 品项分类
- [ ] product.spuList - SPU 列表(含 WorkFine 价格)
- [ ] product.skuDetail - SKU 详情
- [ ] staff.list - 美容师列表

### 6.2 数据一致性测试
- [ ] WorkFine 门店数据对照
- [ ] WorkFine 员工数据对照
- [ ] WorkFine 商品价格对照
- [ ] WorkFine 院装产品对照

### 6.3 边界场景测试
- [ ] 参数校验
- [ ] 数据不存在
- [ ] 并发测试

---

## 七、问题记录

| # | 问题描述 | 影响范围 | 优先级 | 状态 |
|---|---------|---------|-------|------|
| 1 | 云函数未部署到微信云开发环境 `cloud1-3gpht4b01ff88838` | 阻塞 | P0 | 待解决 |
| 2 | PostgreSQL 表结构未初始化 | 阻塞 | P0 | 待解决 |
| 3 | 环境变量未配置(数据库连接串) | 阻塞 | P0 | 待解决 |

---

## 八、下一步行动

### 8.1 立即执行
1. **部署云函数**: 通过微信开发者工具将 `clientApi` 部署到 `cloud1-3gpht4b01ff88838`
2. **初始化数据库**: 执行 Drizzle 迁移创建 PG 表结构
3. **配置环境变量**: 设置 PostgreSQL 和 WorkFine 连接串

### 8.2 联调准备
1. 准备测试数据(见 5.1)
2. 编写自动化测试脚本
3. 准备小程序前端测试页面

### 8.3 正式测试
1. 按照测试清单逐项执行
2. 记录问题并修复
3. 回归测试

---

## 九、验收标准

- [ ] 所有核心接口返回数据格式正确
- [ ] WorkFine 数据查询准确率 100%
- [ ] PostgreSQL 数据写入无丢失
- [ ] 参数校验覆盖率 100%
- [ ] 无阻塞性 Bug
