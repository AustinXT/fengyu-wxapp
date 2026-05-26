# 数据血缘深度边缘复核 R2（10 分钟 cron / 3-并行 Agent）

第一轮（_review.md）已验证文档准确性。本轮**主动挖文档外的边缘问题**，聚焦 8 类风险维度：

1. **FK 孤立 / 引用完整性** — 父表是否真有匹配（LEFT JOIN parent IS NULL）
2. **NULL / 空串 / 极值** — NotNull 守住与否；text 混 NULL/''；numeric 极值；日期 >2100 或 <2000
3. **enum 漂移** — 实际取值 vs schema 声明 vs 代码 switch
4. **unique 约束** — `GROUP BY ... HAVING COUNT(*) > 1` 看历史数据
5. **跨模块一致性** — 本模块字段与其他模块的引用
6. **死代码 / 永不命中分支** — schema 定义但代码 0 引用
7. **dump-restore 残留 / drift** — archive 应删未删
8. **运行时安全** — SQL 注入位点 / 未事务多步写

verdict: **clean** / **minor-issues** / **serious-edge-cases** / **blocking-issue**

每轮 fresh agent 主动找问题（**不防 confirmation bias**——本轮就要发散），追加到 NN-{module}.md 末尾的 `## Edge Case 报告 R2` 段。高危发现进 _gaps.md 顶部 `## ⚠️ EDGE / NN-{module}` 章节。

## 进度

