# 数据血缘文档（fengyu PG ← WorkFine MSSQL）

**目标**：为 PG（`postgresql://...:5434/fengyu`）每张业务表的每一列记录数据来源，作为后续生成最终迁移脚本的输入。

**WorkFine MSSQL（只读）**：`mssql://admin:Se1Qimoh@47.96.87.33:1433/wkdb_20220804_86cd3292`

> ⚠️ **WorkFine MSSQL 严格只读** — 任何 INSERT/UPDATE/DELETE/DDL 都禁止。详见 `feedback_mssql_readonly` memory。

## 文档约定

- 一份 `NN-<module>.md` 对应 `db/schema/<module>.ts` 一个模块（多张表写在同一份）
- 每列必须填一种**来源类别**（5 选 1，强制）：
  1. **WorkFine 直拷**：字段一对一映射，可能含 trim/类型转换
  2. **WorkFine 派生**：由 WorkFine 一个或多个字段计算/转换得到（含 CTE / JOIN / 枚举映射）
  3. **新系统独立**：完全由小程序/admin 录入，WorkFine 无对应
  4. **默认值/NULL**：迁移时填默认值或 NULL，运行后再补
  5. **未覆盖（疑似遗漏）**：⚠️ 重点产出，同步汇总到 `_gaps.md`
- 每条映射尽量给出脚本行号（如 `migrate-history-orders.js:L84`）和 WorkFine 列名（如 `UDT_S_209.UDF_S_372`）

## 进度

