# WorkFine 进销存一期迁移

这套脚本只做一次性切换：把 WorkFine 当前的公司、市场、分院库存作为 PG 的期初库存，并把在办业务、顾客未领取权益导出为人工重建清单。它不会迁移历史库存流水、历史单据或财务结算数据，也不会向 WorkFine 写入任何内容。

上线后的业务只读 PG；WorkFine 只在切换窗口中被本脚本只读访问。历史和在办单据不能自动接入新状态机，必须由负责人员按导出的清单重建。

执行窗口必须先冻结 WorkFine 的进销存写入。三个库存视图和两个价格视图会顺序读取，脚本不会用不可靠的历史流水反推切换时点；未冻结时得到的不是同一时刻快照，必须停止而非写入 PG。

## 期初库存

```bash
node db/scripts/import-workfine-inventory.js --inspect
node db/scripts/export-workfine-inventory-rebuild.js --inspect
node db/scripts/export-workfine-inventory-rebuild.js --dry-run
node db/scripts/export-workfine-inventory-rebuild.js --output /secure/path/workfine-inventory-rebuild.json
node db/scripts/import-workfine-inventory.js --dry-run --as-of 2026-08-09
node db/scripts/import-workfine-inventory.js --apply --as-of 2026-08-09
node db/scripts/import-workfine-inventory.js --verify --as-of 2026-08-09
node db/scripts/export-workfine-inventory-rebuild.js --verify
```

`--verify` 是写入后的只读复核，不是写入前预览；必须排在对应的 `--apply` / `--output` 之后。导出器的 `--verify` 还要求填齐 `WORKFINE_INVENTORY_PENDING_EXPECTED_COUNTS` 的所有来源基线。

数据源固定为：

| 层级 | WorkFine 视图 |
| --- | --- |
| 公司 | `UDV_519` |
| 市场 | `UDV_538` |
| 分院 | `UDV_607` |
| 批次价格补充 | `UDV_1189`、`UDV_2014` |

`--apply` 需要 `DATABASE_URL`、`MSSQL_CONNECTION_STRING`（或拆分的 `MSSQL_*` 变量）以及已有员工的 `WORKFINE_INVENTORY_IMPORTER_EMPLOYEE_ID`。默认不会写入；必须显式传 `--apply`。

每一条库存行必须能识别其**物理表名、RID、OBYID**。脚本以这三项写入 `inventory_import_refs`，并生成确定性的批次、期初单、明细和入库流水键。包含空 `OBYID` 的行会被拒绝；重复运行会 UPSERT，不会重复加库存。

### 期初基线只能二选一

新库存域的期初库存以 WorkFine 三层快照为唯一事实来源。迁移不会把旧 PG 的 `store_inventory_*` 库存、单据或流水复制到 `inventory_*`，避免它与 WorkFine 快照对同一库存重复计数。

导入和导入后 `--verify` 都会检查是否已存在未追溯到 WorkFine 的旧 PG 期初批次；一旦发现会停止。遇到这种情况，不要强行导入或手工合并余额，应先在切换窗口确认只保留一个期初基线，再重新执行迁移。

### 模板元数据是唯一的结构依据

`--inspect` 会同时读取 `tb_sys_template_table` 与 `tb_sys_template_field`，输出库存相关物理表、物理表 ID、模板 ID 和字段列表。字段归属严格按：

```text
tb_sys_template_field.owner_id -> tb_sys_template_table.id
```

`owner_id` **不是**模板 ID；脚本不会以 `template_id` 回退。WorkFine 的模板显示名会复用或标记删除，不能用显示名推断业务表。配置 `WORKFINE_INVENTORY_LEGACY_TABLE_MAP` 后，脚本还会确认映射的 `UDT_S_xxx` / `UDT_M_xxx` 已登记在模板元数据中，且真实表包含 `RID`、`OBYID` 系统列；若字段映射直接写了 `UDF_S_xxx` / `UDF_M_xxx`，还必须属于该物理表。

WorkFine 各 UDV 的字段名在不同环境可能不同。先运行 `--inspect`，再通过以下变量映射实际字段：

