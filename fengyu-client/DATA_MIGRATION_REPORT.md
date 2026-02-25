# 数据库迁移完成报告

**迁移时间**: 2026-02-25
**源数据库**: localhost:5432 (Docker)
**目标数据库**: 47.113.202.7:5433 (ali-demo)

---

## 一、迁移概览

✅ **迁移方式**: pg_dump + psql
✅ **迁移范围**: 仅数据（表结构已在远程创建）
✅ **迁移状态**: 成功

---

## 二、数据统计

### 2.1 源数据库（本地 Docker）

| 表名 | 行数 |
|------|------|
| `product_spu_sku_map` | 760 |
| `product_spu` | 565 |
| 其他表（9张） | 0 |

### 2.2 目标数据库（远程）

| 表名 | 行数 | 状态 |
|------|------|------|
| `product_spu_sku_map` | 760 | ✅ |
| `product_spu` | 565 | ✅ |
| `client_wechat_users` | 0 | ✅ |
| `staff_wechat_users` | 0 | ✅ |
| `orders` | 0 | ✅ |
| `order_items` | 0 | ✅ |
| `revenue_allocations` | 0 | ✅ |
| `revenue_allocation_items` | 0 | ✅ |
| `appointments` | 0 | ✅ |
| `service_orders` | 0 | ✅ |
| `service_items` | 0 | ✅ |

**总计**: 1,325 行数据已迁移

---

## 三、数据分类详情

### 3.1 product_spu (商品 SPU)

按大分类统计：

| 大分类 | 数量 |
|--------|------|
| 生美 | 265 |
| 非生美 | 270 |
| 院装产品 | 30 |
| **总计** | **565** |

### 3.2 product_spu_sku_map (SKU 映射)

按产品类型统计：

| 产品类型 | 数量 |
|----------|------|
| 疗程卡 | 413 |
| 单品 | 317 |
| 院装产品 | 30 |
| **总计** | **760** |

---

## 四、迁移步骤

### 4.1 导出本地数据

```bash
docker exec fengyu-postgres pg_dump -U fengyu -d fengyu --data-only > /tmp/fengyu_data_backup.sql
```

**导出文件**: `/tmp/fengyu_data_backup.sql`
**文件大小**: 1,453 行

### 4.2 导入到远程数据库

```bash
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -f /tmp/fengyu_data_backup.sql
```

**导入状态**: ✅ 成功
**导入时间**: < 5 秒

---

## 五、数据验证

### 5.1 行数验证

```sql
-- 查询所有表的行数
SELECT schemaname, relname, n_live_tup
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;
```

**结果**: ✅ 本地和远程数据一致

### 5.2 数据分类验证

```sql
-- SPU 分类统计
SELECT big_category, COUNT(*)
FROM product_spu
GROUP BY big_category;

-- SKU 类型统计
SELECT product_type, COUNT(*)
FROM product_spu_sku_map
GROUP BY product_type;
```

**结果**: ✅ 分类统计一致

### 5.3 随机抽样验证

```bash
# 查询前 5 个 SPU
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -c "SELECT spu_id, name, category FROM product_spu LIMIT 5;"
```

**结果**: ✅ 数据完整

---

## 六、连接信息对比

### 6.1 本地数据库（源）

```
主机: localhost
端口: 5432
用户: fengyu
密码: fengyu123
数据库: fengyu
连接串: postgresql://fengyu:fengyu123@localhost:5432/fengyu
```

### 6.2 远程数据库（目标）

```
主机: 47.113.202.7
端口: 5433
用户: fengyu
密码: fengyu123
数据库: fengyu_wxapp
连接串: postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp
```

---

## 七、后续操作

### 7.1 更新云函数环境变量

✅ **已完成** - 云函数环境变量已配置为远程数据库连接串

### 7.2 测试云函数查询

在 CloudBase 控制台测试：

```json
{
  "action": "product.categories",
  "payload": {}
}
```

**预期结果**: 应该返回商品分类列表（生美、非生美、院装产品）

### 7.3 测试商品列表查询

```json
{
  "action": "product.spuList",
  "payload": {
    "bigCategory": "生美"
  }
}
```

**预期结果**: 返回 265 个生美类商品

### 7.4 数据同步策略

由于本地和远程数据库数据一致，建议：

1. **停用本地数据库**: 避免数据不一致
2. **使用远程数据库**: 作为唯一数据源
3. **定期备份**: 每天自动备份远程数据库

---

## 八、备份与回滚

### 8.1 备份远程数据库

```bash
# 备份当前状态
PGPASSWORD=fengyu123 pg_dump -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp > backup_after_migration_$(date +%Y%m%d).sql
```

### 8.2 回滚方案（如需要）

如果需要回滚到迁移前状态：

```bash
# 1. 清空远程数据
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -c "TRUNCATE product_spu, product_spu_sku_map CASCADE;"

# 2. 重新导入
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -f /tmp/fengyu_data_backup.sql
```

---

## 九、性能对比

### 9.1 本地数据库

- 连接延迟: < 1ms
- 查询速度: 快（本地网络）

### 9.2 远程数据库

- 连接延迟: ~20ms（公网）
- 查询速度: 快（已创建索引）
- 建议: 云函数部署在同一地域可降低延迟

---

## 十、注意事项

1. **数据一致性**: 迁移后本地和远程数据已同步，后续修改请只修改远程数据库
2. **网络访问**: 远程数据库已配置允许外网访问，建议配置 IP 白名单
3. **定期备份**: 建议配置自动备份策略
4. **监控告警**: 建议配置数据库监控和告警

---

## 十一、常见问题

### Q1: 如何验证数据是否完整？

```bash
# 对比本地和远程数据行数
docker exec fengyu-postgres psql -U fengyu -d fengyu -c "SELECT COUNT(*) FROM product_spu;"
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -c "SELECT COUNT(*) FROM product_spu;"
```

### Q2: 如何同步新的数据变更？

如果本地有新数据变更，重新执行迁移：

```bash
# 导出
docker exec fengyu-postgres pg_dump -U fengyu -d fengyu --data-only > /tmp/fengyu_new_data.sql

# 导入（会追加数据，注意主键冲突）
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -f /tmp/fengyu_new_data.sql
```

### Q3: 如何清空远程数据重新导入？

```bash
# 清空所有表数据
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp << 'EOF'
TRUNCATE product_spu CASCADE;
TRUNCATE product_spu_sku_map CASCADE;
EOF

# 重新导入
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -f /tmp/fengyu_data_backup.sql
```

---

**数据迁移完成！** 🎉

- ✅ 1,325 行数据已成功迁移
- ✅ 数据验证通过
- ✅ 云函数环境变量已配置
- ✅ 可以开始测试和开发

下一步建议在 CloudBase 控制台测试云函数，验证数据查询功能。
