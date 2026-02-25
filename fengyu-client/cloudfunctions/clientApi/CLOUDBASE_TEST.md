# CloudBase 云函数测试指南

## 测试准备

1. 打开微信开发者工具
2. 点击"云开发"按钮进入 CloudBase 控制台
3. 左侧菜单选择"云函数"
4. 找到 `clientApi` 函数
5. 点击"测试"按钮进入测试面板

---

## 测试 1: 商品分类接口

### 测试目的
验证能否正确获取商品分类列表(生美、非生美、院装产品)

### 测试参数
```json
{
  "action": "product.categories",
  "payload": {}
}
```

### 预期结果
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
        "category": "其他分类",
        "big_category": "非生美",
        "category_order": 10
      },
      {
        "category": "院装产品",
        "big_category": "院装产品",
        "category_order": 100
      }
    ]
  }
}
```

### 验证点
- ✅ 返回 `code: 0` (成功)
- ✅ 包含 `categories` 数组
- ✅ 每个分类包含 `category`、`big_category`、`category_order` 字段
- ✅ 大分类包含: "生美"、"非生美"、"院装产品"
- ✅ 分类按 `category_order` 升序排列

---

## 测试 2: 商品列表接口

### 测试目的
验证能否正确获取生美分类下的商品列表,并从 WorkFine 实时读取价格

### 测试参数
```json
{
  "action": "product.spuList",
  "payload": {
    "bigCategory": "生美"
  }
}
```

### 预期结果
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
        "cover_image": "https://...",
        "description": "商品描述",
        "sort_order": 1,
        "priceFrom": 2980,
        "skuList": [
          {
            "sku_id": "sku_xxx",
            "workfine_item_id": "ITEM_001",
            "workfine_source": "UDT_M_1281",
            "product_type": "疗程卡",
            "sku_display_name": "10次卡",
            "sort_order": 1,
            "itemName": "蜜语生玑护理",
            "sessionCount": 10,
            "originalPrice": 2980,
            "isShengmei": true
          }
        ]
      }
    ]
  }
}
```

### 验证点
- ✅ 返回 `code: 0` (成功)
- ✅ 包含 `spuList` 数组
- ✅ 每个 SPU 包含基本信息: `spu_id`、`name`、`category`、`big_category`
- ✅ 每个 SPU 包含 `skuList` 数组
- ✅ SKU 包含从 WorkFine 实时读取的价格信息 (`originalPrice`)
- ✅ `priceFrom` 显示最低价格
- ✅ 商品按 `sort_order` 升序排列
- ✅ 所有商品的 `big_category` 为 "生美"

### 预期数据量
根据 PR 文档:
- UDT_M_1281 (全国可售项目): 481 条
- UDT_M_1383 (门店自定义): 401 条
- 预计生美分类下有 265 个 SPU

---

## 测试 3: 门店列表接口

### 测试目的
验证能否正确获取所有营业中的门店列表

### 测试参数
```json
{
  "action": "store.list",
  "payload": {}
}
```

### 预期结果
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
        "available_beds": 5,
        "store_region": "南昌"
      },
      {
        "market_name": "南商市场",
        "store_name": "南昌红谷滩店",
        "open_date": "2021-06-15",
        "available_beds": 3,
        "store_region": "南昌"
      }
    ]
  }
}
```

### 验证点
- ✅ 返回 `code: 0` (成功)
- ✅ 包含 `stores` 数组
- ✅ 每个门店包含字段: `market_name`、`store_name`、`open_date`
- ✅ 门店按 `market_name`、`store_name` 排序
- ✅ 已停止营业的门店不在列表中 (UDF_M_11956 != '是')
- ✅ 返回的 `available_beds` 是有效数字

---

## 常见问题排查

### 1. 返回空数组
**可能原因**:
- PostgreSQL 数据库中 `product_spu` 表无数据
- SKU 映射表 `product_spu_sku_map` 中 `is_active` 全为 false
- WorkFine 数据库连接失败

**排查方法**:
```sql
-- 在 PG 数据库中执行
SELECT COUNT(*) FROM product_spu;
SELECT COUNT(*) FROM product_spu_sku_map WHERE is_active = true;
SELECT DISTINCT big_category FROM product_spu;
```

### 2. SKU 价格为 null
**可能原因**:
- WorkFine 数据库连接失败
- `workfine_item_id` 在 WorkFine 中不存在

**排查方法**:
```sql
-- 在 MSSQL 数据库中执行
SELECT TOP 1 * FROM UDT_M_1281;
SELECT * FROM UDT_M_1281 WHERE UDF_M_14503 = 'YOUR_ITEM_ID';
```

### 3. 门店列表为空
**可能原因**:
- WorkFine 连接失败
- 所有门店都被标记为已停业

**排查方法**:
```sql
-- 在 MSSQL 数据库中执行
SELECT COUNT(*) FROM UDT_M_219 WHERE UDF_M_11956 != '是';
SELECT UDF_M_438, UDF_M_11956 FROM UDT_M_219;
```

---

## 性能指标

| 接口 | 预期响应时间 | 数据量 |
|------|--------------|--------|
| product.categories | < 500ms | 3-10 个分类 |
| product.spuList | < 2s | 265 个 SPU (生美分类) |
| store.list | < 1s | 10-50 个门店 |

**注意**: `product.spuList` 响应时间较长是因为需要逐个从 WorkFine 读取价格信息。

---

## 测试完成清单

- [ ] 1. 商品分类接口测试通过
- [ ] 2. 商品列表接口(生美分类)测试通过,返回 265 个商品
- [ ] 3. 门店列表接口测试通过
- [ ] 4. 验证数据结构正确
- [ ] 5. 验证价格信息正确
- [ ] 6. 验证排序逻辑正确
- [ ] 7. 响应时间符合预期

---

## 数据库连接信息

### PostgreSQL (小程序专属数据)
- 用于存储: SPU 商品、SKU 映射、订单、用户等
- 环境变量: `PG_CONNECTION_STRING`

### WorkFine MSSQL (业务主数据,只读)
- 服务器: `111.229.31.128:1433`
- 数据库: `wkdb_20220804_86cd3292`
- 用户名: `Sa`
- 密码: `oHx#+Q`
- 环境变量: `MSSQL_CONNECTION_STRING` 或分离的环境变量

---

## 相关文件

- 云函数入口: `cloudfunctions/clientApi/index.js`
- 商品路由: `cloudfunctions/clientApi/routes/product.js`
- 门店路由: `cloudfunctions/clientApi/routes/store.js`
- PG 数据库: `cloudfunctions/clientApi/db/pg.js`
- MSSQL 数据库: `cloudfunctions/clientApi/db/mssql.js`
