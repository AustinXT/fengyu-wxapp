# NN — `<module>` 模块

**Schema 文件**：`db/schema/<module>.ts`
**涉及 PG 表**：`<table_a>`, `<table_b>`
**WorkFine 源表**：`UDT_X_NNN`（含义：xxx）
**主要迁移脚本**：`db/scripts/migrate-xxx.js`、`db/scripts/sync-workfine.js`

---

## 表 1：`<table_a>`

**WorkFine 源表**：`UDT_X_NNN`
**当前行数**（PG 5434）：`SELECT COUNT(*) FROM <table_a>` = ?
**WorkFine 源行数**：`SELECT COUNT(*) FROM UDT_X_NNN WHERE ...` = ?
**导入脚本**：`migrate-xxx.js`

| 列名 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| col_a | varchar(30) | WorkFine 直拷 | `RTRIM(UDT_X_NNN.UDF_X_852)` | migrate-xxx.js:L84 | |
| col_b | numeric | WorkFine 派生 | `Σ(UDT_X.UDF_M_399)` 按订单聚合 | migrate-xxx.js:L252 | |
| col_c | varchar | 新系统独立 | 由 staffApi.order.create 写入 | — | 历史导入填 NULL |
| col_d | timestamp | 默认值/NULL | `defaultNow()` | schema:L101 | |
| col_e | text | ⚠️ 未覆盖 | — | — | 历史导入未填，需人工补；记入 _gaps.md |

### 关键决策

- 例：xxx 字段在历史导入时硬编码为 `'WorkFine历史订单导入'`（migrate-history-orders.js:L256），未来迁移脚本应保留此模式以便区分

### 未覆盖字段汇总

- `<table_a>.col_e` — 描述为何未覆盖、影响、建议

---

（后续表重复以上结构）