| # | 模块 | 表 | 状态 | 备注 |
|---|------|----|----|------|
| 01 | order | sale_orders, sale_items, sale_allocations, sale_order_payments | ✅ R1 草稿已出 | 等用户审核模板 |
| 02 | org | org_nodes, stores | ✅ R2 完成 | closed_at 用 updated_at 兜底，UDF_M_11957 真实闭店日期未抽取；id 全部 hashId 派生 |
| 03 | user | client_wechat_users, staff_wechat_users | ✅ R3 完成 | member_level / customer_source 99.99% 流失（PG enum 与 WF 自由文本不兼容）；is_married toBool 把空值当 false；hired_at/resigned_at 全部用 created_at/updated_at 兜底非真实日期 |
| 04 | product | product_categories, product_skus, mall_categories, products, mall_product_skus, mall_bundle_groups | ✅ R4 完成 | v2.1 重构后 100% admin 维护；product_kind 把 WF 生美/非生美坍缩为单一"护理项目"；UDT_M_341 99% 院装产品未导入；spec_name 是 name+规格合并字段不可拆 |
| 05 | service | service_orders, service_items | ✅ R5 完成 | service_order_type 100% 失真（archive 0024 用 customer_type 重写 UDF_S_1417 真实标签）；UDF_M_840 字段映射存疑（duration 还是金额？）；UDF_M_6902 赠送标志 17% 占比未对接 |
| 06 | appointment | appointments | ✅ R6 完成 | 100% 新系统独立（WorkFine 无独立预约表，仅 UDT_S_762.UDF_S_843 售前预约时间字段 109,390 行未对接）；PG 现状 5 行全部 admin/seed.ts demo 数据；confirmed_at 设计漏实现（3 处 confirm 入口都没写） |
| 07 | permission | permission_roles | ✅ R7 完成 | 100% PG 内派生（sync 不读 WF），2017/2038 行 by sync；spec §4.6 文档过时（说 role=employee，实际 fallback 是 staff）；代理经理被强制降级为 staff；25 行 updated_by NULL（admin actions 漏写） |
| 08 | commission | commission_rate_matrix | ✅ R8 完成 | 100% 新系统独立（WF 无对应实体）；24 个市场仅 3 个有规则 → 21 市场分配 API 直接抛错；1 行 `推广` 残留永远命中不到员工 |
| 09 | coupon | coupon_templates, user_coupons | ✅ R9 完成 | 100% 新系统独立（WF 完全无券实体）；PG 17 张 user_coupons 全部 admin `cpn-*`，cron + 分享礼三副本零产出；expire_at 派生 6 副本不一致 |
| 10 | points | point_transactions | ✅ R10 完成 | 100% 新系统独立（WF 无积分实体）；`customer_points` 已 archive 0016 DROP，余额迁入 client_wechat_users.points_balance；PG 5434 现状 0 行流水 + 0 余额，cron-worker / 消费链 3 副本未触发任何写入，疑似 baseline 后未跑通 |
| 11 | prepaid-card | prepaid_cards, card_transactions | ✅ R11 完成 | 100% 从 PG sale_items 二次派生（不读 WF）；schema 漏 `expire_date` 列导致 WF UDF_M_7122 到期约束完全丢失；2499 行 card_transactions 全为 type='充值'，扣卡链路 0 行产出 |
| 12 | message | messages | ✅ R12 完成 | 100% 新系统独立（WF 完全无消息实体）；PG 5434 仅 1 行测试残留，6 个入口（cron 三 STEP + share-gift 三副本）baseline reset 后零写入；recipient_type='员工' / message_type 4 分类 / ref_entity_* 三处枚举/字段全部设计未实现 |
| 13 | operation-log | operation_logs | ✅ R13 完成 | 100% 新系统独立（WF `tb_sys_log` 200 万行属平台层日志、语义不兼容；PG 295 行其中 7 行为 seed.ts demo、cloudfunctions 5 个运行时入口在 baseline reset 后实际产出 ≤ 5 行）；`org_node_id/name` 在 cloudfunctions/cron 入口架构性缺失（只有 admin 路径反查）；detail jsonb V1/V2/V3 三套 schema 共存无升级 |
| 14 | service-commission | service_commissions | ✅ R14 完成 | 616,210 行全部 migrate 路径产出（runtime service.complete 0 行、与 12/10 同源）；archive 0018 把 commission_amount 整体兜底为 fixed_fee → consume_amount 100% = 0、双字段模型在历史中不成立；MAX commission=22,864,061.73 是 WorkFine 脏数据 sess_used=99,769 直传；migrate `--year>=2025` 切片导致 2024 及更早 360,000+ fee>0 行完全未导入；role_type migrate=skills[0] / backfill=skills[1] 双源不一致 |
| 15 | pickup | pickup_records | ✅ R15 完成 | 100% 新系统独立（WF 全库 0 命中）；PG 0 行+上游 sale_items 家居产品仅 1 行；admin 完整实现但运行时未触发；无 cloudfunctions 入口
| 16 | store-unbind | store_unbind_requests | ✅ R16 完成 | 100% 新系统独立（WF 完全无解绑/绑定实体）；PG 0 行的根因是 clientApi `requestUnbind` INSERT 列名 Bug（写不存在的 `from_store_name`，应为 `from_store_id`），顾客端"申请解绑"自上线必失败；staffApi/admin 审批清空字段不一致（staff 漏清 `bound_employee_id`） |
| 17 | system-config | system_configs | ✅ R17 完成 | 100% 新系统独立（WF `tb_sys_setting` 11 行仅平台元数据零业务参数）；PG 10 行：`order_prefix` 全仓 0 处读写=死键、`order_timeout` admin UI 写但运行时 0 消费方、`share_gift_config` key 不存在导致分享礼三副本永远沉默失败、`points_to_yuan_rate` 没有 admin UI 只能 SQL；`new_member_threshold` 跨进程缓存失效仅广播 clientApi，staff/payNotify/cron 30s 被动核对 |

## 相关参考

- `db/CLAUDE.md` — schema 模块清单
- `.42cog/pm/workfine-sync.spec.md` — 旧系统同步规范
- `db/scripts/sync-workfine.js` — 综合同步主脚本（45KB）
- `db/scripts/migrate-*.js` — 9 个一次性迁移脚本（已跑过且生效）
- `_gaps.md` — 未覆盖字段汇总（产出物之一）
- `_template.md` — 单模块文档模板