| # | 模块 | 文档 | 状态 | Verdict | 关键 Edge Case |
|---|------|------|------|---------|----------------|
| 01 | order | 01-order.md | ✅ done | serious-edge-cases | paid_amount/sop 双写不变量已破 15 行 + 5130 行 expire_date='1900' 致 2125 张活卡 UI 误判已过期 + allocation_ratio 73214 行 > 1.00（max=999.99 触顶）|
| 02 | org | 02-org.md | ✅ done | serious-edge-cases | staffApi scope.js 写死 `ANY($1::uuid[])` 但 org_nodes.id 是 text，2014 员工带市场/门店 scope 登录必抛 42883 |
| 03 | user | 03-user.md | ✅ done | serious-edge-cases | bound_employee_id 4188/4218 (99.3%) 实为中文姓名而非 employee_id，致美容师"我的新会员" + staffRanking + 顾客详情三接口业务永久失效 |
| 04 | product | 04-product.md | ✅ done | serious-edge-cases | 466 行 product_type='疗程卡' 但 session_count<2（"单次体验" SKU 被误打成疗程卡，schema 注释"疗程卡≥2"未守住）+ 149/151 套餐缺 bundle_groups 致 N 选 M 校验静默放过 + 17 套餐 SKU 缺 bundle_price 收全价 → 资损；扩展候选 16 个（P0×2 commission_class/is_gift / P1×7 / P2×5 / 1 无源放弃）|
| 05 | service | 05-service.md | ✅ done | serious-edge-cases | 38,562 sale_items 累计扣次 > session_count（service_items 超消，疗程卡 100%，业务永久不变量破缺）+ 79,058 单（13%）assigned_employee_id ≠ items.employee_id 团队成员丢失 + 6,745 行过期后服务 + session_used max=999,999；扩展候选 15 个（P0×3 / P1×7 / P2×5），P0 = service_order_type 重写 / is_gift / sku_id 新列 |
| 06 | appointment | 06-appointment.md | ✅ done | minor-issues | 9 个扩展字段候选（P0×2 / P1×3 / P2×3 / P3×1）；E1 并发双击同 sale_item 可破"已有预约"业务守卫（无 partial unique index 兜底）；schema L14 "超时未到店→已关闭" cron 至今无实现 |
| 07 | permission | 07-permission.md | ✅ done | serious-edge-cases | admin assignRole 缺 role×scope_type 白名单守卫 → 4 行 manager/staff/finance:总部 让员工端 staffApi 自动升级 headquarters 全店越权 + 2 行 hr:门店/市场 偏离 HQ-only 设计 + 1 行调店后旧店 staff 残留双店可见越权；扩展候选 0 个（确认 100% 新系统独立，5 个反推候选全 reject）|
| 08 | commission | 08-commission.md | ✅ done | serious-edge-cases | service.js:L396 `roleType=skills[0]` 11 名员工 skills[0] 落到 管理/面部护理/经络调理 等非标值致 service.complete silent rate=0（service_commissions 616k 行 0 行 rate_missing 告警→历史回填路径绕过校验生产新单必触发）+ 南昌市场 16,629 笔推广师 sale_allocations 与 commission_rate_matrix 字符串不等致 suggest 永远 0 + `他销他耗/生态合作` dead defaults；扩展候选 10 个（P0×3 position_name/department_name/commission_kind / P1×4 / P2×3），8 维命中 6 个 |
| 09 | coupon | 09-coupon.md | ✅ done | serious-edge-cases | 1 行已使用券对应订单已关闭但券未释放（cpn-1776947619987-9gjv → FY-XSD-WX-2604230004，关闭路径未命中云函数释放 SQL）+ admin issueCoupon 不校验 expireAt 已过期 → 1 行"出生即死"券 cpn-1774320039573-rlma + coupon-tpl-003 已过期 12 天但 is_active=true 仍可发 + 1 顾客 3 张同模板未使用券（admin batchIssue 无去重） + 4 行 used_at < created_at 时序破缺 + 4 写入路径（cron 三 STEP + share-gift 三副本）0 产出 0 覆盖；扩展候选 9 个（P0×0 / P1×5 含 client_wechat_users 3 个 legacy cash coupon 列 + P2×4），R2 重新探查 MSSQL 修订 R1 结论：UDT_S_209 17190/17216/17194 可反推 1322 unique customers 顾客级历史现金券事件流，但不可反推 user_coupon 实例级；8 维命中 7 维（仅 enum 干净）|
| 10 | points | 10-points.md | ✅ done | serious-edge-cases | 49,072 销售单 paid_amount≥100 + client_user_id NOT NULL 但 0 条 `'消费赠送'` 流水 → 消费链路径未接通（4 候选根因待运维核实：history batch 未补发 / wxpay webhook 未触发过 / `POINTS_ACCRUAL_ENABLED=false` / cron-worker 未启动）+ 派生单 6 行 `ref_sale_order_id` 全 NULL 致退款分支 settlePointsSafe(undefined) 直接 return + type 自由文本 archive 0016 退化遗产无 enum 守门 + refunds.ts FIFO 把 `'消费冲销'` 误算"升级奖励消耗"高估 suggestedOverdraftDeduction + settlePointsSafe catch 的 INSERT operation_logs 共享主事务 client → "失败也不留痕"；扩展候选 10 个（P0×2 type→enum / balance_after 行级缓存 / P1×4 / P2×4），WF 5 维 fresh probe 复现 R1 "无源"结论；8 维命中 5 维（FK/NULL/unique/drift 干净，enum/一致性/死分支/运行时安全 命中）|
| 11 | prepaid-card | 11-prepaid-card.md | ✅ done | serious-edge-cases | 27 组 (card_id, type='充值', ref_order_id) 三元组重复 38 行 ¥35,692.80（schema 缺 UNIQUE 兜底，运行时 6 处 SELECT-then-INSERT 幂等并发可双写，根因 1 sale_order 多 sale_item 时幂等键粒度不到 sale_item_id）+ 1 张运行时充值订单 FY-XSD-WX-2604160002 ¥2500 status='已支付' 但 0 充值流水（payNotify L246-250 product_kind JOIN 漏匹配）+ schema 缺 CHECK(balance>=0)/amount 符号匹配 type + 130 行 expire_date<NOW 已过期 sale_items 仍被聚合进余额（migrate-prepaid-cards 漏过滤 expire_date）+ 200+ 行 product_name 命中"充卡/充值ym/微电充值"等关键字漏命中；扩展候选 10 个（P0×1 expire_date / P1×5 含 sale_item_id 解决幂等粒度+card_name+is_gift+face_value+original_amount / P2×4），MSSQL 凭据失败但 doc 验证 P0/P1 字段全部已落到 sale_items；8 维命中 6 维（FK 0、NULL 1、enum 0、unique 1HIGH、跨模块 1HIGH、死代码 2、drift 1、运行时 1HIGH）|
| 12 | message | 12-message.md | ✅ done | serious-edge-cases | share-gift 三副本写 `ref_entity_type='sale_order'` 但前端 `messages.ts:114` 期望 `'order'` 字符串不等致分享礼跳详情 100% 失败 + cron 三 STEP refEntity 全 NULL 致升级/生日/感恩消息点击无反应 + `recipient_type='员工'` 死分支（7 入口 0 写、staffApi 无路由、admin UI 已实现） + 6/7 生产入口 17 天 0 写入（cron+share-gift+batch 全空） + 唯一行 id=2 title='测试' 测试残留；扩展候选 9 个（P0×2 read_at/priority / P1×4 / P2×2 / P3×1），0 WF 反推（MSSQL 凭据过期回退 doc 全文 0 命中确认 R1 结论）；8 维命中 6（仅 FK 孤立 + unique 干净，unique 因数据量=1 未实证） |
| 13 | operation-log | 13-operation-log.md | ✅ done | minor-issues | 11 cloudfunc 副本入口 45 天 0 行真实产出（生产沉默）+ permission_role target_id 异质化（14 emp_id / 8 db_id）伪同实体聚类 + detail 明文 PII（phone×17 / idCard×11） + 双击同秒重复无 unique 兜底（id 243/244 detail 完全相等） + admin 路径 audit 用全局 db 不在主事务内（幻影日志风险）+ source 注释 stale；扩展候选 12 个（P0×3 request_id+索引/client_ip / P1×5 / P2×3 / P3×1），MSSQL tb_sys_log 2,089,146 行 100% 平台日志业务关键字仅 22 行管理动作 → 0 字段可反推；8 维命中 5（FK/NULL/drift 干净，enum/unique/跨模块/死代码/运行时安全 命中）|
| 14 | service-commission | 14-service-commission.md | ✅ done | serious-edge-cases | matrix `服务单` 仅 2 条规则覆盖率 1.7%（21 市场 × 3 角色 × 3 sales_category 应有 ~189 组合，实有 2）→ runtime service.complete 命中推广师/他销他耗任一即 silent rate=0 + 22.86M/11.76M/9.99M 三笔脏数据未做 sess_used 卫语句固化到 PG（合计 ~50M 占总 84M 的 60%）+ runtime 调用 3 次产出 0 行 svcComm（commission_status NULL 残留 3 行）+ admin batchSave 双步 UPDATE+INSERT 无 advisory lock 并发脏读 + mgmt-dashboard 推广师 1,160 行 silent 剔除 + sale_allocations 推广师 127 名 vs svcComm 推广师 10 名割裂 + commission_rate 90% rate=1.0 字段语义破损 + service_date 跨 7 年含 2055/2099 脏数据；扩展候选 10 个（P0×3 is_gift/satisfaction/position_name / P1×4 commission_kind/matrix_rule_id/duration_minutes/is_void_reason / P2×3 item_count/legacy_filled_at/legacy_card_validity_until），MSSQL 凭据已过期依赖 R1+workfine_database.md 字段表反推；8 维命中 6（FK 0 + unique 0 干净，其余 6 维全 HIGH/MED）|
| 15 | pickup | 15-pickup.md | ✅ done | minor-issues | staffApi createPickup 仅 requireStaffBound 缺 requireManager 任意已绑定员工可写 + createConversion 单品分支 UPDATE picked_up_quantity=quantity 旁路清零不写 pickup_records 致流水汇总与 sale_items.picked_up_quantity 永久不等 + schema 缺 CHECK(picked_up_quantity<=quantity) 无 DB 兜底；扩展候选 10 个（P0×1 CHECK / P1×5 sale_order_id+product_snapshot+delivery_method+address+confirmed_by_role / P2×3 batch_id+cancel 三件套+phone_snapshot / P3×1 signature_url）；WF 反推 0（R1+R1复核+R2 三轮一致 WF 完全无 pickup 实体，MSSQL R2 凭据过期复用 R1 8 套关键字探针）；8 维命中 4（FK/NULL/enum/unique/drift 0；跨模块一致性 2HIGH+死代码 2+运行时安全 2HIGH） |
| 16 | store-unbind | 16-store-unbind.md | ✅ done | serious-edge-cases | clientApi requestUnbind 列名 P0 bug（已 R1 自报）+ R2 新挖 partial unique 兜底缺失（双击并发可生成 2 行 pending 待处理悬挂，从"放量性能差"升级为"正确性问题"）+ bound_employee_id 隐式不变量风险（5434 实测 4218 行均叠 bound_store_id 之上、emp_only_orphan=0；staff 路径仅清 store_id 会逐渐打破"绑员工必绑门店"不变量）+ 审批并发双写 audit + scopeCondition+LIMIT 顺序 + NULL/空串兜底；扩展候选 6 个（P0×0 / P1×3 cancelled_at+cancel_reason / requested_employee_id / reviewed_via / P2×3 from_store_name 快照 / expected_response_at SLA / unbind_reason_category），WF 三轮 0 命中（无反推）；8 维命中 6（FK + drift 干净，其余 6 维全命中：HIGH×3 + MED×1 + LOW×2）|
| 17 | system-config | 17-system-config.md | ✅ done | serious-edge-cases | admin saveSettings 跨进程广播工程不全 — staffApi/payNotify 的 invalidateCache 是死代码（staffApi index.js grep `config.invalidateConfig` 0 hits 实证）+ saveSettings/saveMemberBenefits 4-3 次 UPSERT 无事务（实测 4 个键 updated_at 戳跨 4 秒撕裂窗口）+ banner 三重存储跨域无原子性 + points_to_yuan_rate 无 schema CHECK 可静默写 -1 + admin 多实例部署 unstable_cache 5 分钟跨实例不一致 + 三处内联 CREATE TABLE IF NOT EXISTS baseline 后冗余触 ACCESS EXCLUSIVE LOCK；扩展候选 9 个（P0×2 拆分 value_type/description+category / P1×4 is_secret+editable_by+prev_value+updated_by_employee_id / P2×3 key 正则 CHECK / effective_at-expires_at / version 单调号），R2 重判 WF tb_sys_setting 仍为平台元数据零业务参数；8 维命中 6（FK/enum/unique 干净，NULL/空串/极值实测全 0 干净；跨模块/死代码/drift/运行时安全 全命中）|

## R1 vs R2 区别

| 维度 | R1（已完成） | R2（本轮） |
|------|------------|----------|
| 起点 | 先调研后读文档（防 confirmation bias） | 直接主动挖（不限文档边界） |
| 关注 | 文档准确性 | 文档外的隐藏问题 |
| 输出 | accept / minor-fix / major-rework | clean / minor-issues / serious-edge-cases / blocking-issue |
| 探针 | 字段映射对照 | 8 类风险维度逐项 |
