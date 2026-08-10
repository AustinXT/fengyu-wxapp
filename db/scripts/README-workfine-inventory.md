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

### 切换状态

`inventory_cutover_states` 中固定使用 `cutover_key='workfine_inventory'` 记录切换状态。首次执行前为“待初始化”；`--apply` 将库存、追溯引用、切换日期、源行数/数量、导入单据/明细数、操作者和状态变更放在同一事务中，成功提交后记为“待核验”。`--verify` 同样在一个事务中完成追溯和数量检查，全部通过才写入核验时间并原子改为“已初始化”；任何核验失败都会回滚，状态仍保持“待核验”。

已初始化后再次执行普通 `--apply` 会被拒绝，防止将切换后的库存重复当作期初库存导入。只有在已冻结业务、确认需要受控全量重置时，才可执行 `--apply --reset --as-of YYYY-MM-DD`；该命令成功后会重新回到“待核验”，必须再次执行 `--verify` 才能恢复“已初始化”。

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

导出来源：`S336`、`S548/S612`、`S494`、`S350`、`S525`、`S580/S582`、`S872` 以及 `WORKFINE_UNCLAIMED_BENEFITS_VIEW`。其中 S336、S548、S612 的主表、明细表和状态字段已由留存调研核验；其他来源仍必须先完成模板元数据复核，脚本不把表 ID 或模板显示名擅自解释成业务名称。

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

### 在办单据明细

每条“在办库存业务”或“市场调货异常”记录均带有 `details` 数组。每一行都保留明细物理表、`RID`、`OBYID`、SKU、数量、批号、有效期、赠送、单价（以及已知时的金额、产品名称、规格、厂家、产品系列、库存参考数量）和完整原始行。CSV 也会在 `details` 列保留同一 JSON；不要把该列拆开后丢失明细的来源键。

已核验的默认映射如下。`confirmedAbsent` 表示留存的 WorkFine 元数据显示该明细表没有该类字段，导出值会是 `null`，绝不从当前产品资料或其他单据补猜：

| 来源 | 主表 / 明细表 | 已核验字段 | `confirmedAbsent` |
| --- | --- | --- | --- |
| S336 分院报货 | `UDT_S_336` / `UDT_M_342` | SKU `UDF_M_1888`、产品快照 `UDF_M_1889`-`UDF_M_1892`、数量 `UDF_M_1893` | `batchNo`、`expiryDate`、`isGift`、`unitPrice` |
| S548 分院调货出库 | `UDT_S_548` / `UDT_M_549` | SKU/产品快照 `UDF_M_1888`-`UDF_M_1892`、数量 `UDF_M_3912`、批号 `UDF_M_3878`、有效期 `UDF_M_4274`、赠送 `UDF_M_3911`、库存参考数量 `UDF_M_5523` | `unitPrice` |
| S612 分院调货入库 | `UDT_S_612` / `UDT_M_613` | SKU/产品快照 `UDF_M_1888`-`UDF_M_1892`、数量 `UDF_M_3912`、批号 `UDF_M_3878`、有效期 `UDF_M_4274`、赠送 `UDF_M_3911` | `unitPrice` |

`S494`、`S350`、`S525`、`S580`、`S582`、`S872` 出现任何在办记录时，必须先配置 `WORKFINE_INVENTORY_PENDING_DETAIL_MAP`。每个字段只能填写该 `UDT_M` 表已登记的单个 `UDF_M_xxx`；SKU 和数量不可声明缺失。批号、有效期、赠送、单价如果确实不存在，必须在用 `--inspect` 输出和 `tb_sys_template_field.owner_id -> tb_sys_template_table.id` 复核后，显式写进 `confirmedAbsent`：

```bash
export WORKFINE_INVENTORY_PENDING_DETAIL_MAP='{
  "S494": {
    "table": "UDT_M_xxx",
    "sku": "UDF_M_xxx",
    "quantity": "UDF_M_xxx",
    "batchNo": "UDF_M_xxx",
    "expiryDate": "UDF_M_xxx",
    "isGift": "UDF_M_xxx",
    "unitPrice": "UDF_M_xxx",
    "amount": "UDF_M_xxx"
  },
  "S580": {
    "table": "UDT_M_xxx",
    "sku": "UDF_M_xxx",
    "quantity": "UDF_M_xxx",
    "batchNo": "UDF_M_xxx",
    "expiryDate": "UDF_M_xxx",
    "isGift": "UDF_M_xxx",
    "unitPrice": "UDF_M_xxx"
  }
}'
```

例如，只有在元数据已确认某来源没有价格字段时，才可把该来源配置成 `"confirmedAbsent": ["unitPrice"]`。不能用 `price`、`quantity`、`SKU` 一类候选名或其他表的同名 `UDF_M` 字段代替；脚本会拒绝。若某个在办主表 `RID` 没有明细、明细缺 SKU/数量，或明细 `RID/OBYID` 不完整，也会停止导出，避免给人工重建提供不可追溯的单据。