```bash
export WORKFINE_INVENTORY_LEGACY_TABLE_MAP='{
  "UDV_519": "UDT_M_xxx",
  "UDV_538": "UDT_M_yyy",
  "UDV_607": "UDT_M_zzz"
}'

export WORKFINE_INVENTORY_FIELD_MAP='{
  "UDV_519": {
    "legacyRid": "RID",
    "legacyObyid": "OBYID",
    "productCode": "UDF_V_xxx",
    "productName": "UDF_V_yyy",
    "quantity": "UDF_V_zzz",
    "locationName": "UDF_V_location"
  }
}'
```

若视图含有明确的快照日期列，可额外映射 `snapshotDate`。该列一旦存在，必须与 `--as-of` 完全相同；不一致会拒绝导入，避免把不同切换时点的库存混在同一批期初单中。

不完整的物理追溯键、主体、产品或数量会让脚本失败，不会做部分写入。`--verify` 会比较 WorkFine 当前源行、`inventory_import_refs` 和 PG 入库流水数量；期初单引用也必须落在某条完整的物理表 + RID + OBYID 源行上。

## 人工重建清单

```bash
node db/scripts/export-workfine-inventory-rebuild.js --inspect
node db/scripts/export-workfine-inventory-rebuild.js --dry-run
node db/scripts/export-workfine-inventory-rebuild.js --verify
node db/scripts/export-workfine-inventory-rebuild.js --output /secure/path/workfine-inventory-rebuild.json
```

导出来源：`S336`、`S548/S612`、`S494`、`S350`、`S525`、`S580/S582`、`S872` 以及 `WORKFINE_UNCLAIMED_BENEFITS_VIEW`。其中 S336、S548、S612 的物理表和状态字段已由留存调研核验；其他来源仍必须先完成模板元数据复核，脚本不把表 ID 或模板显示名擅自解释成业务名称。

其中 S580/S582 会额外找出“出库存在、对方入库已删除或缺失”的调货异常。已留存的切换调研基线为：31 张分院报货、1 张采购订单、3 张品项公司发货、51 张分院配货、28 张分院调货未对方入库、24 张自采入库未确认，以及 2 条市场调货对方入库缺失异常。实际切换前必须用已核验的状态字段重新锁定数量，不得直接把这组历史调研数字当作导入结果。

为避免历史已完成单据误入清单，必须为每个来源显式配置完成状态字段、待办值和完成值：

```bash
export WORKFINE_INVENTORY_PENDING_RULES='{
  "S494": { "completionField": "UDF_S_xxx", "pendingValues": ["待处理"], "completedValues": ["已完成"] },
  "S350": { "completionField": "UDF_S_xxx", "pendingValues": ["待处理"], "completedValues": ["已完成"] },
  "S525": { "completionField": "UDF_S_xxx", "pendingValues": ["待处理"], "completedValues": ["已完成"] },
  "S580": { "completionField": "UDF_S_xxx", "pendingValues": ["待处理"], "completedValues": ["已完成"] },
  "S582": { "completionField": "UDF_S_xxx", "pendingValues": ["待处理"], "completedValues": ["已完成"] },
  "S872": { "completionField": "UDF_S_xxx", "pendingValues": ["待处理"], "completedValues": ["已完成"] }
}'
export WORKFINE_UNCLAIMED_BENEFITS_VIEW='UDV_xxx'

# 仅展示已留存的两个基线；不能直接用于 --verify。
export WORKFINE_INVENTORY_PENDING_EXPECTED_COUNTS='{
  "S336": 31,
  "S548": 28,
  "MARKET_TRANSFER_ANOMALIES": 2
}'
```

上例只放入已知口径。完成每个来源的模板字段和状态值复核后，必须把其实际数量补入同一 JSON。`--verify` 强制要求全部键：`S336`、`S548`、`S612`、`S494`、`S350`、`S525`、`S580`、`S582`、`S872`、`UNCLAIMED`、`MARKET_TRANSFER_ANOMALIES`。`S336` 默认使用已核验的 `UDF_S_3684`（`否`=待办、`是`=完成）；`S548` 使用 `UDF_S_4636`（空=对方未完成、`已完成`=完成），`S612` 使用 `UDF_S_5593`（空=未确认收货、`是`=已确认）。其他来源没有已核验的状态字段，脚本宁可拒绝导出，也不会猜测并混入历史业务。遇到不在两组枚举中的状态同样会停止，避免把取消、删除或未来新增状态混入清单。字段映射可用 `WORKFINE_INVENTORY_PENDING_FIELD_MAP` 覆盖。
