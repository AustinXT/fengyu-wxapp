# 数据库脚本目录

## sync-products-from-workfine.js

从 WorkFine SQL Server 同步商品数据到 PostgreSQL。

### 数据源

- **UDT_M_1281**: 全国可售项目 (478 条)
- **UDT_M_1383**: 门店自定义项目 (294 条)
- **UDT_M_341**: 院装产品 (30 条)

### 使用方法

```bash
# 预览模式 (不实际写入数据库)
node scripts/sync-products-from-workfine.js --dry-run

# 正式执行 (写入数据库)
node scripts/sync-products-from-workfine.js

# 使用环境变量配置
export MSSQL_SERVER="111.229.31.128"
export MSSQL_USER="Sa"
export MSSQL_PASSWORD="oHx#+Q"
export MSSQL_DATABASE="wkdb_20220804_86cd3292"
export DATABASE_URL="postgresql://fengyu:fengyu123@localhost:5432/fengyu"
node scripts/sync-products-from-workfine.js
```

### 数据映射规则

#### 大分类 (big_category)

| WorkFine 值 | PG 值 | 说明 |
|------------|-------|------|
| `生美` | `生美` | 服务项目 - 生理美容 |
| `非生美` | `非生美` | 服务项目 - 非生理美容 |
| UDT_M_341 数据源 | `院装产品` | 院装产品 |
| 空值、"是"等无效值 | `非生美` | 默认值 |

#### 产品类型 (product_type)

| WorkFine 值 | PG 值 | 说明 |
|------------|-------|------|
| `疗程卡` | `疗程卡` | 多次核销 |
| `单品` | `单品` | 一次核销 |
| UDT_M_341 数据源 | `院装产品` | 支付即完成 |

#### SKU 显示名称 (sku_display_name)

| 产品类型 | 生成规则 | 示例 |
|---------|---------|------|
| 疗程卡 | `{session_count}次卡` | "10次卡", "1次卡" |
| 单品 | 固定值 | "单次体验" |
| 院装产品 | 固定值 | "院装" |

### 同步策略

1. **SPU 去重**: 基于 `name + category` 生成唯一 SPU ID
2. **SKU 去重**: 基于 `spu_id + workfine_item_id + workfine_source` 唯一约束
3. **清空重建**: 每次同步会清空 `product_spu` 和 `product_spu_sku_map` 表
4. **事务保护**: 所有操作在一个事务中执行，失败自动回滚

### 验证查询

```sql
-- 数据源统计
SELECT workfine_source, COUNT(*) as count
FROM product_spu_sku_map
GROUP BY workfine_source
ORDER BY workfine_source;

-- 大分类统计
SELECT big_category, COUNT(*) as count
FROM product_spu
GROUP BY big_category
ORDER BY big_category;

-- 产品类型统计
SELECT product_type, COUNT(*) as count
FROM product_spu_sku_map
GROUP BY product_type
ORDER BY product_type;
```

### 注意事项

- SPU 封面图 (`cover_image`) 和描述 (`description`) 初始为 `NULL`，需通过运营控制台补充
- 价格、疗程次数等动态数据不存储在 PG，运行时从 WorkFine 实时读取
- 脚本执行前建议先用 `--dry-run` 模式预览
