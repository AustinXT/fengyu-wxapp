# 数据血缘复核进度（10 分钟 cron / Agent 模式）

每轮 fresh agent 独立调研后再对比文档，找错不重写。
verdict：**accept** / **minor-fix** / **major-rework**

## 进度

| # | 模块 | 文档 | 状态 | Verdict | 关键发现 |
|---|------|------|------|---------|----------|
| 01 | order | 01-order.md | ✅ done | minor-fix | sale_items.store_id 回填来源已可定位为 db/migrations/0002（文档仍标"未知"）；0003/0004 migration 时间应是 2026-04-24（文档误写 2026-03-14） |
| 02 | org | 02-org.md | ✅ done | minor-fix | 缺 admin 3 写入入口（org/stores/seed）+ closed_at 双写一致 + inbound FK 概览；列级血缘基本准确 |
| 03 | user | 03-user.md | ✅ done | minor-fix | UDF_S_1162=入职日期 / UDF_S_1626=离职日期 / UDF_S_1625=离职原因 三项 sample 已验证；monthly_activity 0/58803 cron 未跑 |
| 04 | product | 04-product.md | ✅ done | minor-fix | mgrp-${Date.now()} 张冠李戴（实为 mall_categories 一级分组特例非 bundle group）；is_valid=false 实测 14 行 ≠ doc 1 行；seed.ts 入口缺漏；product_kind 演化提及 0008 应为 0005 |
| 05 | service | 05-service.md | ✅ done | accept | P0：staffApi service.js INSERT 列含 sku_id 但 schema/PG 无该列，部署即业务永久失效（已写入 _gaps.md 顶部）；文档量化指标全部在 5434 复现一致 |
| 06 | appointment | 06-appointment.md | ✅ done | minor-fix | confirmed_at 归责错（实际 staffApi 写了、仅 admin 漏写）；遗漏 service.complete 联动 UPDATE 已完成/已关闭入口；schema 注释的"超时关闭 cron"未实现 |
| 07 | permission | 07-permission.md | ✅ done | minor-fix | "5 个无权限在职员工"实际 6 个 + 原因解释错位（应是 sync 4-16 停用后新入职无兜底，非 store_id IS NULL）；"21 vs 10 行手工"自相矛盾；schema/规则/PG 实际状态高度一致，无 P0 |
| 08 | commission | 08-commission.md | ✅ done | minor-fix | operation_logs action 名错配（doc=`service.commission.missing_rate` 实=`service.complete.rate_missing`，告警 grep 全漏）+ `推广` 残留时间线错配（实为 archive 0010 在本 DB 漏 apply，非"之后又有写入"） |
| 09 | coupon | 09-coupon.md | ✅ done | accept | 文档质量极高：6 写入命名空间 / 6 expire_at 派生算法 / PG 现状量化指标全部一致；仅 refunds.ts 行号 L347→L383-395 + thx 命名空间漏连字符 2 处微小偏差，结论无误 |
| 10 | points | 10-points.md | ✅ done | minor-fix | 副本数自相矛盾（4 vs 3）+ 写入入口数自相矛盾（5 vs 6）；列血缘 / PG 现状 0 行 / archive 演化路径全部正确，无 P0；MSSQL 凭据过期未独立复现 WorkFine probe |
| 11 | prepaid-card | 11-prepaid-card.md | ✅ done | minor-fix | 主要写入入口清单严重低估：payNotify L283/L319 主路径完全漏列 + clientApi 4 个扣款入口 + staffApi L1820-1840 归错（实为 createRepayment 扣款而非 refund 回冲）；schema/量化指标/0003 migration 时序全准确，无 P0 |
| 12 | message | 12-message.md | ✅ done | minor-fix | 写入入口清单漏 admin `batchSendMessages`（actions/messages.ts:392-493，已接通 UI 且写 message_type 非硬编码 'system'）+ mergeClientProfile UPDATE/deleteMessage 维护入口；3 个 cron INSERT 行号 ±1 偏差 |
| 13 | operation-log | 13-operation-log.md | ✅ done | accept | 列血缘 / 7 个 cloudfunc INSERT 行号 / 21 admin 模块 + ≥104 处调用 / cron 5 STEP / PG 量化指标 / migration 0032 全部精准命中；轻微偏差仅 3 处：distinct action 实 55 vs doc "30+" 低估 / WorkFine tb_sys_log 行数 +801 drift / 3 张 WorkFine 平台日志表行数空缺；架构性 org_* 不对称缺失已被 doc 主动披露，无 P0 |
| 14 | service-commission | 14-service-commission.md | ✅ done | minor-fix | 关键事实错误：声称"2024 及更早 360,517 行未导入"实测 PG 已有 service_date<2025 的 344,965 行；漏列 admin batchSaveServiceCommissions 第二运行时入口与 mgmt-dashboard 推广师剔除规则；MSSQL 行数过时；schema/列血缘/量化指标主体精确匹配，无 P0 |
| 15 | pickup | 15-pickup.md | ✅ done | minor-fix | "唯一 INSERT 入口"结论失实：staffApi `routes/order.js:2383-2444` 已注册并部署 `order.createPickup` 路由（前端尚未接入），与 admin 并列两个 INSERT 入口；无 P0 |
| 16 | store-unbind | 16-store-unbind.md | ✅ done | accept | doc 已自报 P0：clientApi `requestUnbind` INSERT 写错列名 `from_store_name`（实为 `from_store_id` NOT NULL），导致顾客端解绑入口自上线以来 0 成功写入；5434 双向核验 0 行 + 无该列；仅 baseline FK 行号 `592-595→552-554` 偏移 + 缺归档 0000/0004/0016/0026 历史链 cosmetic 偏差 |
| 17 | system-config | 17-system-config.md | ✅ done | accept | schema/10 行 PG 现状/7 写入入口/14 只读入口/5 副本缓存全部精准命中；3 处微小措辞偏差（order_timeout "全仓 grep 0 hits" 过强、admin unstable_cache 与 cloudfunc 30s/5min 双层缓存语义混用、tb_sys_setting 11 行未独立复现）；无 P0 |

## 复核标准

每轮 agent 独立做 5 件事，**先调研后读文档**避免 confirmation bias：
1. 读 schema/<module>.ts 拿真实字段清单
2. grep migrate/sync/migrations/cloudfunctions 找写入入口
3. MSSQL 只读抽样
4. PG 5434 抽样验证
5. 形成自己的"应该长什么样"结论

然后对比文档，按 4 类列偏差：**缺漏 / 错配 / 数据不一致 / 过时事实**。

## P0 升级机制

如发现业务永久失效 / 数据资损 / 越权，agent 在 `_gaps.md` 顶部加 `## ⚠️ P0 / NN-<module>` 章节，标红优先处理。
