# Admin 数据中心数据准确性审计

- 审计日期：2026-09-22
- 审计基线：`dev@910c280f2aadd5cc50bf212beb236200272bb730`
- 数据来源：生产只读库 `fengyu_ro@118.178.196.26:5433/fengyu_wxapp`（截至 2026-09-21 20:00 的生产数据）
- 口径基准：`notes/references/metrics.md`（910 行）
- 方法：7 条独立审计视角并行 → 每条发现由独立审计员在生产库复算并尝试证伪 → 完整性批评 + 首席审计员裁决
- 规模：28 条发现进入对抗验证，18 条存活（{"P0": 6, "P2": 6, "P1": 5, "P3": 1}），10 条被证伪
- 状态：已出清单，待修复（对应 issues 见文末）

> 本文由多 agent 审计 workflow 产出，关键数字均在生产只读库复算。
> 存活发现经合并同类项后约为 8–10 个互不相同的缺陷，逐条明细见附录 A。

---

# 数据中心数据准确性审计报告

审计日期 2026-09-22 ｜ 审计对象：admin 数据中心四板块（销售 / 客量 / 人效 / 品项）+ 公共层（时间轴、scope、对比）
数据来源：生产只读库 `fengyu_ro@118.178.196.26:5433`。7 条视角的发现全部经过独立对抗验证，本人另对 4 条 P0 的关键数字做了逐条复算（结果见下，与验证员完全一致）。

---

## 结论

**绝对值（金额、人数、单数）大体可信；派生比率和所有「环比」徽章大面积不可信。**

- **可以直接用来做决策的**：销售板的总业绩 / 生美业绩 / 实耗绝对值、人效板的门店排行榜、客量板的新增会员数与服务人次、各板块的明细表金额列。
- **现在不能用来做决策的**：① 所有 KPI 卡的「环比」徽章（默认视图下约 20 张卡系统性失真，客量板「服务人次」环比方向是反的）；② 客量板「成交率」（整列虚高，生产数据上会渲染出 800%）；③ 人效板「员工人均业绩 / 技师人均业绩」（虚高 30%，且与同页门店榜对同一个「业绩」差 111 万）；④ 品项板整体（新增人数明细漏掉 2/3、持卡占比恒为 253%、新增/复购业绩单向虚高 12%，且底层被寄存单迁移主导）。
- **根本性的外部约束**：库里款项流水最早 2026-07-03、服务单最早 2026-07-08，而会员档案回溯到 2022-08。**任何跨 2026-07-03 的区间（包括预设「今年」），凡是"分子来自交易、分母来自档案"的指标都会结构性失真。** 这不是代码 bug，但它是多条问题的共同放大器，也意味着「今年」这个预设在 2027-01-01 之前都不该当经营对比用。

一句话给决策：**看绝对值、看当期、看单一板块——可信；看环比、看比率、跨板块对账——现在会被误导。**

---

## 问题清单

### 确认的缺陷（代码错，需要修）

| 级别 | 板块 | 指标 | 问题 | 影响（实测数字） | 建议 |
|---|---|---|---|---|---|
| **P0** | 公共层 | 全部 KPI 的「环比」 | 本周/本月预设拿「残缺当期」比「完整上周期」：当期是 9/1–9/22（22 天），基期是整个 8 月（31 天） | 总业绩环比显示 **+6.35%**，等长口径是 **+30.76%**；实耗显示 −24.60%，实际 −2.77%（差 8.9 倍）；**客量板「服务人次」显示 −16.93%（红色下滑），真实 +16.31%（增长）——符号翻转**。同一当期窗口改选「自定义 09-01~09-22」环比跳到 +46.39%，同一块卡片两个值差 40pp。影响约 20 张流量型卡，人效板无环比不受影响 | 把 week/month 的基期改成等长（与同文件 today/year/custom 三个分支一致），同步改 `time-range.test.ts:34-48` 两条断言 |
| **P0** | 客量 | 成交率 convRate | 分母用 `customer_type` **当前快照** IN ('体验客','小美客')，而该字段只升不降 → 本期成功转化的人当期已变成「会员客」，被从分母整体抹掉，而他们正是分子 | 集团 9 月 149/533 = **27.95%**，补回 139 名本期转化者后 149/672 = **22.17%**（虚高 26%）。35 家有新会员的门店**全部虚高**，12 家超真实值 1.5 倍。2026-08 九江长江店 8/1 → 看板输出 **800.00%**；真实转化率 100% 的南昌云暖店、九江长江店反而显示 **'--'** | 分母改为「期初未达会员的到店活跃池」。四处同改：`customer.ts:395-411`、`:731-740`、staff `mgmt-traffic.js:491`、`consistency.customer.test.ts:484-491` |
| **P0** | 人效 | 员工人均业绩 / 技师人均业绩 | 分子直接 `SUM(allocated_amount)`，同一笔钱按美容师/品项老师/养生师等多个角色各算一份（写入侧按设计允许单票 ratio 合计 2.0 / 3.0） | 9/1–9/21 分子 **4,786,941.55**，同批票据实收 **3,680,919.90**（+30.05%，重复计 127.6 万；另有 950 张票据零分配、5.8 万完全漏计，偏差方向不统一，无法用系数校正）。人均业绩看板 31,912.94，按 metrics.md:428 口径应为 **24,481.45**。同页「门店排名榜-业绩」走另一口径 3,672,217.98，**同一页对同一个「业绩」差 111 万** | 分子换成与销售板/门店榜同源的 `SUM(spe.amount)`；同步改 `consistency.efficiency.test.ts:76-84`（该断言目前把错误写法钉死） |
| **P0** | 品项 | 新增人数 / 新增客单价 / 复购率（明细表） | KPI 用 LEFT JOIN 算全部进入顾客，明细表用 INNER JOIN 归店，凡「进入达标日金额全来自寄存单」的顾客被整体丢弃 | 今年 KPI **2429 人**，按市场/门店明细相加只有 **832 人**（漏 65.7%，且 0 跨店重复）；本月 672 vs 280。业绩两边相等（800.54 万）说明只丢人不丢钱 → 客单价 3,295.77 被算成 9,622.13、复购率 11.32% 被算成 33.05%（**均虚高 2.92 倍**）。单店视角更极端：南昌梦祥店 KPI 133 / 明细 31，同屏差 4.3 倍 | 给 `xinzeng` 补门店归属维度后改成 LEFT JOIN（`product.ts:444-451`），并修正 `product.ts:341-347` 已被数据推翻的注释 |
| **P1** | 品项 | 持卡占比 cardHolderRate | 分子数「买过带次数商品的所有顾客」（不限客型），分母只数会员，两个人群总体不同 | 集团 **4804 / 1897 = 253.24%**（已复算）；40 家在营门店 **36 家 >100%**，南昌春天店 52/2 = **2600%**，按市场最高 1155%。分子里 2922 人（60.8%）永远不可能进分母。分子加会员条件后 **1882/1897 = 99.21%**，各店几乎无差异——说明现行列的全部店间方差都来自"非会员数量"，按它排名会得到**相反**的结论 | 分子分母同源（推荐分子加 `became_member_at IS NOT NULL`）。四处同改 + `metrics.md:726/731-732`；顺手修 `product-board.tsx:17/18/122` 三处过期提示文案 |
| **P1** | 客量 | 新客客单价 newCustomerAvgTicket | 分母读会员档案（回溯 2022-08），分子读款项流水（最早 2026-07-03），跨割点区间分母含大量「幽灵人头」 | 「今年」预设：581 人 / 323.68 万 = **5,571.08**。其中割点前入会的 234 人里 **173 人分子为 0**，但他们同期有 **687 张 workfine 单、已收 215.97 万**。补回后应为 **9,411.49**（现值低报 41%）。门店级更极端：南昌青云店 74% 的分母是幽灵，客单被压到 1,183.97 | 给分子补 legacy 分支（复用 `metrics.md:541` 顾客详情页年度消费的现成口径）；或分母同步隔离并在跨割点区间加数据起点提示 |
| **P1** | 品项 | 新增业绩 / 复购业绩 / 两个客单价 | `HAVING SUM > 0` + `purchase_received > 0` 联合把「当日净额为负」的组整批丢弃，退款负数冲销被吞 | 今年新增业绩 **800.54 万 vs 净额 713.96 万，虚高 86.58 万（+12.13%）**；复购业绩 +7.01%。门店级最高自贡贡井店 +30.4%、南昌江信店虚高 9.40 万。**决定性证据：同一批退款有 38% 被净入业绩、62% 被吞，取决于当日净额符号——没有任何业务规则能这样表述** | 两处符号条件从 `> 0` 改 `<> 0`（语义"剔除纯寄存日"不变）。跨端同步 staff `mgmt-product.js:284` + 两条字面量快照 |
| **P1** | 公共层 | 全部 KPI 的环比/同比 | `deltaPct` 只挡了基期 =0 和 null，没挡 **基期 <0**，负分母翻转符号 | 加上在营门店过滤后，相邻两日「基期为负」的组合 **29 对、19 家门店，当期值全部 >0（真实向好），却全部渲染成红色负增长**，区间 −100.68% ~ **−54,080,100.00%**。「本周」预设已命中 8 例；南昌梦时代 9 月当月净业绩 −6,104，进入 10 月后选「本月」必然翻向 | `comparison.ts:22` 改为 `base <= 0 → null`（与 metrics.md:610「算不出一律 '--'」同源），补三条负基期用例 |
| **P2** | 销售 | 流量客业绩（卡片说明文字） | SQL 是 `customer_type = '流量客'`（仅纯流量客，2026-05-26 已拍板），但卡片 hint 写「流量/体验/小美客」 | 9 月卡面 **19.72 万**，hint 暗示的三类合计 **40.48 万**，差 20.76 万（卡面只占 48.7%）；YTD 差 37.38 万。加重情节：客量板的「流量客人数」= 体验+小美（**恰好不含纯流量客**），同一后台同名异义 | 改一行文案 `sales-board.tsx:21` → "仅纯流量客"；顺便给客量板「流量客人数」补 hint |
| **P2** | 销售 | 按市场明细「门店数」+ 4 个店均列 | KPI 做了开闭店历史化，明细表直接数骨架行数，两者不同源 | 明细恒 **40**；KPI 在区间末 2026-06-30 为 **39**、2025-09-22 为 **33**。驱动者是南昌太一店（2026-07-01 开业）。**当前金额差 0**（40 店在首笔业绩前已全开），但 4 个店均列分母结构上偏大。同一板块的人效板「店长人数」已做对历史化，两块看板会自相矛盾 | 改成与 `efficiency.ts:262-271` 同型的 per-store 历史化查询；把 `consistency.sales.test.ts:170-180` 的守护从"文件里出现过一次"收紧为按查询块断言 |

### 待业务拍板的口径争议（**不是 bug，代码与文档一致，但数字会误导**）

| 议题 | 现状与实测 | 需要拍什么板 |
|---|---|---|
| **员工数 / 技师人数 = 150 还是 164** | 14 名直挂养生部/品项公司的在职养生师 `store_id` 为空，被 `IN (...)` 的三值逻辑吞掉。**分子含他们的产出**（9 月 428 行提成、16.6 万实耗，占 4.7%），**分母不含他们的人头**。代码与 `metrics.md:161` 逐字相符 | 「产能技师在职数」按档案挂点算还是按实际产出算。注意按门店明细无论如何塞不下这 14 人（只能落到按市场） |
| **一次/二次客活按服务单行数还是到店天数** | 数据中心用 `COUNT(*)`（569/865），项目自己的 `monthly_activity` 列用 `COUNT(DISTINCT service_date)`（631/803）。**同一个 admin 里，顾客列表筛「二次客活」得 803 人、数据中心「当月二次人数」显示 865，差 62 人**。这 62 人全是同店同日拆成 2~3 张服务单，没有一人跨店。cron 注释白纸黑字写「非服务单次数」，metrics.md:260 写的却是 `COUNT(*)` | 两套定义必须统一（我倾向「天」）。改哪一侧都要 5 处同步 + 在 metrics.md 补登 monthly_activity 口径（它目前在指标文档里完全缺席） |
| **员工排行榜选单店时显示"个人总产出"还是"本店产出"** | 员工榜的金额 CTE 不按 scope 过滤，scope 只筛"谁能上榜"。单店视角实耗榜虚高 2.8%（8.3 万/20 人）、业绩榜 1.6%；个别行 100% 来自外店（郭兰在九江快乐店榜上 13,939.86，本店实际 0）。**3 名验证员中 2 名判定这是已拍板的设计语义**（2026-04-25 ticket 明确"scope 决定谁出现、归属决定数字"，两端镜像一致） | 我采纳多数意见：**不是缺陷**。但门店店长（生产 60 人持此权限）会把它误读成"我店业绩的员工拆分"。最小成本是加列头说明，不改 SQL |
| **沉睡/冰冻/休眠三档与"激活"三档不同轴** | 左边三格读 cron 每日快照（不随时间筛选变化，今天集团 68 人），右边三格按所选区间实时反推。选「今年」时并排显示 **68 vs 1273（18.7 倍）**。metrics.md:244-246 已显式说明这是为性能做的取舍 | 不建议改口径（历史重建代价大）。照抄品项板已有的"截面"角标范式即可 |
| **生美业绩采「父订单已结清」口径** | 代码与 `metrics.md:14` 逐字相符（该视图根本没有款项级 status 列，裸 status 只能是父订单）。后果是 **历史月份数字会事后变动**：2026-09 单月 157,505 元（占该月 12.1%）随订单结清而追加，13 张 7 月单至今未结清 | 是否接受"上月报表这个月还会变"。若不接受，需要重新定义口径而不是改 SQL |

---

## 各板块体检结论

| 板块 | 结论 | 可信度 |
|---|---|---|
| **销售** | 总业绩 / 生美业绩 / 实耗的**绝对值口径正确、与 staff 端零漂移**，可直接用。问题集中在派生层：11 张卡的环比徽章全错、「流量客业绩」数字对而说明文字错（差 20.76 万）、按市场明细的门店数在历史区间会与 KPI 打架 | **绝对值可信；环比不可信** |
| **客量** | 新增会员数、服务人次、到店人数这类计数可信。**成交率整列不可用**（虚高 26%，能输出 800%，真实 100% 的店反而显示 '--'）；**新客客单价在跨 2026-07-03 的区间不可用**（低报 41%）；一次/二次客活与同后台顾客列表差 62 人；沉睡 0 / 冰冻 0 / 休眠 68 是数据起点所限（到店史仅 75 天），不是 bug，沉睡档 2026-10-10 自愈 | **计数可信；比率不可信** |
| **人效** | **两张 KPI 大卡（员工人均业绩、技师人均业绩）虚高 30%，且与同页门店排行榜对同一个「业绩」差 111 万，不可用**。门店排行榜（走 `spe.amount`）可信。员工排行榜每一行的数值本身正确，但语义是"员工全域产出"，单店视角下别当本店业绩拆分读。本板块**没有环比功能**，不受时间轴缺陷影响 | **门店榜可信；人均 KPI 不可信** |
| **品项** | **问题最集中的板块，当前整体不建议用于经营决策。** 明细「新增人数」漏 65.7%、持卡占比恒 253%（单店 2600%）、新增/复购业绩单向虚高 12%。更糟的是底层：9709 张寄存单（3858 万业绩事件）的日期全是 2026-07~09 的**录入日**而非历史购卡日，库里根本没有原始购卡日可用，8 月「品项进入人数」1384 人 vs 剔除寄存单的反事实 363 人（3.8 倍）。**这个数符合已拍板口径，但它反映的是迁移节奏不是经营变化** | **不可信** |
| **公共层（时间轴 + scope）** | 时间轴两处缺陷（本周/本月基期不等长、基期为负翻符号）影响全站徽章，是本次最高性价比的修复点——两个文件、不到 20 行。**scope 权限闸门本身没有越权泄漏**：所有被审查的查询返回的都是 scope 内实体，跨市场越界金额实测为 0（员工榜的跨店金额争议属口径而非越权） | **scope 可信；时间轴不可信** |
| **上游数据质量** | 三条时间轴深度严重不一致：款项流水 2026-07-03 起、服务单 2026-07-08 起、会员档案 2022-08 起（跨 50 个月）；18,761 张 workfine 历史单在款项事件视图里**产生 0 行**。另有两项需另开单：① **`bound_employee_id` 覆盖率从 7 月 63.5% 断崖跌到 9 月 20.8%**，疑似 8 月起某条写入链路在批量丢绑定（这会让员工榜"新会员"只覆盖 31/149）；② 14 名直挂员工 `store_id` 为空，其中王志军的 `org_node_id` 指向在营门店节点却无 store_id（`metrics.md:133` 已登记为档案缺失，至今靠代码反查兜底） | **需单独治理** |

---

## 我与验证员的分歧（3 处）

1. **环比基期不等长的定级：两位验证员分别给了 P0 和 P2，我裁 P0。**
   给 P2 的理由是"当期值没算错、delta 在自己定义下自洽"。但这条同时满足三个条件：默认视图打开即错、每个自然月只有最后一天是对的（其余 28~30 天全错）、且在生产数据上出现了**方向翻转**（服务人次显示红色 −16.93%、真实 +16.31%）。徽章的唯一作用就是给人读方向，方向反了就不是"口径偏好"。维持 P0。

2. **持卡占比的定级：一位验证员给 P0，两位给 P1，我裁 P1。**
   不是因为它不严重，而是因为 253%/2600% 荒谬到读数人会自己识破，实际造成的错误决策**少于**那些"看起来合理但错了"的指标（如 +6.35% 的环比、27.95% 的成交率）。按"会造成多少错误决策"排序，它应排在 4 条 P0 之后。修复成本很低，建议与批次 3 一起做。

3. **人效「人均业绩」的归因：两位验证员都判 P0，但归因不同，我采纳 receipt 级对账那一版，明确否定另一版。**
   有一版把主因归给"106 名无门店员工的 141 万进了分子、人头没进分母"。经四象限拆解，这个机制**只占差额的 1.8%**；真正的主因是 `23405ddf` 那次表迁移重构**无声删掉了 role_type 白名单**，导致同一笔钱按角色重复求和（单票 ratio 合计 2.0 的 848 张、3.0 的 124 张）。**按错误归因去修（剔分子里的无门店员工，或把他们并入分母）会得到 22,490 / 28,493 两个同样错误的数**，正确目标值是 24,481.45。这条一定要在工单里写清楚。

另外三条被证伪的发现我同意判定，但残留议题不应丢：**寄存单主导品项板**（代码无错、数字不可读）、**生美业绩会事后变动**（口径后果）、**bound_employee_id 覆盖率塌方**（上游写入链路，与取数无关但更该查）。

---

## 修复优先级建议

### 批次 1 — 纯前端文案（零数据风险，今天就能上）
| 改动 | 文件 | 跨端 | snapshot |
|---|---|---|---|
| 流量客业绩 hint 改「仅纯流量客」 | `sales-board.tsx:21` | 否 | 否 |
| 持卡人数/持卡占比三处过期 hint（现行 SQL 既不看 remaining 也不看 product_type） | `product-board.tsx:17/18/122` | 否 | 否 |
| 沉睡/冰冻/休眠加"截面"角标 + 明细表头标注 | `customer-board.tsx` | 否 | 否 |
| 客量板「流量客人数」补 hint（=体验+小美，消除同名异义） | `customer-board.tsx` | 否 | 否 |

### 批次 2 — 公共层（影响面最大、改动最小，**最高性价比**）
| 改动 | 文件 | 跨端 | snapshot |
|---|---|---|---|
| week/month 基期改等长 | `time-range.ts:106-116` | 否（staff 无环比功能） | 否，但必须同改 `time-range.test.ts:34-48` 两条**反向钉死**的断言 |
| `deltaPct` 挡住基期 ≤0 | `comparison.ts:22` | 否 | 否，补 `comparison.test.ts` 三条负基期用例 |

> 两处合计不到 20 行，不碰任何 SQL、不碰库、不碰 staff 端，一次性修好全站约 20 张卡的环比。**建议先做这一批。**

### 批次 3 — 口径修复（改查询，**不改库结构**，但需跨端同步 + 更新字面量快照）
| 改动 | 涉及文件 | 跨端 | snapshot |
|---|---|---|---|
| 人效人均业绩分子换 `SUM(spe.amount)`（P0，metrics.md:428 已有明确口径，**无需拍板**） | `efficiency.ts:141-152`、`:286-298` | 否 | **是**：`consistency.efficiency.test.ts:76-84` 目前把错误写法钉死，必须同改 |
| 成交率分母改"期初未达会员的活跃池"（P0） | `customer.ts:395-411`、`:731-740` | **是**：staff `mgmt-traffic.js:491` | **是**：`consistency.customer.test.ts:484-491` + `metrics.md:395-409` |
| 品项明细 newCount 改 LEFT JOIN 归店（P0） | `product.ts:444-451` + 修正 `:341-347` 注释 | 否（staff 无 byStore 明细） | 需**新增**断言："单店 scope 下明细 == KPI" |
| 退款负数不再整组丢弃：`> 0` → `<> 0`（P1） | `product.ts:209/230/393/414` | **是**：staff `mgmt-product.js:284` | **是**：`consistency.product.test.ts:167` + `mgmt-product.test.js:395` + `metrics.md:777/797` |
| 持卡占比分子分母同源（P1，搭车做） | `product.ts:133-147`、`:293-312` | **是**：staff `mgmt-product.js:138-148` | **是** + `metrics.md:726/731-732`；把 `product.test.ts` 夹具从 10/40 改成会触发 >100% 的组合 |
| byMarket 门店数历史化（P2，搭车做） | `sales.ts:466` + 新增 per-store 查询 | 否 | 收紧 `consistency.sales.test.ts:170-180` |

> ⚠️ 全仓禁跨端共享代码，四端各自副本靠字面量 snapshot 守护。**改一端不改另一端 = 测试立刻红**；这批里有 3 项是双端改动，必须放在同一个 PR。

### 批次 4 — 需产品先拍板，再动代码
1. 新客客单价跨割点（P1）：给分子补 legacy 分支（推荐，有 `metrics.md:541` 现成先例）还是分母同步隔离 + 加数据起点提示。
2. 员工数 150 还是 164。
3. 一次/二次客活按行还是按天（顺带把 `monthly_activity` 口径补进 metrics.md——它目前完全缺席，这是两套定义分叉的根因）。
4. 员工榜选单店时的数值语义。
5. 生美业绩「已结清单」口径是否接受历史月份事后变动。

### 批次 5 — 数据治理（不属于数据中心，但影响看板可读性）
1. 查 `bound_employee_id` 覆盖率 8 月起的断崖（63.5% → 20.8%），定位写入链路。
2. 补 14 名直挂员工的 `store_id`（特别是王志军：org 节点指向在营门店却无 store_id）。
3. 评估是否为迁移期（2026-07~09）给品项板另设一个剔除寄存单的视图——否则"品项进入人数"这条趋势线在 2026 年内都没有经营含义。

---

### 附：本人复算的数字（生产只读库，2026-09-22）

| 指标 | 复算结果 | 与验证员 |
|---|---|---|
| 总业绩 当期 9/1–9/22 / 实现基期 8 月整月 / 等长基期 8/1–8/22 | 3,672,217.98 / 3,452,804.49 / 2,808,430.45 | 完全一致 |
| 服务人次 同上三组 | 5,998 / 7,220 / 5,157（→ 显示 −16.93%，真实 +16.31%） | 完全一致 |
| 成交率 9 月 分子/分母/被抹掉的已转化者 | 149 / 533 / 139 | 完全一致 |
| `became_member_at` 非空但 `customer_type ≠ 会员客` 的行数 | **0**（证明剔除是 100% 确定性的） | 完全一致 |
| 九江长江店 2026-08 新会员/分母 | 8 / 1 → **800.0%** | 完全一致 |
| 人效分子 SUM(allocated_amount) / 同批票据实收 | 4,786,941.55 / 3,622,448.88（+950 张零分配票 58,471.02 = 3,680,919.90） | 完全一致 |
| 品项 KPI 新增人数 / 明细合计 / 新增业绩 | 2,429 / 832 / 8,005,411.23 | 完全一致 |
| 持卡人数 / 会员数 / 同源后分子 | 4,804 / 1,897（=253.24%）/ 1,882（=99.21%） | 完全一致 |

---

# 数据中心审计 · 完整性批评

> 全部数字为我本人于 2026-09-22 在 prod 只读库（`fengyu_ro@118.178.196.26:5433`）跑出。仓库路径均为绝对路径。

---

## 0. 先于"漏查什么"：存活清单本身不可直接交付

13 条存活发现里只有 **8 个互不相同的缺陷**，且存在自相矛盾。下游若照单验证会重复投入并在定级上打架：

| 实际缺陷 | 存活条目数 | 定级冲突 | 冲突细节 |
|---|---|---|---|
| 环比基期与当期不等长 | **2** | P0 vs P2 | 影响面一说"约 20 张流量型卡"，一说"16 张"；一说 customer "6 处 `enabled=false`"，实际是 **8 处**（`customer.ts:965,966,968,969,970,971,972,973`） |
| 持卡占比分子分母不同源 | **3** | P0 vs P1 vs P1 | 数值 253.20% / 253.24% / 253.24%；破百门店数 36/40 vs "≥8 家 500%~2600%" |
| 人效人均业绩分子错 | **2** | 同为 P0，**根因归因互斥** | 一条说 role_type 重复求和（+30%），一条说 `store_id IS NULL` 漏分母（106 人/141 万）；两条给出的修法互相推翻 |
| 员工榜金额 CTE 无 scope | **1 存活(P2/UNCERTAIN) + 2 被证伪** | **直接矛盾** | 同一主张既"存活待产品拍板"又"REFUTED 非缺陷"，裁决结论缺失 |
| 无门店员工不进分母 | **1 存活(14 人) + 1 被证伪(27 人)** | 重叠 | 两条用不同人群口径算同一件事 |

**交付前必须先合并同类项并裁决第 4、5 行的矛盾**，否则"存活 13 条"这个数字本身是误导。

---

## 1. 零覆盖清单：7 条视角完全没碰过的指标 / 代码路径

### 1.1 `sales.ts`（502 行，覆盖率约 45%）
| 路径 | 指标 | 说明 |
|---|---|---|
| `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/sales.ts:99-110` `runStoreConsume` | 总实耗 KPI | **SQL 本体无人审**。只被当作环比算例引用过数值 |
| 同上 `:114-127` `runShengmeiConsume` | 生美实耗 KPI | 同上 |
| 同上 `:357-381`（byStore 实耗/生美实耗） | 明细两列 | 同上 |
| 同上 `:83-95` `runShengmeiRevenue` | 生美业绩 | 只被"父订单 status"那条（已 REFUTED）擦过；`si.is_shengmei` 的 NULL 行无人查 |
| 同上 `:53-56` `perStore()` + `:233/237/241/245` | 业绩店均 / 生美店均 / 实耗店均 / 生美实耗店均 | 只审了分母 `storeCount`，**四个派生值本身从未与库对账** |
| 同上 `:291-300` | byStore 技师人数 | 仅被 employeeCount 那条顺带提及，未独立核算 |

### 1.2 `customer.ts`（1081 行，覆盖率约 35% —— **缺口最大**）
以下 **8 个 KPI + 整张注册客活明细表** 无任何视角触及：

| 路径 | 指标 |
|---|---|
| `/Users/nv/.../actions/data-center/customer.ts:68-92` `queryRegistration` | **会员注册人数**（注意：会员档走 `became_member_at`，其余三档走 `created_at`，**同一函数两套时间轴**） |
| `customer.ts:96-115` `queryTrafficCount` | 流量人次 / 会员人次 / 客流人数 |
| `customer.ts:118-136` `queryProjectCount` | 服务项目数 |
| `customer.ts:138-153` `queryServiceCount` | 服务人次 |
| `customer.ts:155-173` `queryShengmeiConsume` | 生美实耗（单次客耗分子） |
| `customer.ts:294-320` `queryOperatedMembers` | 会员经营人数（**阈值 1990 硬编码**） |
| `customer.ts:323-352` `queryMemberAvgTicket` | 会员客单 |
| `customer.ts:872` `consumePerVisit` | 单次客耗（分子剔除寄存退款、分母不剔除） |
| `customer.ts:414-430` `queryRetainedMembers` | 有效保有会员（90 天窗口） |
| `customer.ts:481-650` `queryRegActiveBreakdown` **整个函数** | 明细表 10 列（会员注册/保有会员/回店1次/2次/达成率×2/沉睡/冰冻/休眠/激活×3）——客活 2 列被查过，**其余 8 列零覆盖** |
| `customer.ts:690-705` `spend_agg` | 6 档消费分桶 `<1990 / ≥1990 / ≥1万 / ≥3万 / ≥6万 / ≥10万` + 被经营总数，**六个阈值全硬编码** |

### 1.3 `efficiency.ts`（947 行，覆盖率约 40%）
- **Part A 六个未覆盖**：`:166-178` 销售提成合计、`:180-190` 服务提成合计、`:192-200` 客流、`:202-215` 项目数、`:217-228` 会员数、`:244-258` 店长人数
- **Part A KPI 四张卡未覆盖**：`:799-800/805-806` `managerAvgMembers` / `managerAvgEmployees` / `empAvgConsume` / `empAvgProjects`
- **Part B 全部 9 条 by-store 查询未覆盖**：`:263-272 / :274-284 / :301-311 / :313-324 / :326-339 / :341-355 / :357-367 / :369-386`
- **byMarket 9 列中 7 列未覆盖**：`managerCount / managerAvgIncome / techAvgConsume / techAvgShengmeiConsume / techAvgIncome / techAvgMembers / techAvgProjects`（`columns.ts:180-190`）
- **Part C 门店排行榜 5 项全部未覆盖**：`:388-478`（业绩/实耗/保有会员/新会员/项目数）
- **Part E `qStaffDetail` 的 6 列未覆盖**：`:667-757` 的 `sales_category` 四分类销售额、`serviceHeadcount`、`serviceVisits`

### 1.4 `product.ts`（685 行）
- `/Users/nv/.../actions/data-center/product.ts:75-94` `resolveGrouping` + `:99-125` `queryFilterOptions` —— **二级品项下钻整条链零覆盖**
- `trialCount` / `repurchaseCount` / `repurchaseRate` 三个指标（只在被 REFUTED 的"体验∩新增重叠"里擦边）
- `product.ts:318-346` `queryMemberCountByStore`、`:502-513` `buildMetrics`

### 1.5 公共层 `lib/data-center/`
| 文件 | 状态 |
|---|---|
| `export.ts`（22 行） | **零覆盖**。`metricCell` 对 percent 做 `Math.round(v*10000)/100` |
| `consume-filter.ts`（24 行） | 零覆盖（寄存退款排除的覆盖面无人核） |
| `context.ts`（122 行） | `validateScope` / `getScopeTopLevel` / `resolveScopeName` 零覆盖 |
| `params.ts`（109 行） | `parseScope` / `parseTimeRange` / `singleValueQuery` 零覆盖（custom 无上下限 clamp 只被顺带提及） |
| `scope-options.ts`、`types.ts`、`columns.ts` | 零覆盖 |
| `format.ts` | 只有 `formatPercent` 被提及；`formatAmount`/`formatCount`/`formatDelta` 未覆盖 |

### 1.6 展示与导出层
`breakdown-table.tsx`、`ranking-board.tsx`、`scope-time-filter.tsx`、`[board]/page.tsx`（默认 scope redirect 与空态分支）、`export-worker/registry.ts:527-562` —— **全部零覆盖**。

---

## 2. "看起来正常所以没人查"的高风险点

### 2.1 我已实测、今天没洞 —— 可直接关闭，别再花预算

| 疑点 | 实测结论 |
|---|---|
| **缓存 / `force-dynamic`** | `data-center/page.tsx:4` 与 `[board]/page.tsx:22` 均 `export const dynamic = "force-dynamic"`，板块是 client + `useEffect` 直调 action → **无缓存风险，可排除** |
| **导出与看板是否同源** | 同源。`/Users/nv/.../src/export-worker/registry.ts:533-562` 直接调 `getSalesBoard/getCustomerBoard/getProductBoard/getEfficiencyBoard`，列配置共用 `lib/data-center/columns.ts`；URL 参数名 `kind`/`category` 两侧一致 → **无漂移** |
| **导出是否越权** | 无。`export-worker/index.ts:207-212` 用 `parseExportSession(job.scopeSnapshot)` + `runWithExportSession` 注入发起人权限快照，`withPermission` 正常生效 |
| **日期边界（timestamp vs date / 闭区间）** | `service_orders.service_date`、两个 `*_performance_events.performance_date` **均为 `date` 类型** → `BETWEEN` 双闭合安全，**整类怀疑可排除** |
| **`spe.store_id` vs `so.store_id` 双归属轴**（总业绩用前者、新增客/流量客业绩用后者） | 2026 全年 88,696 条事件，`store_id` 分歧 **0 行 / ¥0.00**，`legacy_source`、`sale_order_type` 分歧亦为 0 → **潜伏，非现症** |
| **sales 实耗多出的 `JOIN sale_items si`**（`sales.ts:102/119/362/375`；efficiency/customer 同名指标**没有**这个 JOIN） | 本月 9,231 行服务子项，`sale_item_id IS NULL` **0 行**、悬挂 FK **0 行**，两种写法差 **¥0.00** → **潜伏，非现症**（一旦出现无源服务子项，销售板实耗会低于人效板） |
| **客量板 KPI ↔ 明细合计（消费分桶族）** | 本月 scope=all：被经营 KPI 340 = 明细合计 340；会员行数 471 = 471；会员客单 ¥6,894.10 = ¥6,894.10（本月无跨市场消费会员）→ **今天对得上**。⚠️ 副产品：3 名会员本月净消费为**负**，被计入 `<1990` 档与会员客单分母 |
| **`stores.is_closed` vs `org_nodes.is_active` 两套闭店标记**（scope 下拉用前者 `shared.ts:62`，全部取数用后者 `scope-sql.ts:36-37`） | 3 家门店两标记不一致（九江中辉店、南昌龙大店：节点停用但 `is_closed=false`；自贡旭阳店：节点停用且 `is_closed=true`），**方向一致均被两侧排除** → 今天无洞，但双标记体系是长期隐患 |

### 2.2 未被任何视角触及、且我已拿到证据的真实风险

**(a) 员工排行榜用 `WHERE COALESCE(v,0) > 0` 把负值员工整行吞掉 —— 与"退款负数冲销不删行"红线冲突**

`/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/efficiency.ts:549`（业绩）、`:573`（实耗）、`:591`（新会员）、`:618`（项目数）、`:651`（收入）五处。

实测（2026-09-01~09-22，prod）：**2 名员工净业绩为 −11,200.00**，被 `> 0` 从业绩榜整体剔除；但同一笔钱**已计入** `qRevenueTotal`（`efficiency.ts:141-152` 无 `>0` 过滤）。即"员工榜合计 ≠ KPI 分子"除了已确认的 role_type 重复计外，**还额外差 11,200 元**，且方向相反。同板块的**门店排行榜（`:388-478`）没有这个过滤，零值/负值门店照常出行** —— Part C 与 Part D 规则不一致。YTD 口径下为 0 人，说明这是**月度尺度才浮现**的现症，默认"本月"视图正好命中。

**(b) 整个 `::date` 族依赖一个从未被断言的会话时区**

`client_wechat_users.became_member_at` / `created_at` 是 `timestamptz`，而代码到处写 `became_member_at::date BETWEEN ...`（`customer.ts:360/366/497/577/722`、`sales.ts:135`、`efficiency.ts:220/451/583/705`）。`::date` 取决于会话 `TimeZone`。

实测：**1,567 / 1,898 名会员（82.6%）的 `became_member_at` 精确等于北京时间 `00:00:00`**（回填产物）；`1,571` 人在 UTC 解读下会跨到前一天。`/Users/nv/.../fengyu-admin/src/db/index.ts:28` 用 `postgres(connectionString, { max: 5 })`，**不显式设时区**，纯靠服务端默认（当前 `SHOW timezone` = `Asia/Shanghai`，无 `pg_db_role_setting` 覆盖）。全仓没有任何测试或启动断言守护这一点 —— 一次连接串换库或容器环境变化，**新增会员数 / 新客客单 / 成交率 / 会员注册 / 激活三档 全族跨日**。

**(c) 阈值 1990 在三处硬编码，与 `system_configs` 单源冲突**

`customer.ts:317`（会员经营人数）与 `customer.ts:691-697`（6 档分桶）把 `1990 / 10000 / 30000 / 60000 / 100000` 写死；而品项板读的是 `system_configs.new_member_threshold`（实测 = 1990，验证员已确认）。一旦业务改配置，**客量板与品项板当场分叉，且客量板不会有任何报错**。

**(d) `is_shengmei` 分属两张表，且已有不一致行**

生美**业绩**读 `sale_items.is_shengmei`（`sales.ts:90/319`），生美**实耗**读 `service_items.is_shengmei`（`sales.ts:105/121/372`、`customer.ts:169`、`efficiency.ts:317`）。实测 `sale_items.is_shengmei` **23 行为 NULL**（静默不计生美但计入总）；`service_items` 与其父 `sale_items` 的标记 **4 行不一致**。量级很小，但"生美占比"类横向对比无源可对账。

**(e) 权限降级时 0 与空态混淆（有真实可达路径）**

`[board]/page.tsx:104-109` 的 `noViewableScope` 空态只在"账号完全无可见门店"时触发。**但当 URL 的 store scope 指向一家节点已停用的门店时**：`validateScope`（`context.ts:67`）因 `scopeStoreIds` 仍含它而放行，`activeStoreCondition`（`scope-sql.ts:31-39`）把它全部过滤掉 → 整屏 KPI 显示 `0` / `0.00`（`format.ts:19/29` 对 0 返回 "0" 而非 "--"）。用户无法区分"这家店本期没业绩"和"这家店已停用"。当前有 **3 家**这样的门店（九江中辉店 / 南昌龙大店 / 自贡旭阳店）。

**(f) 导出件不带任何口径元信息**

`export-worker/registry.ts:481-506` 的 `breakdownContent` 只输出组名 + 文本列 + 指标列；**不写时间区间、不写 scope、不写基期**。叠加已确认的"持卡占比 253.24" 会以裸数字落进"持卡占比(%)"列，线下考核表无法自证。

---

## 3. 存活发现中证据链不够硬的

| 发现 | 问题 | 建议动作 |
|---|---|---|
| **[P2] byMarket.storeCount 未历史化** | **最弱的一条 CONFIRMED**。金额差实测 **0.00**；我复核：40 个 `is_active` 门店节点中 **`closed_at` 非空者 0 个**，唯一有 `closed_at` 的自贡旭阳店节点已 `is_active=FALSE` → **"闭店"路径在 prod 从未被真实数据触发过**；唯一活体触发是太一店 2026-07-01 开业，而最早业绩是 07-03。即该缺陷在当前数据上**只能在零营收区间被观测到** | 实质是 P3（代码缺陷真实、业务影响为零），不应与 convRate/newCount 同列待修 |
| **[P2] employeeCount 漏 14 人** | "这 14 人的产出占实耗 4.70%（¥166,426.26）"这个数是**按 `service_commissions` 有提成行的服务子项整行金额**算的，**没乘 `allocation_ratio`**。同一服务子项可被 2~3 个角色分摊，所以 4.70% 是**上界**，不是这 14 人的实际产出 | 重算时乘 `sc.allocation_ratio`（写法参考 `efficiency.ts:559`），预计会显著小于 4.70% |
| **[P2/UNCERTAIN] 员工榜无 scope** | 同一主张在本次审计中**既存活又被证伪两次**，三份结论互斥且都引了对方没引的证据（存活方多出"跨市场王志军 6,055.09"，证伪方多出 ticket `2026-04-25-mgmt-staff-ranking-api.md:83/129`）。**目前没有裁决** | 必须先裁决再下发，否则下游会收到互相矛盾的两份修法 |
| **[P2] 一次/二次客活按行 vs 按天** | 验证员自己推翻了原告的全部规范引证，剩下的是"`metrics.md:260-277` 明文写 `COUNT(*)`"vs"`monthly_activity` 注释明文写按天"。**这是纯产品拍板项，不是数据缺陷**；且对比数 631/803 是用 `bound_store_id ∈ 在营店` 算的，而 KPI `queryActive`（`customer.ts:196-217`）的 `visit_count` CTE **不带 `customerScope`**，两者口径不完全同构 | 下发前补一次严格按 `queryActive` 原句的 KPI 侧复算 |
| **[P0] 环比不等长（两条）** | 影响面数字对不上（20 vs 16 张卡；"6 处 `enabled=false`"实际 **8 处**）。此外两条都**没有验证 `today` 分支**（声称 previous=昨日等长，但无数据佐证） | 合并为一条，影响面以 `grep -c 'withComparison('` 实测为准：sales 8 / customer 18（其中 8 处 `false`）/ product 5 / efficiency **0** |
| **[P0] convRate 分母** | 证据极硬（800%、'--' 翻转），但**没有验证修复后的副作用**：`trafficCustomers` 同时是一张独立 KPI 卡「当月流量客人数」（`customer-board.tsx:34`），改分母等于同时改那张卡的含义 | 修法评审时必须一并说明这张卡的语义变化 |
| **[P1] 新客客单跨割点** | 结论硬，但受损面依赖 preset ∈ {year, custom}，默认"本月"完全不受影响，且 2027-01-01 后"今年"自愈 | 定级 P1 合理，但排期优先级应低于 convRate / newCount 两条默认视图即错的 |

---

## 4. 只剩 3 次检查，我会查这三件

### 检查 1：全板块「KPI ↔ 明细合计 ↔ 排行榜合计」数值对账（一次性跑完 4 板块）

**理由**：本次审计**独立三次**命中同一族缺陷（品项 `newCount` KPI 2429 vs 明细 832 [P0]、销售 `storeCount` KPI 39 vs 明细 40 [P2]、人效 KPI 分子 4,786,941.55 vs 同页门店榜 3,672,217.98 [P0]），但**从未系统跑过一遍**。上面未覆盖的 30+ 个指标里必然还有同型漏网。我已抽查两个：客量消费分桶族**对得上**（340=340），人效员工业绩榜**对不上**（额外差 11,200，见下）。

**可执行做法**：对 `scope=all` × {2026-09-01~09-22, 2026-01-01~09-22} 两组区间，逐指标算三处值。对账口径直接抄这三处源码：
- KPI：`sales.ts:68-190`、`customer.ts:68-430`、`efficiency.ts:141-258`、`product.ts:127-286`
- 明细：`sales.ts:279-381`、`customer.ts:481-847`、`efficiency.ts:260-386`、`product.ts:288-500`
- 排行榜：`efficiency.ts:388-478`（门店）、`:531-757`（员工）

样例（我已跑通的模板，替换聚合式即可）：
```sql
WITH act AS (SELECT s.store_id, n.parent_id market_id
             FROM stores s JOIN org_nodes n ON s.org_node_id=n.id
             WHERE n.type='门店' AND n.is_active),
ev AS (SELECT o.client_user_id, a.market_id, spe.amount::numeric amt
       FROM sale_order_performance_events spe
       JOIN sale_orders o ON o.sale_order_id=spe.sale_order_id
       JOIN act a ON a.store_id=o.store_id
       JOIN client_wechat_users c ON c.user_id=o.client_user_id
       WHERE spe.sale_order_type IN ('销售单','转换单') AND spe.status='已支付'
         AND spe.change_type IN ('首次支付','回款','退款')
         AND spe.legacy_source IS DISTINCT FROM 'workfine'
         AND spe.performance_date BETWEEN '2026-09-01' AND '2026-09-22'
         AND c.customer_type='会员客'),
kpi AS (SELECT client_user_id, SUM(amt) spend FROM ev GROUP BY 1),          -- KPI：全局去重
det AS (SELECT market_id, client_user_id, SUM(amt) spend FROM ev GROUP BY 1,2) -- 明细：按市场去重
SELECT (SELECT count(*) FILTER (WHERE spend>=1990) FROM kpi) kpi_v,
       (SELECT count(*) FILTER (WHERE spend>=1990) FROM det) detail_sum;
-- 实测 340 | 340（本月无跨市场消费会员 → 对得上；换成「今年」区间需重跑）
```

### 检查 2：`> 0` 过滤族与负值处理 —— 退款红线在派生层被破掉了

**理由**：这是我**今天已经实证到的现症**，不是推断。`efficiency.ts:549/573/591/618/651` 五处 `WHERE COALESCE(v,0) > 0` 把负值员工整行剔除；实测 2026-09 有 2 名员工净业绩 **−11,200.00** 被吞，而同一笔钱在 `qRevenueTotal`（`efficiency.ts:141-152`）里照计。同板块门店榜（`:388-478`）**没有**这个过滤。这与项目硬口径「退款走负数冲销、不删行」和 `metrics.md:338-339`「不做 clamp」直接冲突。

**最小复跑 SQL**（把 `WHERE v<0` 改成 `WHERE v<=0` 可一并看到被吞的零值行）：
```sql
WITH rev AS (
 SELECT spia.employee_id, SUM(spia.allocated_amount::numeric) v
 FROM sale_payment_item_allocations spia
 JOIN sale_payment_item_receipts spir ON spir.id=spia.sale_payment_item_receipt_id
 JOIN sale_items si ON si.sale_item_id=spir.sale_item_id
 JOIN sale_orders so ON so.sale_order_id=si.sale_order_id
 JOIN sale_order_performance_events spe ON spe.sale_payment_id=spir.sale_payment_id
 WHERE spia.is_void=FALSE AND so.sale_order_type IN ('销售单','转换单')
   AND spe.performance_date BETWEEN '2026-09-01' AND '2026-09-22'
 GROUP BY 1)
SELECT count(*) emp_dropped, round(sum(v),2) amt_dropped FROM rev WHERE v<0;
-- 实测 2 | -11200.00
```
同法复跑实耗（`sc.allocation_ratio` 版，`efficiency.ts:557-568`）、收入（`:624-645`）、项目数（`:599-613`）四条，并逐月扫 2026-07~09 三个月（YTD 口径为 0 人，只有月度尺度能看见）。

### 检查 3：客量板 8 个零覆盖指标 + 阈值单源 + 时区断言（三件事一次做完）

**理由**：客量板是 4 个板块里覆盖率最低的（约 35%），而它恰好已经贡献了 2 条 CONFIRMED 缺陷（convRate P0、新客客单 P1）——**缺陷密度最高的板块被查得最少**。

具体三步：

1. **8 个 KPI 与 staff 端 `mgmt-traffic.js` 双端对账**（项目禁跨端共享代码，靠 snapshot 守护，但 snapshot 只比字面量不比数值）：
   `queryRegistration`(`customer.ts:68-92`) / `queryTrafficCount`(`:96-115`) / `queryProjectCount`(`:118-136`) / `queryServiceCount`(`:138-153`) / `queryShengmeiConsume`(`:155-173`) / `queryOperatedMembers`(`:294-320`) / `queryMemberAvgTicket`(`:323-352`) / `queryRetainedMembers`(`:414-430`)，逐个与 `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/mgmt-traffic.js` 同名查询做**数值**对账。重点看 `queryRegistration` 内部两套时间轴（会员档 `became_member_at` vs 其余三档 `created_at`）在同一张卡上是否可加。

2. **阈值单源核查**：
```sql
SELECT config_key, config_value FROM system_configs
WHERE config_key ILIKE '%threshold%' OR config_key ILIKE '%member%';
```
对照 `customer.ts:317`（`>= 1990`）与 `customer.ts:691-697`（六档硬编码）与 `product.ts` 读配置的写法，确认是否已分叉。

3. **时区断言（30 秒）**：在 prod admin 容器里跑一次
```bash
ssh lx-prod 'docker exec <admin容器> node -e "require(\"postgres\")(process.env.DATABASE_URL,{max:1})\`SHOW TimeZone\`.then(r=>{console.log(r);process.exit(0)})"'
```
期望 `Asia/Shanghai`。配套影响面已实测：
```sql
SELECT count(*) FILTER (WHERE (became_member_at AT TIME ZONE 'Asia/Shanghai')::time='00:00:00') AS midnight_rows,
       count(*) AS total
FROM client_wechat_users WHERE became_member_at IS NOT NULL;
-- 实测 1567 | 1898（82.6% 的会员日期只差一次时区错配就整体跨日）
```
若确认为 `Asia/Shanghai`，建议在 `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/db/index.ts` 加一条启动期断言把它钉死 —— 这是全数据中心唯一一个"错了会让所有日期型指标同时静默偏移一天"的单点。

---

# 附录 A — 存活发现逐条明细

## A1. [P0][CONFIRMED] 环比(MoM)分母区间长度不等：本月/本周 preset 拿「整段上月/上周」去比「月初至今/周一至今」，所有 KPI 卡的环比徽章系统性失真

- 审计视角：销售板块　板块：sales　指标：storeRevenue / shengmeiRevenue / storeConsume / shengmeiConsume / newCustomerRevenue / trafficCustomerRevenue / storeCount / employeeCount —— 全部 11 张 KPI 卡的「环比」
- **断言**：resolveTimeRange 对 month/week 两个 preset 把 previous 设为完整的上一自然月/上一自然周，而 current 是「月初/周一 → 今天」的部分区间；deltaPct 直接 (cur-prev)/prev，于是环比 = 部分区间 ÷ 完整区间，天然被稀释。preset=month 是默认值（params.ts:93），withComparison 默认开（params.ts:107），所以数据中心销售板块打开即错。同一文件里 year 和 custom 两个 preset 的 previous 都是等长区间、同比(lastYear)也是等长 —— 模块内部自相矛盾，说明 month/week 是漏改而非设计。
- **规范依据**：/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md:910 「**同比/环比**：仅 KPI 卡片标量计算（本期/上期/去年同期 delta%），明细表与排名榜不做逐行对比。」—— 只规定了要算 delta%，没有授权用不等长区间。metrics.md:885-893「时间窗口补充（sales-data 页专用口径）」里的「上月 = 上月初~上月末」是 staff 端**并列可选的时间维度**（本月/上月/本年三选一），不是比值的分母；数据中心把它直接搬来当环比基数属于误用。
- **代码证据**：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/time-range.ts:106-116
```ts
} else if (input.preset === 'week') {
  const monday = startOfWeekMonday(today)
  current = { start: monday, end: today }                      // 部分周（周一~今天）
  previous = { start: addDays(monday, -7), end: addDays(monday, -1) }  // 完整 7 天
  lastYear = { start: addYears(monday, -1), end: addYears(today, -1) } // 等长，正确
} else if (input.preset === 'month') {
  const first = startOfMonth(today)
  const lastMonthAnyDay = addDays(first, -1)
  current = { start: first, end: today }                        // 部分月（月初~今天）
  previous = { start: startOfMonth(lastMonthAnyDay), end: endOfMonth(lastMonthAnyDay) } // 完整上月
  lastYear = { start: addYears(first, -1), end: addYears(today, -1) }  // 等长，正确
}
```
对照 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/time-range.ts:117-122（year 分支 previous 是等长到今日）与 :85-96（custom 分支 previous 是「紧邻前一等长区间」）。
消费方：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/comparison.ts:20-24 `deltaPct = (cur - base) / base`；/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/sales.ts:220-227 八个 withComparison 调用；渲染在 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/app/(main)/(analytics)/data-center/_components/kpi-card.tsx:41 `<DeltaBadge label="环比" value={cell.mom} />`。
现有单测 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/time-range.test.ts:42-48 反而把这个行为钉死了（current 3 天 vs previous 整月）。
- **数据证据（发现者）**：prod 只读库实跑（2026-09-22 为周二，本周起点 2026-09-21）：
【本月 preset】总业绩 current(09-01~09-22)=3,672,217.98；实现的 previous(08-01~08-31 整月)=3,452,804.49 → 环比 +6.35%；等长 previous(08-01~08-22)=2,808,430.45 → 真实环比 +30.76%。
实耗 current=3,449,529.86；实现 previous=4,575,126.33 → 环比 −24.60%；等长 previous(08-01~08-22)=3,547,624.21 → 真实环比 −2.76%。
【本周 preset】总业绩 current(09-21~09-22)=199,786.00；实现 previous(09-14~09-20 整 7 天)=1,309,920.91 → 环比 −84.75%；等长 previous(09-14~09-15)=431,982.41 → 真实环比 −53.75%。
实耗 current=233,540.53；实现 previous=1,276,407.73 → 环比 −81.70%；等长 previous=245,318.83 → 真实环比 −4.80%（差 17 倍）。
- **影响面**：默认视图（本月 + 同比环比开）下 11 张 KPI 卡的环比全部偏低。实测当天：实耗环比显示 −24.6%，真实同长口径只有 −2.8%；本周视图下实耗环比显示 −81.7%，真实只有 −4.8%。每个自然月的 1~28 号、每周的周一~周六都会命中；月初/周初最严重（1 号看本月环比 ≈ −97%）。四个板块共用 resolveTimeRange，客量/人效/品项的 KPI 环比同样中招。同比(YoY)因为是等长区间所以正确，于是同一张卡上同比和环比方向互相打架，会直接误导门店经营判断。
- **验证员复算**：prod 只读库（118.178.196.26:5433 / fengyu_ro），current_date=2026-09-22（周二，date_trunc('week')=2026-09-21）。两种口径各算一遍：

【本月 preset · 总业绩】(sale_order_performance_events, status='已支付', change_type IN ('首次支付','回款','退款'), sale_order_type IN ('销售单','转换单','充值单'), legacy_source IS DISTINCT FROM 'workfine', performance_date)
current 09-01~09-22 = 3,672,217.98
实现 previous 08-01~08-31（整月）= 3,452,804.49 → 卡片显示环比 +6.35%
等长 previous 08-01~08-22 = 2,808,430.45 → 真实环比 +30.76%
（同期 lastYear 2025-09-01~09-22 = 0.00，故同比恒 '--'）

【本月 preset · 实耗】(service_orders.status='已完成' JOIN service_items, SUM(unit_real_price*session_used), 含 remark IS DISTINCT FROM '寄存单退款专用 …' 排除)
current = 3,449,529.86
实现 previous 08 整月 = 4,575,126.33 → 显示 −24.60%
等长 previous 08-01~08-22 = 3,547,624.21 → 真实 −2.77%（差 8.9 倍）

【本周 preset · 实耗】
current 09-21~09-22 = 233,540.53
实现 previous 09-14~09-20（整 7 天）= 1,276,407.73 → 显示 −81.70%
等长 previous 09-14~09-15 = 245,318.83 → 真实 −4.80%（差 17 倍）

【最强证据：正负号翻转 · 服务人次（客量板 KPI）】COUNT(*) FROM service_orders WHERE status='已完成' AND service_date::date BETWEEN …
current 09-01~09-22 = 5,998 单
实现 previous 08-01~08-31 = 7,220 单 → 卡片显示 环比 −16.93%（红色=下滑）
等长 previous 08-01~08-22 = 5,157 单 → 真实 +16.31%（绿色=增长）
即默认视图下，今天打开客量板，服务人次的环比方向就是反的。

【影响面实测（收窄原告口径）】withComparison 调用数：sales.ts=8、customer.ts=18（其中 6 处显式传 enabled=false）、product.ts=5、efficiency.ts=0。故人效板根本无环比（原告说"四板块同样中招"不成立）；sales 的 storeCount/employeeCount 是"区间末时点快照"（WHERE opening_date<=range.end / hired_at<=range.end），区间长度对其无影响；3 张店均派生卡按 sales.ts:229 注释本就不出 delta。真正被稀释的是约 20 张流量型（区间求和型）KPI 卡。
- **验证员理由**：我按"默认是误报"的立场走了四条证伪路径，全部失败：

1) 读全文查上游兜底 —— 失败。/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/comparison.ts:20-24 的 deltaPct 就是裸 (cur-base)/base，withComparison(:48-51) 对 previous 不做任何区间归一化；消费端 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/app/(main)/(analytics)/data-center/_components/kpi-card.tsx:41 只渲染 `<DeltaBadge label="环比" value={cell.mom} />`，UI 从头到尾不披露 previous 的实际日期区间（board 组件只用 data.timeRange.presetLabel，即"本月"两个字）。用户无从得知基数是整段上月。默认值确认：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/params.ts:93 `return { preset: 'month' }`、:107 `withComparison: raw.cmp !== '0'` —— 打开即命中。

2) 查代码自称的规范依据是否成立 —— 反而证明援引错了。time-range.ts:8 自称"复用 metrics.md §时间窗口补充的 month/year 口径"。我去读 /Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md:885-893 的那张表，再去读移植源 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:634 `@param {'month'|'lastMonth'|'year'} period` 与 :892 `const VALID_PERIODS = ['month','lastMonth','year']`、:896 `const PERIOD_CN = '本月/上月/本年'`。结论：staff 端的"上月"是用户三选一的**并列时间维度**（选了上月，current 就是整段上月），从来不是任何比值的分母。数据中心把这一行直接搬去当 previous，是对该表的误用。原告这一段读得对。

3) 查是否已拍板的设计意图 —— 查不到任何业务侧决策。grep 全仓 .42cog/ 与 notes/：.42cog/pm/admin.pr.spec.md 和 .42cog/dev/admin.sys.spec.md 对"同比/上期/环比"零命中；metrics.md:910 只写"仅 KPI 卡片标量计算（本期/上期/去年同期 delta%）"，没定义"上期"；metrics.md:642 的 2026-05-26 变更记录列了 3 项用户拍板口径，不含环比基数。唯一一次业务方提到它是 notes/meetings/meeting-20260417 逐字稿第 25 行"夜航星(00:12:19): 然后同比环比是都要算吗？"，紧接着第 27 行"我没有还"话题即被岔开，**无人回答**。git log 只有两条（e10a1b14 地基、def3d192 四板），commit message 仅写"时间维度解析（本期/环比/同比）"，无任何关于分母长度的论证。

4) 查是否内部自洽（若五个 preset 统一用"整段上一周期"，尚可辩称是一套口径）—— 不自洽。同一函数里 today(:104 昨天，1 天 vs 1 天)、year(:121 去年初~去年同日)、custom(:88-89 紧邻前一等长区间) 三个分支的 previous 都是等长，只有 week(:109) 和 month(:115) 用整段。一个函数五个分支两套规则，且注释未解释差异，指向漏改而非设计。

反向为被告找的最强辩护是："也许业务方就想看'本月做到了上月的多少'"。我保留这个可能性，但它救不了本条：① 那种口径的正确标签是"完成率/进度"，不是"环比"；② 即便采纳它，今日/自定义/今年三个分支就成了错的，五选五必有三错；③ 服务人次今天实测正负号翻转（显示红色 −16.93%，真实 +16.31%），这不是"口径偏好"能覆盖的误导。

最后确认它确实在线上：数据中心 2026-05-26 上线（metrics.md:642），admin 随 v1.16.34 已发 prod。

关于定级：原告定 P0，我一度想降到 P1（毕竟 KPI 主数值本身是对的，只有徽章错；且每月最后一天/每周日会自愈）。但 P1 的定义是"特定条件下错"，这里恰好相反——每个自然月只有最后一天是对的、每周只有周日是对的，其余 28~30 天全错，且是默认视图。按题面 P0 的"时间轴错位导致整列失真"，加上 prod 实测出现方向翻转，维持 P0。仅把影响面从"11 张卡/四板块"收窄为"约 20 张流量型卡，人效板不受影响，两张时点快照卡不受影响，同比因无 2025 数据当前恒为 '--' 所以'同比环比打架'今天不会发生"。
- **既有守护**：被"反向钉死"，没有任何测试能发现它。
- /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/time-range.test.ts:42-48 `it('month：月初至今 / 整个上月 / 去年同区间')` + :45 `expect(r.previous).toEqual({ start: '2023-12-01', end: '2023-12-31' })`，以及 :34-38 的 week 用例 `expect(r.previous).toEqual({ start: '2023-12-25', end: '2023-12-31' })` —— 这两条是行为快照，把当前实现原样固定，修复时必须同步改这两个断言，否则测试红。
- /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/consistency.{sales,customer,efficiency,product}.test.ts 是与 staff 云函数的 SQL 字面量比对，完全不涉及 comparison 区间（staff 端根本没有环比功能，无可比对物）。
- /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/comparison.test.ts（若存在）只覆盖 deltaPct 的 null/0 分支，不校验分母区间长度。
结论：guardedByTest = 否（现有测试是漂移守护，不是口径守护；反而会阻挡修复）。
- **是否设计意图**：否 —— 未找到任何已拍板依据。(a) 规范侧：.42cog/pm/admin.pr.spec.md 与 .42cog/dev/admin.sys.spec.md 对"同比/环比/上期"零命中；metrics.md:910 只规定"要算 delta%"，未定义"上期"长度；metrics.md:642 的 2026-05-26 拍板清单（流量客业绩/单次客耗/店长人数）不含此项。(b) 会议侧：notes/meetings/meeting-20260417 逐字稿第 25 行业务方问"同比环比是都要算吗？"后话题被岔开，**无回答**，等于此口径从未被业务方确认。(c) git 侧：git log -- time-range.ts 仅 e10a1b14（"时间维度解析（本期/环比/同比）"）与 dd1e6025（UTC 切片修复），均无分母长度的论证。(d) 注释侧：time-range.ts:11 确实写了 `month current=[月初,今天] previous=[上月初,上月末]`，但这是**描述实现**而非陈述理由；且同文件 :8 自称"复用 metrics.md §时间窗口补充的 month/year 口径"，经核对该表（metrics.md:885-893）在 staff 端对应 mgmt-dashboard.js:892 `VALID_PERIODS=['month','lastMonth','year']` 的**三选一并列时间维度**，不是比值分母——援引依据本身就是误读。(e) 自洽性：同函数 today/year/custom 三分支 previous 皆等长，仅 week/month 用整段，指向漏改。
- **建议修法**：把 week/month 两个分支的 previous 改成与 current 等长的"紧邻前一周期同长度区间"，与同文件 today/year/custom 三分支对齐——month: `previous = { start: addYears/addMonths 后的上月同日起点, end: 上月的第 N 天 }`，即 `{ start: startOfMonth(lastMonthAnyDay), end: min(addMonths(today,-1), endOfMonth(lastMonthAnyDay)) }`（3/31 看 2 月时须 clamp 到月末）；week: `previous = { start: addDays(monday,-7), end: addDays(today,-7) }`。同步更新 time-range.test.ts:34-48 的两条断言。若业务方确实想保留"本月 vs 上月整段"，则不能叫"环比"——应在 kpi-card 上换标签（如"占上月"）并在徽章旁显示 previous 的实际日期区间，且 today/year/custom 三分支要一并改成同一套口径，不能五选二。无论走哪条，都建议把 previous/lastYear 的实际区间随 timeRange 下发到前端并在卡片 hover 上展示，杜绝"看不见分母"。

<details><summary>验证 SQL</summary>

```sql
SELECT
  (SELECT round(COALESCE(SUM(amount),0),2) FROM sale_order_performance_events WHERE status='已支付' AND change_type IN ('首次支付','回款','退款') AND sale_order_type IN ('销售单','转换单','充值单') AND performance_date BETWEEN '2026-09-01' AND '2026-09-22') AS cur_month_to_date,
  (SELECT round(COALESCE(SUM(amount),0),2) FROM sale_order_performance_events WHERE status='已支付' AND change_type IN ('首次支付','回款','退款') AND sale_order_type IN ('销售单','转换单','充值单') AND performance_date BETWEEN '2026-08-01' AND '2026-08-31') AS prev_impl_full_month,
  (SELECT round(COALESCE(SUM(amount),0),2) FROM sale_order_performance_events WHERE status='已支付' AND change_type IN ('首次支付','回款','退款') AND sale_order_type IN ('销售单','转换单','充值单') AND performance_date BETWEEN '2026-08-01' AND '2026-08-22') AS prev_equal_length;
```

</details>

## A2. [P2][UNCERTAIN] 员工数 KPI 漏掉 14 名直挂组织节点（养生部/品项公司）的在职产能技师：集团口径显示 150，实际 164

- 审计视角：销售板块　板块：sales　指标：employeeCount（员工数 KPI）、byStore/byMarket 的 technicianCount（技师人数）
- **断言**：runEmployeeCount 用 scopeFilterSql(session, scope, 's.store_id')，而 scopeFilterSql 无条件先拼一条 `s.store_id IN (在营门店集合)`（连 scope='全部' 也拼）。staff_wechat_users.store_id 为 NULL 的员工在 `IN (...)` 下求值为 NULL → 被整体过滤掉。这些人是直挂市场/部门节点的养生师，按 metrics.md 的产能员工口径应当在集团视角计入。
- **规范依据**：/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md:161 「员工数（employeeCount） | `COUNT(*)` | `staff_wechat_users` | `s.hired_at IS NOT NULL` ∩ `s.hired_at::date <= $date` ∩ (`s.resigned_at IS NULL` OR `s.resigned_at::date > $date`) ∩ `skills && ARRAY['美容师','养生师']` ∩ scope（`store_id`）」
/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md:451 scope 表：「| 全部 | 不过滤 | 不过滤 | 不过滤 |」（第三列即 staff_wechat_users）—— scope='全部' 下不该有 store_id 闸门。
/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md:145 「产能员工范围…∩ scope（2026-09-03 起 = 门店员工按 `store_id` ∪ 直挂组织节点员工按 `anchor_market_id`）…_曾强制 `store_id ∈ 在营门店`（2026-09-03 放宽）_」—— 口径已明确放宽，销售/人效两板块的头数查询没跟上。
- **代码证据**：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/sales.ts:196-207
```sql
SELECT COUNT(*)::int AS v
FROM staff_wechat_users s
WHERE ${scopeFilterSql(session, scope, 's.store_id')}
  AND s.skills && ARRAY['美容师','养生师']::text[]
  AND s.hired_at IS NOT NULL AND s.hired_at::date <= ${range.end}
  AND (s.resigned_at IS NULL OR s.resigned_at::date > ${range.end})
```
/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/scope-sql.ts:30-40 + :53
```ts
function activeStoreCondition(storeCol: SQL): SQL {
  return sql`${storeCol} IN (SELECT active_store.store_id FROM stores active_store JOIN org_nodes active_node ON ... WHERE active_node.type='门店' AND active_node.is_active = TRUE)`
}
...
const parts: SQL[] = [activeStoreCondition(col)]   // ← all / authorized 也拼
```
同一遗漏出现在明细表的技师人数查询 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/sales.ts:291-300。注意人效板块已经为这批人造了 orgAnchorScopeSql（scope-sql.ts:90-115）并用在员工榜上，但两个板块的**头数**口径都还硬卡 store_id。
- **数据证据（发现者）**：prod 只读库实跑（区间末 2026-09-22）：看板口径 COUNT=150；去掉 store_id 闸门的真实在职产能技师 COUNT=164，差 14 人（−8.5%）。14 人明细（全部 skills={养生师}、resigned_at 为空）：季杰(品项公司/市场节点)、涂怀平·游细明·谭文彪·高立新·周晓伟·郑贵滨·黄志斌·吴建(org-部门-1780555695879 养生部)、贾顺坤·马敏江·李克潮·范文建(org-部门-1789098575101 养生部)、王志军(org_node_id 指向 org-门店-1779848579340 南昌云暖店、但 store_id 为 NULL)。
- **影响面**：销售板块「员工数」KPI 卡常年少 14 人（150 vs 164，−8.5%），按市场/按门店明细的「技师人数」列合计同样少 14。王志军这一例尤其刺眼：他挂在「南昌云暖店」这个在营门店节点上，却因为 store_id 为空而在任何门店行里都不出现。人效板块的人均派生（人均业绩/人均实耗/人均收入）共用同一分母口径，分母偏小会让人均值整体虚高约 9%；而人效的员工收入榜又用 orgAnchorScopeSql 把这 14 人的收入算进了分子，分子分母口径不一致。
- **验证员复算**：prod 只读库（118.178.196.26:5433 / fengyu_ro），区间末 2026-09-22：

1) 头数复算（一次查询同时出三个口径）：
kpi_shown=150 | truth_no_gate=164 | dropped_null_store=14 | dropped_inactive_store=0
→ 原告的 150 vs 164 / 差 14 人（−8.5%）完全属实。但关键细节原告没说：**被在营门店闸门刷掉的是 0 人**，14 人全部是 `store_id IS NULL` 被 `IN (...)` 的三值逻辑吞掉的。

2) 14 人明细核对无误（全部 skills={养生师}、resigned_at 为空）：养生部 12 人（org-部门-1780555695879 八人：涂怀平/游细明/谭文彪/高立新/周晓伟/郑贵滨/黄志斌/吴建；org-部门-1789098575101 四人：贾顺坤/马敏江/李克潮/范文建）、品项公司 1 人（季杰，养生总监）、王志军（position=养生主管，org_node_id=org-门店-1779848579340 南昌云暖店，store_id 为 NULL）。

3) 分子/分母是否真的不对称（原告只做了推断，我实测了）：
- 2026-09-01~09-22，这 14 人中有 **10 人**在 `service_commissions` 留下 **428 行**提成记录，对应的 `service_orders` 全部 `store_id IS NOT NULL` 且 status='已完成' → 他们的产出确实计入了按 `so.store_id` 聚合的分子。
- 同期在营门店 实耗合计 **3,544,706.91**；其中落在「这 14 人有提成行」的服务子项上的 **166,426.26**，占 **4.70%**。
- 分母侧 efficiency.ts:800-804 的 empAvgRevenue/empAvgConsume/empAvgIncome/empAvgMembers/empAvgProjects 全部除以 technicianCount=150。→ 分子含其产出、分母不含其人头，这个不对称是**真实存在**的。

4) `service_items.employee_id` 口径下同期实耗为 0（2026-09-03 归属已改走提成分配），所以必须按 service_commissions 查才看得见，这也是原告没能实证到的部分。
- **验证员理由**：我按「默认误报」的立场逐条打击，结果是**三条规范依据里两条被我打掉、一条反而站在代码这边，但数据层面的不对称打不掉**，所以落 UNCERTAIN 而非 CONFIRMED/REFUTED。

【打掉的第 1 条】原告引 metrics.md:145「产能员工范围…2026-09-03 放宽」说销售/人效两板块「没跟上」。这是**读错章节**。metrics.md:104 的章节标题是 `## 员工排行榜归属`，:145 是该章节内定义**排行榜候选池**的句子，:151 才是 `## 门店状况 / 人效` 章节、:161 才是 employeeCount。两者是刻意分开的两个池子，证据有三：
  a. :145 自己写着「与 employeeCount selectedDate 历史化口径**字段一致但锚点不同**」——作者写这句时明确把 employeeCount 放在对照位上，是知情后未改；
  b. :145 的历史注写着排行榜池「曾含 skills && ARRAY['美容师','养生师']（2026-05-20 去除）」，而 employeeCount 至今**保留** skills 过滤。两个池子早在 2026-05-20 就已经分叉，employeeCount 从来就不是排行榜池的镜像，不存在「自动继承放宽」的义务；
  c. :143 明写实现落点「staff `producerEmployeesCte` + admin `producerCte` + `orgAnchorScopeSql`」——放宽的落地范围被显式限定在排行榜 CTE。
反过来看 metrics.md:161 原文：employeeCount 的筛选条件是「… ∩ `skills && ARRAY['美容师','养生师']` ∩ scope（`store_id`）」。sales.ts:196-207 与 efficiency.ts:233-240 与这行**逐字一致**。所以「违反 metrics.md」这个指控本身不成立。

【打掉的第 2 条】原告引 metrics.md:451 scope 表「全部 | 不过滤 | 不过滤 | 不过滤」说 all 视角不该有 store_id 闸门。但 metrics.md:643 变更记录写着：「2026-08-08｜数据中心经营统计**统一**仅纳入 `org_nodes.is_active=TRUE` 的门店：门店数、全部区间指标、门店/员工排行榜及范围下拉同步过滤」。:451 那张表是全局/staff 端的旧 scope 表，对数据中心已被 2026-08-08 这条明确覆盖；scope-sql.ts:23-29 的注释也把这个动机写清楚了（「避免四个板块只修部分查询而再次漂移」）。git log -S activeStoreCondition 只有一条 `24395108 feat: 统一门店范围与权限矩阵`，与之吻合。而且我实测 `dropped_inactive_store=0` —— 这道闸门按其设计目的（剔停用门店）在这批人身上一个都没刷掉，原告把「闸门」和「NULL 语义副作用」混为一谈了。

【打掉的第 3 条（部分）】原告说「按市场/按门店明细的技师人数列合计同样少 14」。按门店明细是 `GROUP BY s.store_id`（sales.ts:299），store_id 为 NULL 的人**结构上就无处安放**，这一半指控不可执行、也谈不上 bug。王志军那一例原告说「尤其刺眼」，但 metrics.md:133 已把它登记为「**档案缺失**（修 1 例）」——项目方认定这是数据质量问题，且只在 producerCte 里做了反查兜底。

【打不掉的部分】即便规范依据全垮，两个事实仍成立：(1) 集团视角「员工数」卡片确实显示 150 而非 164，这 14 人是真在职产能技师；(2) 我实测出分子含其产出（Sept 428 行提成 / 16.6 万实耗，占 4.7%）而分母不含其人头。这不是「代码违反文档」，而是「文档定义的 employeeCount 口径本身与同板块分子口径不对称」——属于要产品拍板的问题，不是实现缺陷。故 UNCERTAIN。

严重度：维持 P2，但定级理由要改写。原告的 P2 理由是「口径与文档不符」，这是错的（代码与文档逐字相符）；真正的 P2 理由是「文档口径与业务直觉/分子口径不一致，需产品确认哪个对」。不够 P1，因为不存在「特定条件下算错」——它在任何区间、任何 scope 下都稳定地按文档口径出数，数字自洽。
- **既有守护**：**没有任何守护能发现这条**。
- `fengyu-admin/src/actions/data-center/__tests__/consistency.sales.test.ts` / `consistency.efficiency.test.ts` 是「代码 vs 逐字快照」，只会在有人**改**这段 SQL 时报警；当前写法与快照一致，恰恰会把现状钉死。
- `sales.test.ts:153-162`（employeeCount=12）、`efficiency.test.ts:231/249/265/289`（technicianCount=5/4/0/4）全是 mock 返回值断言，不连库，`store_id IS NULL` 这类三值逻辑在 mock 下根本不可能复现。
- `src/lib/data-center/` 下无 scope-sql 的独立测试文件。
- 结论：这批人被吞掉不会被任何现有测试拦住；反过来，若要改口径，consistency.*.test.ts 的快照必须同步更新（sales.ts 两处 + efficiency.ts 一处）。
- **是否设计意图**：**部分是、但不是针对本条的显式拍板**，需要区分三层：
- 在营门店闸门（activeStoreCondition）：**是已拍板的设计意图**。metrics.md:643「2026-08-08｜数据中心经营统计统一仅纳入 org_nodes.is_active=TRUE 的门店」+ scope-sql.ts:23-29 注释 + git commit 24395108「统一门店范围与权限矩阵」。
- employeeCount 保留 `store_id` scope、不跟随排行榜放宽：**是知情下的未改，但没有一句显式决议**。证据是 metrics.md:161 明写 scope(`store_id`)、:145 明写「与 employeeCount…锚点不同」、:143 把 2026-09-03 的落地范围限定在 producerCte/orgAnchorScopeSql，且两池早在 2026-05-20 就因 skills 过滤分叉。属于「反直觉但看起来是故意的」，但强度只到「作者知情后选择不动」，不到「用户拍板」。
- 王志军 store_id 为空：metrics.md:133 登记为「档案缺失（修 1 例）」，明确按**数据质量问题**处理，仅在排行榜侧做代码兜底。
- .42cog/ 下四份 spec 均无 employeeCount 的独立定义，唯一权威就是 metrics.md:161。
- **建议修法**：先找产品拍板「员工数 / 技师人数」到底是「门店在职技师数」还是「全部在职产能技师数」，不要直接改代码——因为 metrics.md:161 现在就是代码的授权书，改代码而不改文档会掉进反向漂移。
若拍板为「全部在职产能技师」：在 `sales.ts:196-207` 的 KPI 与 `efficiency.ts:233-240` 的 technicianCount 上，复用现成的 `orgAnchorScopeSql`（scope-sql.ts:90-115），写成 `(s.store_id IS NOT NULL AND scopeFilterSql(...)) OR (s.store_id IS NULL AND orgAnchorScopeSql(...))`，与 `producerCte`（efficiency.ts:498-527）的写法对齐；同时同步 metrics.md:161 那一行与变更记录，并更新 consistency.sales / consistency.efficiency 两份快照。注意按门店明细表（sales.ts:291-300 `GROUP BY s.store_id`）无论如何塞不下这 14 人，只能落到按市场明细（用 anchor_market_id）。
另外建议顺手清一条数据债：王志军 `org_node_id` 指向在营门店节点却 `store_id` 为空，按 metrics.md:133 的口径这是档案缺失，应在员工档案里补 store_id，而不是靠各处代码反查兜底。

<details><summary>验证 SQL</summary>

```sql
SELECT
  COUNT(*) FILTER (WHERE s.store_id IN (SELECT st.store_id FROM stores st JOIN org_nodes o ON st.org_node_id=o.id WHERE o.type='门店' AND o.is_active)) AS kpi_shown,
  COUNT(*) AS truth,
  COUNT(*) FILTER (WHERE s.store_id IS NULL) AS dropped_no_store
FROM staff_wechat_users s
WHERE s.skills && ARRAY['美容师','养生师']::text[]
  AND s.hired_at IS NOT NULL AND s.hired_at <= '2026-09-22'
  AND (s.resigned_at IS NULL OR s.resigned_at > '2026-09-22');
```

</details>

## A3. [P2][CONFIRMED] 按市场明细的「门店数」列及 4 个店均列没做开闭店历史化，与 KPI「门店数」不同源

- 审计视角：销售板块　板块：sales　指标：byMarket.storeCount（门店数列）、revenuePerStore / shengmeiRevenuePerStore / consumePerStore / shengmeiConsumePerStore（4 个店均列）
- **断言**：KPI 的 runStoreCount 按区间末做了历史化（opening_date <= end ∩ (closed_at IS NULL OR closed_at > end)），而按市场明细的门店数是在 JS 里对 scopeStoreSkeletonSql 的行数直接 +1；骨架 SQL 只有「组织节点 is_active=TRUE」这一个条件，完全不带 opening_date/closed_at。于是选任何「区间末早于某店开业日」的自定义区间或看去年同期时，明细表门店数合计 ≠ KPI 门店数，而且明细表的 4 个店均列会被一个偏大的分母稀释。
- **规范依据**：/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md:153-155 「本节 4 项原始指标（会员数 / 保有会员 / 员工数 / **门店数**）已全部完成历史化改造…完成项：…T4 门店数…」——门店数是已登记的历史化指标，明细表侧漏改。
/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md:904 「店长人数 | 人效 | `COUNT(在营启用门店)` | …按 `stores` JOIN `org_nodes(type='门店', is_active=TRUE)` 在营计数（`opening_date<=区间末 ∩ (closed_at IS NULL OR closed_at>区间末)`）」—— 明确要求带区间末的开闭店条件。
- **代码证据**：KPI（有历史化）/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/sales.ts:176-190
```sql
SELECT COUNT(*)::int AS v FROM stores s JOIN org_nodes o ON s.org_node_id = o.id
WHERE o.type='门店' AND o.is_active = TRUE AND ${scopeFilterSql(...)}
  AND s.opening_date IS NOT NULL AND s.opening_date::date <= ${range.end}
  AND (s.closed_at IS NULL OR s.closed_at::date > ${range.end})
```
明细表（无历史化）/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/sales.ts:466 `m.storeCount += 1`，数据来自 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/scope-sql.ts:124-132：
```sql
SELECT s.store_id, s.store_name, o_mkt.id AS market_id, o_mkt.name AS market_name
FROM stores s JOIN org_nodes o_store ON s.org_node_id = o_store.id AND o_store.type = '门店'
JOIN org_nodes o_mkt ON o_store.parent_id = o_mkt.id
WHERE ${scopeFilterSql(session, scope, 's.store_id')}   -- 只有 is_active，无 opening_date/closed_at
```
这个分母被 4 个店均列直接消费：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/sales.ts:484-491 `perStore(m.storeRevenue, m.storeCount)` 等。展示列见 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/columns.ts:113（门店数）、:117-118、:123-124（店均）。
- **数据证据（发现者）**：prod 只读库实跑（40 个在营门店节点，全部直挂市场、全部有 stores 行）：
区间末 2026-06-30 → KPI 门店数 = 39，明细表合计 = 40；出错市场「南昌易大师」明细显示 5 店、历史化后应为 4 店（该市场有一店 opening_date=2026-07-01）。
区间末 2025-09-22（今年 preset 的同比区间） → KPI 门店数 = 33，明细表合计仍为 40，差 7。
金额侧当前差 0：prod 最早的业绩归属日是 2026-07-03、最早已完成服务日是 2026-07-08，而 40 家店在 2026-07-01 前已全部开业，所以 2026-06 及更早区间的营收/实耗都是 0，店均两种算法都得 0.00。
- **影响面**：当前 prod 数据下金额无差（营收数据始于 2026-07-03，彼时 40 店全开），但计数已经对不上：任何区间末落在 2026-06-30 及之前的自定义区间，KPI 卡显示「门店数 39」而下方按市场表的门店数列合计是 40；回看 2025 年区间则是 33 vs 40（差 7 店，21%）。一旦后续有新店开业或门店闭店（stores.closed_at 已有 1 例：自贡旭阳店 2026-07-28），同一页上的两个「门店数」会公开打架，且明细表 4 个店均列的分母会长期偏大、把该市场的店均业绩/店均实耗压低。
- **验证员复算**：prod 只读库（118.178.196.26:5433，fengyu_ro）实跑：

1) 全局计数（40 个 is_active 门店节点，opening_date 全部非空，其中 closed_at 非空 0 个）：
   skeleton_cnt=40 / KPI@2026-06-30=39 / KPI@2025-09-22=33 / KPI@today(2026-09-22)=40
   → 明细表恒 40；KPI 在区间末 ≤2026-06-30 时为 39，在 2025-09-22 时为 33。

2) 分市场（明细表口径 vs 历史化口径）：
   南昌易大师 5 / 4(@2026-06-30) / 0(@2025-09-22)
   九江凤御   7 / 7 / 6
   南昌凤御   17 / 17 / 16
   唯一驱动者：store-1787206732782「南昌太一店」opening_date=2026-07-01（南昌易大师市场，org 节点 is_active=TRUE）。

3) 金额侧当前差 0，已实证原因：min(performance_date @已支付)=2026-07-03、min(service_date @已完成)=2026-07-08，而 40 店在 2026-07-01 前已全开 → 任何区间末 ≤2026-06-30 的区间营收/实耗均为 0，店均两种分母都得 0.00。

4) 反向证伪失败：跑「有无门店在 opening_date 之前就有业绩（那样 KPI 分母才是错的一方）」→ 0 行。即历史化分母是对的一方，明细表分母是偏大的一方。

5) 自定义区间确实可达任意过去日期：parseTimeRange 仅校验 YYYY-MM-DD 且 start<=end，无上下限 clamp（fengyu-admin/src/lib/data-center/params.ts:80-90）。
- **验证员理由**：证伪尝试与结果：

A. 「上游是否已带历史化」——读 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/scope-sql.ts:124-132 全文 + 其调用的 scopeFilterSql/activeStoreCondition(:80-97)：骨架里唯一的门店条件是 activeStoreCondition 的 `active_node.is_active = TRUE`，确无 opening_date/closed_at。
B. 「调用方是否再加过滤」——读 sales.ts:263-290，`db.execute(skeleton)` 原样执行，skelRows 直接 map 成 storeAggs，:466 `m.storeCount += 1`，:484-491 四个店均用它当分母。无兜底分支。原告未读错。
C. 「是否设计意图」——git log -S "m.storeCount += 1" 只有引入它的那一个 commit（a2b38e4f 初版），无后续拍板；.42cog 无相关条目。更关键的是 scope-sql.ts:111-116 的注释自述「is_active 没有历史时间轴…开闭店的历史口径由**各指标自身的 opening_date/closed_at 条件继续负责**」——即骨架故意不带、由指标自己补，而 byMarket.storeCount 什么都没补，是违反了它自己写下的契约，不是意图。
D. 决定性反证：同一 lib 的 efficiency.ts 对**同一个量**做对了。metrics.md:906 规定「店长人数=每店一店长=在营启用门店数」，efficiency.ts:262-271 的 qManagerByStore 是带 opening_date/closed_at 的 per-store 表，:848 `m.managerCount += managerMap.get(storeId) ?? 0` 汇总 → 人效板块按市场表的「店长人数」是历史化的。于是同一个区间末 2026-06-30，南昌易大师在「人效」按市场表显示店长人数 4，在「销售」按市场表显示门店数 5，两块看板自相矛盾。这排除了「明细表故意用当前门店数」的解释。
E. 文档还正面支持历史化分母：metrics.md:438 明写「分母选月末在营…避免月初新开店尚未产生业绩却被当作分母拉低人均/店均」，正是本条描述的稀释。

需要订正原告两处（不影响结论）：
- 原告把「看去年同期」也列为触发条件，错：metrics.md:908 明确「同比/环比仅 KPI 标量，明细表与排名榜不做逐行对比」，40 vs 33 只有在用户手选区间末=2025-09-22 的自定义区间时才出现，不会因开同比开关出现。
- 原告举「自贡旭阳店 closed_at=2026-07-28」作闭店风险实例，不成立：该店 org 节点 is_active=FALSE，被 activeStoreCondition 从 KPI 和骨架**双双**剔除，两边一致。实践中闭店靠停用节点兜住了，真正的活跃驱动者只有新店开业（太一店 2026-07-01 一例）。

结论：代码缺陷真实存在、数字可复现（39 vs 40、5 vs 4），但今天的可触发窗口都是零营收区间，金额列实测无差，故不上 P1。
- **既有守护**：未被覆盖。
- /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/consistency.sales.test.ts:170-180 的「门店数历史化」守护只对 sales.ts 源码正则 `opening_date::date\s*<=`，KPI 那一处命中即通过，完全不看 byMarket 分支。
- /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/scope-sql.test.ts:111-129 只断言骨架含 `active_node.is_active = true`，不涉及历史化。
- /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/sales.test.ts:40 把 scopeStoreSkeletonSql 整个 vi.fn 掉，断言只到 kpis.storeCount.unit，byMarket.storeCount 无任何断言。
- **是否设计意图**：否。反而与已拍板意图相反：scope-sql.ts:111-116 注释规定「开闭店历史口径由各指标自身负责」，本指标未负责；metrics.md:153-155/162 把门店数登记为 2026-04-25 T4 已完成历史化改造项；metrics.md:906 对等价的「店长人数」明确要求带区间末开闭店条件，且 efficiency.ts:262-271/848 已照此实现。git log -S 显示 byMarket.storeCount 自 a2b38e4f 初版以来从未被讨论或改动。
- **建议修法**：把 byMarket 门店数改成与 efficiency.ts 同型：用一条带 `opening_date::date <= ${range.end} AND (closed_at IS NULL OR closed_at::date > ${range.end})` 的 per-store 查询产出 storeOpenMap，聚合时 `m.storeCount += storeOpenMap.get(storeId) ?? 0`（骨架仍保留全部行，保证零业绩门店在按门店表里可见），四个店均随之用该分母；同时把 consistency.sales.test.ts 的门店数守护从「文件里出现过一次 opening_date」收紧为按查询块分别断言，避免同类漏改再次逃逸。

<details><summary>验证 SQL</summary>

```sql
SELECT
  COUNT(*) AS breakdown_table_store_count,
  COUNT(*) FILTER (WHERE s.opening_date IS NOT NULL AND s.opening_date <= DATE '2026-06-30'
                     AND (s.closed_at IS NULL OR s.closed_at > DATE '2026-06-30')) AS kpi_store_count
FROM stores s JOIN org_nodes o ON s.org_node_id = o.id
WHERE o.type='门店' AND o.is_active = TRUE;
-- 换 '2025-09-22' 可复现 40 vs 33
```

</details>

## A4. [P0][CONFIRMED] 成交率分母把「本期已转化的人」整体剔除，门店级成交率被系统性放大，2 家门店直接变成 '--'

- 审计视角：客量板块　板块：customer　指标：成交率 convRate（KPI 卡 + 市场/门店消费经营明细列）
- **断言**：分母 trialFootfall 用的是 client_wechat_users.customer_type 的**当前快照** IN ('体验客','小美客')，而 customer_type 只升不降。凡是在所选区间内成功转化为会员的顾客，当期已变成 '会员客'，于是被从分母里抹掉——而他们正好是分子（新增会员）本身。结果是「成交率 = 转化数 ÷ 未转化数」的赔率，而不是转化率：分母越小率越高，极端情况分母归零，safeDiv 返回 null，整格显示 '--'。
- **规范依据**：notes/references/metrics.md:393 `新增会员成交率（newMemberConvRate） | newMemberCount / trialFootfall × 100%`；:403 `AND c.customer_type IN ('体验客','小美客')   -- 已决 D-conv-denom=B`；:407-409 「分母 = 区间内到店的"体验客 + 小美客"……分母含义 = "区间内有到店但未达会员"的活跃池」。规范本身就把分母定义成「未达会员」，代码忠实实现了规范，但该定义让分母与分子互斥，导出的数不是成交率。
- **代码证据**：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/customer.ts:395-411（queryTrialFootfall）
```sql
SELECT COUNT(DISTINCT so.client_user_id) AS v
FROM service_orders so
JOIN client_wechat_users c ON c.user_id = so.client_user_id
WHERE ${sc} AND so.status='已完成'
  AND so.service_date BETWEEN ${range.start} AND ${range.end}
  AND c.customer_type IN ('体验客', '小美客')
```
同一口径的明细副本在 :731-740（traffic_cust CTE）。
分子/分母相除：:1015-1019 `value: safeDiv(newMembers.value ?? 0, trafficCustomers.value ?? 0)`；明细行 :873 `const conv = op ? safeDiv(op.newMembers, op.trafficCustomers) : null`。分子 queryNewMemberCount 在 :354-368 用 `became_member_at::date BETWEEN start AND end`。
- **数据证据（发现者）**：prod 只读库，区间 2026-09-01~2026-09-22，scope=全部：
· 集团 KPI：newMembers=149，trafficCustomers=533 → 看板显示 27.95%；把本期已转化且本期到过店的 139 人补回分母后为 149/672 = 22.17%（相对虚高 26%）。
· 门店级（40 家在营店，35 家本月有新会员）：
  - 南昌云暖店 新增会员 3 / 流量客 0 → 看板「成交率 = --」，实际这 3 人本月都在该店到过店，真实值 100%；
  - 九江长江店 新增会员 6 / 流量客 0 → 同样显示 '--'，真实 100%；
  - 自贡恒太店 4/4、南昌江信店 1/1、南昌金域店 9/9、九江鸿蒙店 1/1 → 看板一律显示 100.00%，补回分母后均为 50.0%；
  - 12/35 家门店（34%）显示值 ≥ 真实值的 1.5 倍（九江凤御市场 65.9% vs 40.9%、自贡凤御 35.8% vs 26.4%、南昌易大师 31.7% vs 24.1%、南昌凤御 21.1% vs 17.7%）。
- **影响面**：看板 KPI「成交率」+ 市场/门店两张消费经营明细表的 convRate 列全部受影响：35 家有新会员的门店里 12 家虚高 ≥50%，4 家被顶到 100%，2 家（南昌云暖、九江长江，共 9 名新会员）反而显示 '--'。门店转化能力排名会直接被扭曲——越是把体验客全部转化掉的门店，分母越小、显示值越离谱或越变成空值。
- **验证员复算**：全部数字来自 prod 只读库 fengyu_ro@118.178.196.26:5433。

【集团 KPI，2026-09-01~09-22，scope=全部】完全复现原告数字：
- 分子 newMembers = 149
- 分母 trialFootfall（代码实际口径，customer_type IN ('体验客','小美客')）= 533 → 看板显示 27.95%
- 本期内成为会员且本期到过店（被分母抹掉的人）= 139
- 补回后 149/672 = 22.17%（虚高 26%）
- 149 名新会员中 139 人本期到过店（139/149 = 93%），即分子几乎整体被排除在分母外。

【排除机制是 100% 确定性的，不是概率事件】
`SELECT COUNT(*) FROM client_wechat_users WHERE became_member_at IS NOT NULL AND customer_type <> '会员客'` = **0 行**。即凡有 became_member_at 的顾客，customer_type 必为 '会员客'，必被 IN ('体验客','小美客') 剔除。叠加 db/scripts/recalc-all-customer-types.js:46「customer_type 仅向上跃迁」，无任何降级回流路径。

【按门店复算 2026-09，35 家有新会员的门店逐行核对，与原告清单逐项一致】
南昌云暖店 3/0 → 显示 '--'，真实 100.0%
九江长江店 6/0 → 显示 '--'，真实 100.0%
自贡恒太 4/4、南昌金域 9/9、九江鸿蒙 1/1、南昌江信 1/1 → 显示 100.00%，真实均 50.0%
自贡富豪 87.5%→46.7%、南昌梦时代 75.0%→42.9%、南昌万科 69.2%→40.9%、九江快乐 66.7%→40.0%、南昌景星 60.0%→37.5%、九江联盛 55.6%→38.5%、南昌锦城 54.5%→35.3%、九江丽都 54.5%→37.5%、南昌英伦 53.8%→35.0% ……
35 家全部虚高（每家 converted ≥ 1），12 家 ≥ 真实值 1.5 倍。

【比原告更严重的一层：我另跑 2026-08，看板会吐出超过 100% 的「成交率」】
九江长江店 新增会员 8 / 分母 1 → **显示 800.0%**（真实 100.0%）
南昌景星店 7/4 → 显示 175.0%（真实 100.0%）
自贡恒太店 5/3 → 显示 166.7%（真实 62.5%）
自贡汇东店 8/7 → 显示 114.3%（真实 53.3%）
自贡富豪店 9/8 → 显示 112.5%（真实 52.9%）
formatPercent（fengyu-admin/src/lib/data-center/format.ts:33）无 100% 截断，直接输出 "800.00%"。一个标称「成交率」的百分比列在生产数据上渲染 800%，已不是口径之争。

【排除了两个替代解释】
1. 归因漂移（分子用 bound_store_id、分母用 so.store_id）不是成因：九江长江店 8 月 8 名新会员中 7 人就在本店到过店，1+7=8 → 修正后恰为 100%，与 800% 的落差全部来自时间轴剔除。
2. 2026-03~06 集团分母恒为 0 属数据真空（service_orders 最早 2026-07，到店行数 0），不算本缺陷；原告未过度主张这一段，其数据是干净的。

【到店人群当前类型分布，佐证分母被系统性掏空】
2026-09：到店 3123 人 = 会员客 1434 + 体验客/小美客 533 + 流量客 1156
2026-08：到店 3024 人 = 会员客 1398 + 体验客/小美客 480 + 流量客 1146
- **验证员理由**：我按「默认是误报」的立场做了五条证伪尝试，全部失败。

1）证伪「原告读错代码 / 上游有过滤兜底」——失败。
fengyu-admin/src/actions/data-center/customer.ts:395-411 的 queryTrialFootfall 与明细副本 :731-740 的 traffic_cust CTE 是同一条 `AND c.customer_type IN ('体验客','小美客')`，没有任何 became_member_at 时态守卫、没有 as-of 快照、没有上游 CTE 额外放宽。相除处 :1015-1019（KPI）与 :873（明细行）直接 safeDiv，调用方无补偿。safeDiv 定义在 :846 `(b > 0 ? a / b : null)`，format.ts:19/33 把 null 渲染成 '--'，且百分比不截断。原告的代码引用逐行属实。

2）证伪「这是已拍板的设计意图」——这是我最用力的一条，结论是只挡住了一半。
notes/tickets/archives/2026-04-25-mgmt-traffic-stats-page.md:246 确有「D-2（D-conv-denom）= B：区间内到店的体验客 + 小美客。与升级链路对齐」，metrics.md:403 标了 `-- 已决 D-conv-denom=B`，:407-409 写「分母含义 = 区间内有到店但未达会员的活跃池」，customer.ts:22 与 :394 注释也回引了该编号。代码确实忠实实现了已决文档 —— 这一点原告说对了，我认可。
但 D-2 回答的是「分母由哪几类人群构成」（体验客+小美客，而非把流量客也算进去），它没有回答、也没有任何一行文档触及「本期内完成转化的人要不要留在分母里」这条正交的时间轴问题。反证是 metrics.md 自己在紧邻的 D-4 条目明确写了时态自觉：「分母会员客以 customer_type 当前快照为准…T2 历史化落地后，本指标同步切换」——团队对 snapshot-vs-historical 是有意识的，唯独 trialFootfall 没挂这条待办。
更关键的是：任何口径拍板都无法把「800.00% 的成交率」和「转化率 100% 的门店显示为 '--'」解释成想要的输出。所以设计意图这条防线不成立，最多解释「为什么没人发现」。

3）证伪「数据上不成立 / 原告数字夸大」——失败，反而更糟。
我独立重写 SQL 复算，149/533/139 三个数完全吻合；按门店 35 行逐项比对，原告列的每一家门店、每一个百分比都对得上，没有一处夸大。我再往前跑了一个月，发现了原告漏报的 800% 这类超 100% 输出。

4）证伪「已被既有守护覆盖」——失败，守护反而钉死了缺陷。
consistency.customer.test.ts:484-491 是字面量正则 `customer_type IN ('体验客','小美客')`，它把这条 WHERE 钉成不可改（admin + staff 双端），只防漂移不判对错；修复时必须同步改它。customer.test.ts:271 的 `expect(m.metrics.convRate).toBeNull()` 用的是 new_members=0 且 traffic_customers=0 的全零行，不覆盖「分子>0 而分母=0」这个真实失败态。

5）额外发现的影响面扩大：同一缺陷在员工端有镜像副本 fengyu-staff/cloudfunctions/staffApi/routes/mgmt-traffic.js:491，同一条 `AND c.customer_type IN ('体验客', '小美客')`，由跨端 snapshot 守护绑定，店长在小程序看到的也是同一组被放大的数。gh issue 全量搜索 成交率/convRate/流量客 无任何在办条目，不是已知待修项。

定级从 P1 上调到 P0 的依据：不是「特定条件下错」，而是 35/35 有新会员的门店每期全部虚高（整列失真），KPI 卡虚高 26%，并能产出 800% 这种非百分比的数值与「真实 100% 却显示 '--'」的反向失真，门店转化能力排名被整体扭曲——越把体验客转化干净的门店排得越离谱。符合任务给定的 P0「时间轴错位导致整列失真」。
- **既有守护**：未被覆盖，且既有守护反向固化了缺陷。/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/consistency.customer.test.ts:484-491 以字面量正则钉住 `customer_type IN ('体验客','小美客')`（admin + staff 双端断言），只防跨端漂移、不校验口径正确性，修复时必须一并修改否则测试转红。/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/customer.test.ts:271 的 convRate 防除零用例喂的是 new_members=0 且 traffic_customers=0 的全零夹具，不覆盖「分子>0、分母=0」这一真实失败态；:241 的 `toBeCloseTo(0.4)` 同样只验算术不验人群。/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/ 下无 convRate 相关测试。
- **是否设计意图**：部分是，但不足以解释缺陷。D-conv-denom=B 确为 2026-04-25 拍板项（notes/tickets/archives/2026-04-25-mgmt-traffic-stats-page.md:246「B：区间内到店的体验客 + 小美客。与升级链路对齐」；notes/references/metrics.md:403 `-- 已决 D-conv-denom=B`、:407-409「分母含义 = 区间内有到店但未达会员的活跃池」；代码注释 customer.ts:22 与 :394 均回引该编号）。但该决策只裁定「分母由哪几类人群构成」，未涉及「本期已转化者是否保留在分母内」这条时间轴维度；metrics.md 在紧邻的 D-4 条目对同类 snapshot 问题写了显式待办（「T2 历史化落地后本指标同步切换」），唯独 trialFootfall 没有。且无论哪种口径拍板，都无法让「成交率 = 800.00%」和「真实 100% 显示为 '--'」成为可接受输出。git log 显示该行自首次实现 a2b38e4f 起从未被审视过，gh issue 无在办条目。
- **建议修法**：把分母从「当前快照未达会员」改成「期初未达会员的到店活跃池」：`AND (c.became_member_at IS NULL OR c.became_member_at::date >= ${range.start}) AND (c.customer_type IN ('体验客','小美客') OR c.became_member_at::date BETWEEN ${range.start} AND ${range.end})`，使分子成为分母的真子集、结果天然落在 0~100%。四处必须同改：customer.ts:395-411（KPI）、customer.ts:731-740（明细 traffic_cust CTE）、staffApi/routes/mgmt-traffic.js:491（员工端镜像），以及 metrics.md:395-409 与 consistency.customer.test.ts:484-491 的字面量守护。需产品先拍板「已转化者算不算分母」（等价于把 D-conv-denom 补一条时态条款），修复后建议回填校验 2026-08 的 800% 门店归位到 100%。

<details><summary>验证 SQL</summary>

```sql
-- 看板值 vs 补回本期转化者后的值（按门店，2026-09）
WITH skel AS (SELECT s.store_id,s.store_name FROM stores s JOIN org_nodes n ON s.org_node_id=n.id AND n.type='门店' WHERE n.is_active),
nm AS (SELECT c.bound_store_id sid,COUNT(*) n FROM client_wechat_users c WHERE c.became_member_at::date BETWEEN '2026-09-01' AND '2026-09-22' GROUP BY 1),
tc AS (SELECT so.store_id sid,COUNT(DISTINCT so.client_user_id) n FROM service_orders so JOIN client_wechat_users c ON c.user_id=so.client_user_id WHERE so.status='已完成' AND so.service_date BETWEEN '2026-09-01' AND '2026-09-22' AND c.customer_type IN ('体验客','小美客') GROUP BY 1),
cv AS (SELECT so.store_id sid,COUNT(DISTINCT so.client_user_id) n FROM service_orders so JOIN client_wechat_users c ON c.user_id=so.client_user_id WHERE so.status='已完成' AND so.service_date BETWEEN '2026-09-01' AND '2026-09-22' AND c.became_member_at::date BETWEEN '2026-09-01' AND '2026-09-22' GROUP BY 1)
SELECT sk.store_name,COALESCE(nm.n,0) new_mem,COALESCE(tc.n,0) denom_shown,COALESCE(cv.n,0) converted,
 ROUND(COALESCE(nm.n,0)::numeric/NULLIF(tc.n,0)*100,1) shown_pct,
 ROUND(COALESCE(nm.n,0)::numeric/NULLIF(COALESCE(tc.n,0)+COALESCE(cv.n,0),0)*100,1) fixed_pct
FROM skel sk LEFT JOIN nm ON nm.sid=sk.store_id LEFT JOIN tc ON tc.sid=sk.store_id LEFT JOIN cv ON cv.sid=sk.store_id
WHERE COALESCE(nm.n,0)>0 ORDER BY shown_pct DESC NULLS FIRST;
```

</details>

## A5. [P1][CONFIRMED] 选「今年」等跨 2026-07-03 数据割点的区间时，新客客单价分子分母数据深度不一致，被结构性拉低 30%

- 审计视角：客量板块　板块：customer　指标：新客客单 newCustomerAvgTicket（KPI + 明细列）；同源影响成交率 convRate
- **断言**：分母 newMemberCount 读 client_wechat_users.became_member_at，该字段由 WorkFine 导入，最早到 2022-08，覆盖 4 年；分子 newMemberSpend 读 sale_order_performance_events（底表 sale_order_payments），prod 全库最早款项归属日期是 2026-07-03。于是任何跨越 2026-07-03 的区间（首选项「今年」、以及自定义区间）里，成为会员早于割点的那批人进了分母却在分子里结构性缺席，客单价被稀释。成交率的分母（service_orders，最早 2026-07-08）同理，方向相反、被放大。
- **规范依据**：notes/references/metrics.md:392 `新增会员客单价（newMemberAvgTicket） | newMemberSpend / newMemberCount | 派生；防除零 → '--'`；:386-389 分子明确带 `spe.legacy_source IS DISTINCT FROM 'workfine'`（历史单收入隔离），而分母 `became_member_at::date BETWEEN` 没有对应的隔离条件——规范本身就把「隔离了 workfine 收入的分子」除以「含 workfine 时代会员的分母」。
- **代码证据**：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/customer.ts:354-368（分母，无任何数据可得性约束）
```sql
SELECT COUNT(*) AS v FROM client_wechat_users c
WHERE ${sc} AND c.became_member_at IS NOT NULL
  AND c.became_member_at::date BETWEEN ${range.start} AND ${range.end}
```
:371-392（分子，只能取到 sale_order_performance_events 里存在的款项）
```sql
SELECT COALESCE(SUM(spe.amount::numeric), 0) AS v
FROM sale_order_performance_events spe JOIN sale_orders o ... 
WHERE ... AND spe.performance_date BETWEEN ${range.start} AND ${range.end}
```
相除：:983-994 `return count > 0 ? round2(spend / count) : null`；明细行 :870 `const newAvg = op ? safeDiv(round2(op.newMemberSpendTotal), op.newMembers) : null`（分子 newmem_spend :714-729 按订单门店归组，分母 newmem :704-712 按绑定门店归组）。
- **数据证据（发现者）**：prod 只读库实测：
· sale_order_payments 全表 95,272 行，performance_attribution_date 跨度仅 2026-07-03 ~ 2026-09-21；legacy_source='workfine' 的 18,761 张销售单**一行款项都没有**，所以割点前的消费在库里根本不存在。
· service_orders 已完成 14,284 行，service_date 跨度 2026-07-08 ~ 2026-09-21。
· became_member_at 跨度 2022-08 ~ 2026-09（50 个月，1,898 人）。
· 区间「今年」(2026-01-01~2026-09-22, scope=全部)：newMemberCount=581，newMemberSpend=3,236,798.40 → 看板显示新客客单 5,571.08。拆开看：234 人（40.3%）成为会员早于 2026-07-03，其中 173 人（74%）区间内消费为 0，人均仅 2,060.96；割点后的 347 人人均 7,938.14。看板值比「数据真能覆盖的那批人」低 29.8%。
· 同区间成交率：581 / 842 = 69.0%（分子含 4 年历史会员，分母只有 2.5 个月到店记录）。对比本月 27.95%。
- **影响面**：「今年」是时间筛选四个预设之一，默认「本月」之外最常用。集团口径下 581 个新增会员里 234 个（40.3%）是「只进分母不进分子」的幽灵，新客客单 5,571.08 元 vs 可比口径 7,938.14 元（差 2,367 元/人，总额口径上相当于 138 万元的分母虚增）；成交率 69.0% 同时被放大。市场/门店两张明细表的「新客客单」「成交率」列在同一区间下同样失真。
- **验证员复算**：我在 prod 只读库（118.178.196.26:5433 / fengyu_ro）逐条复算，原告给的数字**全部精确复现，无一偏差**：

1) 数据视野（三条独立时间轴）
- `sale_order_payments`：95,272 行，`performance_attribution_date` ∈ [2026-07-03, 2026-09-21]
- `service_orders (已完成)`：14,284 行，`service_date` ∈ [2026-07-08, 2026-09-21]
- `client_wechat_users.became_member_at`：1,898 人，∈ [2022-08-16, 2026-09-21]（跨 50 个月）

2) 根因比原告说得更硬：`sale_orders` 按 legacy_source 分组 —— workfine 18,761 单（sale_order_datetime ∈ [2022-08-16, 2026-08-01]）对应 `sale_order_payments` **0 行**；非 legacy 13,098 单对应 95,272 行。也就是说历史单在 `sale_order_performance_events` 视图里**根本不产生任何行**。

3) 按代码实际口径复算 KPI（admin/scope=all，今年 = 2026-01-01~2026-09-22，scopeFilterSql 只剩 activeStoreCondition）：
`newMemberCount=581`，`newMemberSpend=3,236,798.40`，**新客客单 = 5,571.08**（与原告一字不差）

4) 按割点拆分分母：
- 割点前（became_member_at < 2026-07-03）：234 人（40.3%），其中 **173 人区间内分子为 0**，人均 2,060.96
- 割点后：347 人，仅 15 人为 0，人均 **7,938.14**
→ 看板值比「数据真能覆盖的那批人」低 **29.8%**

5) 我额外补的一刀（原告没做，但让性质更确定）：这 234 个「幽灵分母」在同一区间内**并非真的没消费** —— 他们有 **687 张 workfine 单、已收 ¥2,159,716.00**（`o.performance_attribution_date` 落在区间内）。若按 metrics.md:541「顾客详情页年度消费」已有的 legacy 分支口径补回，今年新客客单应为 (3,236,798.40+2,159,716+71,562)/581 = **¥9,411.49**，现值 5,571.08 相当于低报 41%。

6) 成交率同源复现：今年 `newMemberCount/trialFootfall = 581/842 = 69.0%`；本月 `149/533 = 27.95%`。分子 4 年历史、分母 2.5 个月到店，方向相反被放大。

7) 明细表（byStore）同样失真，且更极端（门店 | 新增会员 | 其中割点前 | 看板显示新客客单）：
南昌蓝茉店 61 | 41 | ¥1,724.28；南昌云锦店 43 | 30 | ¥2,632.63；南昌青云店 34 | 25 | ¥1,183.97；南昌万科店 50 | 21 | ¥3,592.92。青云店 74% 的分母是幽灵，客单被压到 ¥1,183.97。

8) 反向排除（我试图证伪但没成功的两条）：
- 同比/环比单元格**不会**出错：2025 同期窗口 newMemberCount=311 / spend=0 → avg=0 → `deltaPct(base=0)` 返回 null → 前端 '--'，优雅降级。所以错的只有本期值，不是 delta。
- 同卡片的兄弟指标 `会员客单价 memberAvgTicket`（customer.ts:329-350）**没有**这个缺陷：它的分母是 `COUNT(*) FROM member_spend`（即有款项流水的人），分子分母同源自洽。这恰好证明本条不是「整个看板都没历史数据」的普遍现象，而是这一对分子/分母独有的结构性错配。
- **验证员理由**：我的默认立场是误报，按四条路线逐一尝试证伪，全部失败：

**证伪路线 1「原告读错代码 / 漏看上游过滤」** —— 失败。我通读 customer.ts:354-368（分母）、:371-392（KPI 分子）、:704-712 / :714-729（明细分母/分子）、:870（明细相除）、:983-994（KPI 相除），以及 `scope-sql.ts` 的 `scopeFilterSql`。分母那条 SQL 的 WHERE 确实只有 `scopeFilterSql(...,'c.bound_store_id')` + `became_member_at IS NOT NULL` + `BETWEEN`，上游无 CTE 收窄、下游 `count > 0 ? round2(spend/count) : null` 也只防除零不防错配。`params.ts`/`context.ts`/`time-range.ts` 无任何区间下限钳制，`scope-time-filter.tsx:17` 确认 `{ key: "year", label: "今年" }` 是 UI 上四个预设之一（可直接点）。原告读得准确。

**证伪路线 2「数据上不成立」** —— 失败，且反向加强。我按代码口径原样跑了一遍、又按原告口径拆了一遍，581 / 3,236,798.40 / 5,571.08 / 234 / 173 / 2,060.96 / 7,938.14 / 842 / 69.0% / 27.95% 十个数字**全部逐位吻合**。我还补跑了原告没做的一步（第 5 条），证明那 234 人不是「本来就没消费」，而是有 ¥2,159,716 的已收款被结构性看不见 —— 这把「数据缺失」升级成了「数据存在但被漏算」。

**证伪路线 3「属于设计意图」** —— 失败。见 isDesignIntent：2a62b49a 的意图边界是「营收/业绩总额」，而 metrics.md:541 证明同一项目在「按人算消费」时是会建 legacy 分支的。

**证伪路线 4「已被守护兜住 / 已知限制」** —— 失败。快照测试只锁分子侧，分母侧零断言。

我唯一能给被告争到的两点（已写入 dataEvidence 第 8 条，但都不构成推翻）：
(a) 同比/环比单元格不会给出错误数字，会降级成 '--'，所以受损面只有本期值一列，不是原告暗示的整张卡；
(b) 原告把机制归因于 `spe.legacy_source IS DISTINCT FROM 'workfine'` 这个过滤条件，**不完全准确** —— 该条件在当前数据上是 no-op（workfine 单 0 条 payment，根本进不了视图）。真正的机制是 legacy 单没有款项流水行。这个区别不影响结论，但**直接影响修法**：删掉那个过滤条件一分钱也补不回来。

综合：代码行为清楚、与规范逐字一致、数字可精确复现、无守护、无设计意图背书，且能给出「173 人有 ¥216 万已收却被算成 0」这样不依赖口径偏好的硬失败场景 —— 任何业务读法下「新客客单 ¥1,183.97（青云店）」都不是对的数。故 CONFIRMED，维持原告 P1（默认预设「本月」不受影响、且 2027-01-01 后「今年」预设自愈，但自定义跨割点区间是永久能力，够不上 P0）。
- **既有守护**：未被覆盖。`fengyu-admin/src/actions/data-center/__tests__/consistency.customer.test.ts` 只做逐字快照（:99 锁死 KPI 分子 SQL、:103 锁死明细 newmem_spend SQL、:511/:551 断言 `spe.legacy_source IS DISTINCT FROM 'workfine'` 必须存在且按出现次数锁死 admin 5 / staff 2 处）。它守护的恰恰是「分子必须排除 workfine」这一侧，对「分母没有对应约束」零覆盖；把分母改成任何写法它都不会红。`src/lib/data-center/time-range.ts` / `params.ts` / `context.ts` 全链路无任何 range 下限 clamp 或数据起点提示，`grep 2026-07-03|数据起点|cutover` 在 data-center 全域零命中。
- **是否设计意图**：**不是**。已拍板的设计意图只覆盖分子一侧，不覆盖这个错配：
- git 2a62b49a「fix: 历史订单不污染营收/业绩口径·跨端」的意图原文是「基于 so.received 的**经营营收聚合**统一排除 legacy_source='workfine'」—— 针对的是营收/业绩总额口径，全文未涉及以 `became_member_at` 为分母的派生比率。
- metrics.md:391-392 确实与代码逐字一致（所以这不是「代码跑偏 spec」），但规范正文里 newMemberCount 一行（:390）只有 `became_member_at::date BETWEEN` ∩ scope，**没有任何与分子对应的隔离条件**；:392 直接 `newMemberSpend / newMemberCount`。spec 本身就写下了这个错配，且无一句注释解释为何允许。
- 更关键的反证：项目**已经承认 workfine 的钱是真钱、且在「按人算消费」语境下必须计入** —— metrics.md:540-541 给「顾客详情页·年度消费」明确建了 legacy 分支：`o.legacy_source='workfine'` 时走 `CASE WHEN EXISTS(sale_items) THEN SUM(si.received) ELSE o.received END` @ `o.performance_attribution_date`。同一份规范里，「一个顾客的消费」有 legacy 分支，「一群新会员的消费」没有，这是遗漏而非取舍。
- `.42cog/` 与 notes/ 全域 grep 无任何「数据起点 / 割点 / cutover」相关的数据中心口径约定（inventory_cutover 是库存域，无关）。
- **建议修法**：对齐分子分母的数据视野，二选一（建议 a，与 metrics.md:541 已有先例同构）：(a) 给 `queryNewMemberSpend` 与明细 `newmem_spend` 补一条 legacy 分支——UNION 上 `sale_orders o WHERE o.legacy_source='workfine' AND o.status IN ('已支付','部分支付','已完成') AND o.sale_order_type IN ('销售单','转换单')` 按 `o.performance_attribution_date` 落区间、取 `CASE WHEN EXISTS(sale_items) THEN SUM(si.received) ELSE o.received END`，复用顾客详情页年度消费的口径；(b) 若产品坚持「历史单不进任何经营口径」，则分母必须同步隔离（`became_member_at >= 系统款项数据起点`，或直接排除 `legacy_source='workfine'` 达标单产生的会员），并在跨割点区间给 UI 加数据起点提示。无论选哪个，都应在 `consistency.customer.test.ts` 增加一条「分子分母时间源一致性」断言（现有快照只锁分子侧），并同步检查 staff 端 `mgmt-traffic` 的两处对端副本（#138 commit 自述 admin 5 / staff 2 共 7 处同源查询）。

<details><summary>验证 SQL</summary>

```sql
-- 今年：新增会员按「是否早于款项数据起点」拆分
WITH act AS (SELECT s.store_id FROM stores s JOIN org_nodes n ON s.org_node_id=n.id WHERE n.type='门店' AND n.is_active),
nm AS (SELECT c.user_id,c.became_member_at::date d FROM client_wechat_users c WHERE c.bound_store_id IN (SELECT store_id FROM act) AND c.became_member_at::date BETWEEN '2026-01-01' AND '2026-09-22'),
sp AS (SELECT o.client_user_id uid,SUM(spe.amount::numeric) s FROM sale_order_performance_events spe JOIN sale_orders o ON o.sale_order_id=spe.sale_order_id WHERE o.store_id IN (SELECT store_id FROM act) AND spe.sale_order_type IN ('销售单','转换单') AND spe.status='已支付' AND spe.change_type IN ('首次支付','回款','退款') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN '2026-01-01' AND '2026-09-22' GROUP BY 1)
SELECT CASE WHEN nm.d<'2026-07-03' THEN '早于款项数据起点' ELSE '数据覆盖期内' END grp,
 COUNT(*) people,COUNT(*) FILTER (WHERE sp.s IS NULL) zero_spend,
 ROUND(COALESCE(SUM(sp.s),0),2) spend,ROUND(COALESCE(SUM(sp.s),0)/COUNT(*),2) avg_each
FROM nm LEFT JOIN sp ON sp.uid=nm.user_id GROUP BY 1;
-- 款项/服务数据的真实起点
SELECT MIN(p.performance_attribution_date),MAX(p.performance_attribution_date) FROM sale_order_payments p;
SELECT MIN(service_date),MAX(service_date) FROM service_orders WHERE status='已完成';
```

</details>

## A6. [P2][UNCERTAIN] 一次/二次客活按服务单行数计，而非到店天数，62 名顾客被从「回店1次」错划到「回店2次」

- 审计视角：客量板块　板块：customer　指标：当月一次人数 visitOnce / 当月二次人数 visitTwice；明细列 回店1次、1次达成率、回店2次、2次达成率
- **断言**：客活用 `COUNT(*)` 数 service_orders 行数当作「到店次数」。同一天开两张服务单（换项目/换技师/分次录入）就被记成回店两次。项目内「到店次数」的另一处权威实现——cron STEP2 重算 customer_status——用的是 `COUNT(DISTINCT so.service_date)`，两套口径打架，而且正是 cron 那套在决定这里的筛选条件 customer_status。
- **规范依据**：notes/references/metrics.md:260-277「到店次数 SQL 模板（一次/二次客活共用）」写的确实是 `SELECT so.client_user_id, COUNT(*) AS n FROM service_orders so ...`，代码没跑偏；但同文件 :168-172 与 cron 实现把「到店」定义为去重服务日。规范内部两处对「到店次数」定义不一致，看板取了会高估的那一种。
- **代码证据**：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/customer.ts:201-217（queryActive）
```sql
WITH visit_count AS (
  SELECT so.client_user_id, COUNT(*) AS n
  FROM service_orders so
  WHERE ${ssc} AND so.status='已完成' AND so.client_user_id IS NOT NULL
    AND so.service_date BETWEEN ${range.start} AND ${range.end}
  GROUP BY so.client_user_id)
SELECT COUNT(*) AS v FROM visit_count vc JOIN client_wechat_users c ...
WHERE ... AND c.customer_status IN ('保有会员-稳定','保有会员-有效') AND ${nClause}
```
明细副本同写法在 :521-541（`COUNT(*) AS n` 在 :522，`FILTER (WHERE n = 1)` / `FILTER (WHERE n >= 2)` 在 :536-537）。
对照 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/cron/steps/refresh-customer-status.ts:36-38 `COUNT(DISTINCT so.service_date) AS total_visits` / `COUNT(DISTINCT so.service_date) FILTER (WHERE so.service_date >= CURRENT_DATE - INTERVAL '90 days') AS visits_90d`。
- **数据证据（发现者）**：prod 只读库，2026-09-01~2026-09-22，scope=全部，限定 customer_status ∈ ('保有会员-稳定','保有会员-有效')：
· 按行数（现实现）：回店1次 = 569，回店2次 = 865
· 按去重到店日（cron 口径）：回店1次 = 631，回店2次 = 803
· 1,434 名保有会员中 253 人行数 ≠ 到店天数；其中 62 人**当月只到店 1 天却开了 ≥2 张服务单**，被从「回店1次」搬到「回店2次」。
· 偏差幅度：回店1次低报 62/631 = 9.8%，回店2次高报 62/803 = 7.7%。
- **影响面**：KPI「当月一次人数/当月二次人数」两格 + 市场/门店两张注册客活明细表的 4 列（回店1次、1次达成率、回店2次、2次达成率）全部偏移；集团口径 62 人错档（占保有会员 4.3%）。达成率是门店运营考核用的比率列，1次达成率被低估约 10%、2次达成率被高估约 8%。staff 端 mgmt-traffic.js 是同一份写法，两端会一起错，snapshot 测试不会报警。
- **验证员复算**：prod 只读库（118.178.196.26:5433，fengyu_ro）实跑，区间 2026-09-01~2026-09-22、在营启用门店、customer_status ∈ ('保有会员-稳定','保有会员-有效')：

1) 原告数字逐个复现，一字不差：
   once_by_rows=569 | once_by_days=631 | twice_by_rows=865 | twice_by_days=803 | misclassified=62 | cohort=1434

2) 我另找到一条原告没用上、但杀伤力大得多的实证 —— 项目自己的 `client_wechat_users.monthly_activity` 列（枚举就是 '一次客活'/'二次客活'/'0次客活'），同一批人的分布是：
   二次客活=803、一次客活=631、0次客活=395
   即 monthly_activity 与「去重到店日」口径**数值完全相等（631/803）**，与数据中心的 569/865 差 62 人。而 monthly_activity 是 admin 顾客列表的可筛选项（customers-page.tsx:32 `MONTHLY_ACTIVITIES`）。也就是说同一个 admin 里，顾客列表筛「二次客活」得 803 人、数据中心「当月二次人数」显示 865 人，两个界面同名概念差 62。

3) 我进一步验证这 62 人是不是「真的到店两次」：
   62 人共 128 张服务单，cross_store=0（**没有一个人跨店**），单人最多 3 张。全部是同一天、同一门店被拆成 2~3 张服务单，业务语义上无论如何都算「回店 1 次」。

4) 换「今年」区间（2026-01-01~2026-09-22）同样成立：once_by_rows=363 vs once_by_days=407，44 人错档 —— 不是当月偶发。

复跑 SQL（只读）：
WITH act AS (SELECT s.store_id FROM stores s JOIN org_nodes n ON s.org_node_id=n.id WHERE n.type='门店' AND n.is_active),
vc AS (SELECT so.client_user_id,COUNT(*) n_rows,COUNT(DISTINCT so.service_date) n_days,COUNT(DISTINCT so.store_id) n_stores
  FROM service_orders so WHERE so.store_id IN (SELECT store_id FROM act) AND so.status='已完成'
   AND so.client_user_id IS NOT NULL AND so.service_date BETWEEN '2026-09-01' AND '2026-09-22' GROUP BY 1)
SELECT COUNT(*) FILTER (WHERE n_rows=1) once_rows, COUNT(*) FILTER (WHERE n_days=1) once_days,
       COUNT(*) FILTER (WHERE n_rows>=2) twice_rows, COUNT(*) FILTER (WHERE n_days>=2) twice_days,
       COUNT(*) FILTER (WHERE n_days=1 AND n_rows>=2) misclassified,
       COUNT(*) FILTER (WHERE n_days=1 AND n_rows>=2 AND n_stores>1) cross_store
FROM vc JOIN client_wechat_users c ON c.user_id=vc.client_user_id
WHERE c.bound_store_id IN (SELECT store_id FROM act)
  AND c.customer_status IN ('保有会员-稳定','保有会员-有效');
-- 对照：SELECT monthly_activity, COUNT(*) FROM client_wechat_users c WHERE 同 scope 同 status GROUP BY 1;
- **验证员理由**：我按「默认是误报」逐条做了五次证伪尝试，四次失败、一次半成功：

【证伪 1：代码读错了？】失败。/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/customer.ts:203 确实是 `SELECT so.client_user_id, COUNT(*) AS n`，明细副本 :522 同写法，:536-537 `FILTER (WHERE n = 1)` / `FILTER (WHERE n >= 2)`。上游没有别的去重、CTE 没有兜底、调用方（:884/:886 `safeDiv(ra.visitOnce, ra.retained)`）也没修正，分母 retained 是独立的 90 天口径不受影响，所以偏差 100% 透传到「1次达成率/2次达成率」。明细 CTE 按 (client_user_id, bound_store_id, customer_status) 分组，bound_store_id 来自客户表、函数依赖 user_id，**不存在 JOIN 扇出**，这点原告没说错也没夸大。

【证伪 2：数据上不成立？】失败。569/631/865/803/62/1434 六个数我独立跑出来完全一致。

【证伪 3：原告的规范依据站得住吗？】**半成功 —— 原告这里确实引错了**。
 · 原告称 notes/references/metrics.md:168-172「把到店定义为去重服务日」。我读了，:169-172 讲的是**员工数历史化**（hired_at / resigned_at / is_resigned），跟「到店」毫无关系，是错误引用。
 · 原告拿 refresh-customer-status.ts:36-38 的 `COUNT(DISTINCT so.service_date) AS total_visits` 当对照，也不成立：那是**终身分档器**（total_visits≥6→保有会员-稳定、≤5→保有会员-有效），是另一个指标、另一个时间窗，用不同口径本来就合理，不能算「打架」。
 · 更关键的是，metrics.md:260-277 标题就叫「到店次数 SQL 模板（一次/二次客活共用）」，正文写的就是 `COUNT(*) AS n`。所以 **代码与它的口径文档逐字相符，「实现跑偏」这个指控不成立**。另外 metrics.md:229-230 明确定义「客流量（次）= service_orders 行数」，全局「次」的语义本来就是单行，代码与该章节自洽。

【证伪 4：已被守护覆盖 / 属于已拍板设计意图？】失败，两头都落空。见 guardedByTest / isDesignIntent 两栏。

【证伪 5：那 62 人其实是真回店两次？】失败，而且反向坐实了问题 —— 62 人全部同门店同一天（cross_store=0），是拆单录入。

结论：原告的**引证链是坏的**（引错行号 + 拿错对照实现），但**结论方向被我用另一条更硬的证据独立支撑了**：项目自己的 `monthly_activity` 枚举用的就是「一次客活/二次客活」这两个名字，cron 注释白纸黑字写「按『当月到店天数』，service_date 去重，**非服务单次数**」，且 prod 实测 631/803 与去重日口径完全吻合。所以真正的矛盾不是原告指的那一对，而是 **数据中心 COUNT(*) ⟷ monthly_antivity COUNT(DISTINCT service_date)**，两者都在 admin 界面上暴露给同一批用户。

之所以给 UNCERTAIN 而不是 CONFIRMED：代码行为清楚、偏差量化、两端不一致是事实，但 metrics.md:260-277 明文背书了现有的 COUNT(*) 写法，D-1~D-7 七个决策点里也从没讨论过这条 —— 究竟以 metrics.md 的「服务单行」为准还是以 monthly_activity 的「到店天数」为准，是产品口径选择，我无权替业务拍板。这正落在 UNCERTAIN 的定义上。之所以不给 REFUTED：我五次证伪没能推翻数据事实与跨界面矛盾，只推翻了原告的论证过程。
- **既有守护**：**未被守护。**

· /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/consistency.customer.test.ts 文件头列出的守护项只有 7 条：became_member_at、customer_status 枚举名、消费分桶阈值、sales_category、成交率分母、spend 口径、anchor 反推字面量（visits_90d_prev / 6 months / 12 months / 90 days）。**「到店次数按行还是按天」不在清单里**，我 grep `visit_count` / `COUNT(*) AS n` 在整个 __tests__ 目录零命中 —— 把 `COUNT(*)` 改成 `COUNT(DISTINCT so.service_date)` 只改一端，这个守护不会红。
· /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/customer.test.ts:228-268 只断言 visitOnce/visitTwice/visitOnceRate 等 key 存在、除零返回 null、比值 0.375，是 mock 数据，不碰真实口径。
· 反向确认跨端确实同错：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/mgmt-traffic.js:274 与 :298 同为 `SELECT so.client_user_id, COUNT(*) AS n`，原告「两端会一起错、snapshot 不报警」这句是对的。
· 另一侧的 cron 口径倒是被守护了：fengyu-admin/src/cron/__tests__/refresh-monthly-activity.test.ts 有 inline snapshot + 字面量断言（commit ac984595 / 7b03e1c9），即**「按天」那一套被测试钉死、「按行」那一套没人管**，未来只会朝着分歧加大的方向漂。
- **是否设计意图**：**不属于已拍板的设计意图 —— 这条口径从未被真正讨论过。**

正面证据（支持「现状有文档背书」）：
· notes/references/metrics.md:260-277「到店次数 SQL 模板（一次/二次客活共用）」正文即 `COUNT(*) AS n`，:254-255 表格写「区间内到店次数 = 1 / ≥ 2」。
· metrics.md:229-230「客流量（次）= service_orders 行数……与首页的『客量』语义一致（均为单次）」。

反面证据（支持「是疏漏而非拍板」）：
· notes/tickets/archives/2026-04-25-mgmt-traffic-stats-page.md 的决策表共 7 个决策点 D-1~D-7（D-react-source / D-conv-denom / D-newMemberSpend / 会员客时态 / D-trafficSessionsScope / D-act-status-mapping / D-package-path），**没有任何一条涉及「到店次数按行还是按天」**。该 ticket 的 UI 线框（:66-69）只写「一次客活 / 保有会员到店1次」「二次客活 / 保有会员到店≥2次」，没有定义「到店」的计数单位。
· 反方向的明确表态存在，而且更强硬：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/cron/steps/refresh-monthly-activity.ts:5-8 文件头注释原文——
  「业务口径（按「当月到店天数」，service_date 去重，**非服务单次数**）：二次客活：当月到店 >= 2 天；一次客活：当月到店 = 1 天」
  这是项目里唯一一次为「一次客活/二次客活」这两个名字显式选边，而它选的是「天」，并显式排斥「服务单次数」。
· metrics.md 全文 grep「monthly_activity / 月度客活 / 到店天数」**零命中**，.42cog/ 下也零命中 —— 即 monthly_activity 这套口径根本没进指标文档，两套定义是在互不知情的情况下各自长出来的。
· git log：`584765c1 feat(admin): 客活/消费档位纳入 cron-worker STEP`（天口径）与 `a2b38e4f feat(admin): 数据中心四板块取数 action`（行口径）是两条独立脉络，没有任何 commit 记录把二者对齐过。
- **建议修法**：先让业务方在两个口径里二选一拍板，再一次性改 5 处并补守护，不要只改一端：

1）若拍板「按到店天数」（我倾向这个 —— 62 人全是同店同日拆单，且 monthly_activity 已显式选了天口径）：把 `COUNT(*) AS n` 改成 `COUNT(DISTINCT so.service_date) AS n`，四处同步 —— fengyu-admin/src/actions/data-center/customer.ts:203（queryActive）与 :522（明细 CTE）、fengyu-staff/cloudfunctions/staffApi/routes/mgmt-traffic.js:274 与 :298；同步改 notes/references/metrics.md:260-277 的 SQL 模板与 :254-255 表格措辞（「到店次数」→「到店天数」）。

2）若拍板「按服务单行数」：那就要把 refresh-monthly-activity.ts:36 的 `COUNT(DISTINCT so.service_date)` 反向改成 `COUNT(*)`，并删掉 :5-8「非服务单次数」那句注释，否则 admin 顾客列表筛「二次客活」和数据中心「当月二次人数」会一直差着 62 人。

3）无论选哪个，都要在 consistency.customer.test.ts 的不变量清单里**新增第 8 条**，把「一次/二次客活的计数单位」钉成字面量断言（现在这条完全没守护），并在 metrics.md 补一节 monthly_activity 口径——它目前在指标文档里是彻底缺席的，这才是两套定义分叉的根因。

4）顺带提醒（不在本条范围内，但同源）：KPI 标签写死「**当月**一次人数」（customer-board.tsx:18-19），而数据实际跟随顶部 TimeRange（今日/本周/本月/今年/自定义）。选「今年」时这格显示的是全年只开过 1 单的人数，标签会误导。

<details><summary>验证 SQL</summary>

```sql
WITH act AS (SELECT s.store_id FROM stores s JOIN org_nodes n ON s.org_node_id=n.id WHERE n.type='门店' AND n.is_active),
vc AS (SELECT so.client_user_id,COUNT(*) n_rows,COUNT(DISTINCT so.service_date) n_days
  FROM service_orders so WHERE so.store_id IN (SELECT store_id FROM act) AND so.status='已完成'
   AND so.client_user_id IS NOT NULL AND so.service_date BETWEEN '2026-09-01' AND '2026-09-22' GROUP BY 1)
SELECT COUNT(*) FILTER (WHERE n_rows=1) once_by_rows, COUNT(*) FILTER (WHERE n_days=1) once_by_days,
 COUNT(*) FILTER (WHERE n_rows>=2) twice_by_rows, COUNT(*) FILTER (WHERE n_days>=2) twice_by_days,
 COUNT(*) FILTER (WHERE n_days=1 AND n_rows>=2) misclassified
FROM vc JOIN client_wechat_users c ON c.user_id=vc.client_user_id
WHERE c.bound_store_id IN (SELECT store_id FROM act) AND c.customer_status IN ('保有会员-稳定','保有会员-有效');
```

</details>

## A7. [P3][UNCERTAIN] 沉睡/冰冻/休眠三个 KPI 完全不读时间筛选（恒为今日 cron 快照），却与按所选区间反推的「激活」三档并排展示

- 审计视角：客量板块　板块：customer　指标：沉睡人数 dormant / 冰冻人数 frozen / 休眠人数 deep（vs 激活沉睡 / 激活冰冻 / 激活休眠）
- **断言**：queryStatusCount 的函数签名里根本没有 range 参数，读的是 client_wechat_users.customer_status 当前列值（cron 每天 03:00 按 CURRENT_DATE 重算）。而同一排的 reactivated* 三档是拿 anchor = range.start - 1 实时反推的区间指标。用户把时间筛选切到任何历史区间（「今年」或自定义），左边三格纹丝不动、右边三格变，两组数不在同一时间轴上却被并排放进「会员状态与客活」同一张卡片组。
- **规范依据**：notes/references/metrics.md:240「区分"截面"与"区间"：5 项状态人数为截面快照；2 项客活与 3 项激活为区间统计。」规范承认截面/区间混排，但规范的时间维度只有 本月/上月/本年 三档且一律锚 NOW（:186-196），endDate 基本等于今天；admin 数据中心把时间维度扩成 今日/本周/本月/今年/自定义（:900-903），截面指标就彻底脱锚了。
- **代码证据**：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/customer.ts:175-189
```ts
async function queryStatusCount(
  session: AuthSession,
  scope: DataCenterScope,
  status: '保有会员-稳定' | '保有会员-有效' | '沉睡' | '冰冻' | '休眠',
): Promise<number> {   // ← 没有 range 参数
  ...
  SELECT COUNT(*) AS v FROM client_wechat_users c
  WHERE ${sc} AND c.customer_status = ${status}${memberClause}
```
调用处 :968 / :970 / :972 用 `withComparison(() => queryStatusCount(session, scope, '沉睡'), comparison, 'count', false)` —— runner 直接丢弃传入的 range；紧邻的 :969/:971/:973 则是 `withComparison((r) => queryReactivated(session, scope, r, 'warn'|'frozen'|'deep'), ...)`，用 `range.start - 1` 做 anchor（:229-287）。前端把六格放同一组：_components/customer/customer-board.tsx 的 KPI_STATUS。
- **数据证据（发现者）**：prod 只读库，scope=全部：
· customer_status 当前分布（今日快照）：保有会员-稳定 409、保有会员-有效 1420、休眠 69、沉睡 0、冰冻 0（另：非会员客一律 NULL，与 cron 段 1 一致，无脏数据——已逐行复算，2,297 名会员的存量状态与 cron 逻辑 0 偏差）。
· 区间 2026-09-01~2026-09-22：激活休眠 = 284，激活沉睡 = 0，激活冰冻 = 0 → 看板显示「休眠人数 69 / 激活休眠 284」。
· 自定义区间 2026-07-01~2026-07-31：激活休眠 = 367，而「休眠人数」仍显示 69（今日值，与 7 月无关）。
· 「沉睡人数 0 / 激活沉睡 0」「冰冻人数 0 / 激活冰冻 0」在任何区间恒为 0，因为服务单最早只到 2026-07-08，90 天窗口覆盖全部历史。
- **影响面**：KPI 卡「会员状态与客活」6 格中的 3 格（沉睡/冰冻/休眠人数）无视时间筛选。最直观的错读是「休眠 69 人 → 本月激活了 284 人」，数量级倒挂；切到 7 月更严重（69 vs 367）。市场/门店明细表的 dormant/frozen/deep 三列同样是今日快照（:543-552 status_agg 无日期条件），与同一行的 reactivated* 三列不同轴，导出的 Excel 里两组数会被直接相减做「激活率」。
- **验证员复算**：prod 只读库（118.178.196.26:5433 / fengyu_ro），今天 2026-09-22：

1) 截面侧（代码实际口径，queryStatusCount，无 range）——按 scope=all（active 门店 + bound_store_id）复算：
   dormant(沉睡∩会员客)=0、frozen(冰冻)=0、deep(休眠)=**68**、retained(稳定+有效)=1829。
   全库不加 scope：休眠 69 / 保有会员-有效 1420 / 保有会员-稳定 409 / NULL 3378。
   → 原告报的 69 是**未加 scope** 的值；看板上（scope=全部）实际是 **68**，差 1 人（该 休眠 会员的 bound_store_id 不在启用门店集合内）。其余分布与原告一致。
   会员口径自洽：customer_type='会员客' = became_member_at IS NOT NULL = 1898，会员客 customer_status 为 NULL 的 0 人、非会员客带状态的 0 人（cron 段 1/段 3 无残留），原告"无脏数据"成立。

2) 区间侧（queryReactivated，anchor=range.start-1）——我按 customer.ts:252-285 原样复算 react_deep：
   · 2026-09-01~09-22 → **284**
   · 2026-07-01~07-31 → **367**
   · 2026-01-01~09-22（「今年」档）→ **1273**
   三个数与原告完全吻合（我独立写的 LATERAL 版本，非照抄其 SQL）。

3) 两轴确实不同轴：切 7 月自定义区间，左格「休眠人数」仍出 68（今日 cron 快照），右格「激活休眠」出 367；切「今年」则是 68 vs 1273。差距最大 1205 人（68 → 1273，18.7 倍）。

4) service_orders 实际只有 2026-07-08 ~ 2026-09-21、已完成 14284 单 —— 90 天窗口覆盖全部历史，故沉睡/冰冻两档截面恒为 0，「激活沉睡/激活冰冻」也恒为 0（last_dt 要么 NULL 要么在 90 天内）。即 6 格中实际只有「休眠 68 / 激活休眠 284」这一对会产生误读，另外 4 格全 0。

5) 代码侧无派生错误：fengyu-admin/src/lib/data-center/columns.ts:68-73 六列全是 unit:'count' 原值输出，**没有任何地方把 reactivated 除以/减去 dormant 得「激活率」**。原告所说"Excel 里两组数会被直接相减"是假设的用户行为，不是代码事实。
- **验证员理由**：证伪尝试与结果：
① 查是否漏看上游过滤/调用方兜底——没有。queryStatusCount(session, scope, status) 签名里确实没有 range，withComparison 的 runner 是 `() => queryStatusCount(...)`（customer.ts:968/970/972），传入的 range 被形参丢弃；明细表 status_agg（customer.ts:543-552）同样只有 customerScope + bound_store_id IS NOT NULL，无任何日期条件。原告代码读得准确。
② 查是否 UI 已标注——没有。customer-board.tsx:22-29 的 KPI_STATUS 六项均无 hint，:87-89 只有一句泛泛的「客活 / 激活随每日重算更新，上线初期可能为 0」。对照 product-board.tsx:118-122，同类截面指标（持卡人数）有明确 UI 说明「截面快照（以当前时刻未用完疗程卡为准），不随时间区间变化」，且 metrics.md:725 对持卡明确要求「UI 加角标『截面』提示」——customer 板块缺同款提示，这是本条唯一站得住的实质缺口。
③ 查数据是否成立——成立，但数量级被原告略微夸大：scope=全部 下真实值是 68 不是 69；且 6 格中 4 格恒为 0，实际只有「休眠/激活休眠」这一对会误读。
④ 查是否设计意图——是，而且是**带理由的显式取舍**（见 isDesignIntent）。原告自己也引了 metrics.md:240，所以并非"误解口径"。
⑤ 原告的升级论证「staff 只有本月/上月/本年且一律锚 NOW，endDate 基本等于今天，所以截面近似对齐；admin 扩成 5 档才脱锚」——这条**部分被证伪**：staff 的「上月」档 endDate = 上月最后一天，与今日 cron 快照同样不同轴，混排早已存在于原始设计中。admin 只是把既有的不同轴放大（68 vs 1273），没有引入新的问题类别。
⑥ 查是否有派生计算把两轴混算——没有（columns.ts 无比率列）。

结论：代码行为清楚且数字全部复现，但**每个格子显示的值都等于其文档定义**，不存在"算错"。唯一可议的是要不要像品项板块那样补「截面」角标、或把 5 档改成按 endDate 历史重建（后者需承担 metrics.md:244-246 明言规避的性能代价）。这属于产品拍板项，不是实现缺陷 —— 因此不给 CONFIRMED；又因为原告没读错代码、数据也真实成立（P2 的定级理由"口径与文档不符"才是错的，实际是**完全相符**），也不宜给 REFUTED。故 UNCERTAIN，严重度从 P2 下调至 P3。
- **既有守护**：部分。fengyu-admin/src/actions/data-center/__tests__/consistency.customer.test.ts:367-389 只守护「customer_status 枚举字面量 = 沉睡/冰冻/休眠、禁 预警沉睡」，**不校验该查询有无日期条件**；__tests__/customer.test.ts:128-132/174-179 只用 mock 行断言字段映射（dormant/react_dormant…），同样不碰时间轴。即「截面 vs 区间不同轴」既没有被测试锁定为正确、也没有被测试标记为缺陷——改成按 endDate 历史重建不会有任何测试变红。
- **是否设计意图**：是，三重明载的设计意图：
1) notes/references/metrics.md:237-240 §3「会员状态与客活（截面快照 + 区间客活）」原文：「状态来自 client_wechat_users.customer_status（cronTask 每日 03:00 重算）……区分『截面』与『区间』：5 项状态人数为截面快照；2 项客活与 3 项激活为区间统计。」同段 :244-246 还写明为何**故意**不历史化：「本子页 5 档细分仍读 customer_status 列（因 5 档需要 total_visits 预聚合，cron 跑一次比每次请求都跑划算）；首页只要合并态 visits_90d≥1，适合实时聚合。两者口径同根、锚点不同。」——即项目已识别该列是快照（:180 明确写「该列由 cronTask 每日重算，是当前快照，无法反映历史日期」），并已为首页 retainedMemberCount 改掉，唯独 5 档细分**以性能为由显式保留**。
2) 代码注释三处自述：customer.ts:8「3. 会员状态与客活（截面 5 档 + 区间客活 2 档 + 本月激活 anchor 反推 3 档）」、:174「/** 5 档截面状态人数 */」、调用处 :965「// 5 档状态（截面，仅当期）」。并且 :968/:970/:972 给 withComparison 传 enabled=false（comparison.ts:41 → 只返回 value，不算同比环比），说明作者清楚这不是可比区间量。
3) 跨端一致：staffApi/routes/mgmt-traffic.js:246-262 同样直读 customer_status 列出 dormantWarn/dormantFrozen/dormantDeep，而 reactivatedFrom* 另用 anchor 反推。admin 是逐字移植（customer.ts:13-14 自述移植源）。
4) 变更记录 metrics.md:642（2026-05-26 用户拍板）措辞是「排名榜/**区间指标**统一走顶部 TimeRange」——按字面并未把截面指标纳入 TimeRange。
git log 佐证：queryStatusCount 自首个提交 a2b38e4f「feat(admin): 数据中心四板块取数 action」引入后从未被改动过（git log -S 仅命中该 commit）。
- **建议修法**：不改口径（改成按 endDate 历史重建 5 档要为每次请求重跑 total_visits 预聚合，正是 metrics.md:244-246 明确规避的代价）。最小成本做法：照抄 product-board.tsx:118-122 的既有范式，在 customer-board.tsx「会员状态与客活」分组标题下加一行说明——「沉睡 / 冰冻 / 休眠人数为截面快照（每日 03:00 重算），不随时间区间变化；激活三档为所选区间统计，两者不可直接相除」，并给 KPI_STATUS 的三个截面项加 hint；同时在明细表/导出的 dormant/frozen/deep 三列表头标注「截面」。若产品方坚持同轴，再另开单评估历史重建的性能方案。

<details><summary>验证 SQL</summary>

```sql
-- 截面（与时间筛选无关）
SELECT customer_status, COUNT(*) FROM client_wechat_users
WHERE bound_store_id IN (SELECT s.store_id FROM stores s JOIN org_nodes n ON s.org_node_id=n.id WHERE n.type='门店' AND n.is_active)
GROUP BY 1 ORDER BY 1;
-- 区间激活休眠（把两处日期换成任意区间即可复现不同轴）
WITH act AS (SELECT s.store_id FROM stores s JOIN org_nodes n ON s.org_node_id=n.id WHERE n.type='门店' AND n.is_active),
vip AS (SELECT DISTINCT so.client_user_id FROM service_orders so WHERE so.store_id IN (SELECT store_id FROM act) AND so.status='已完成' AND so.client_user_id IS NOT NULL AND so.service_date BETWEEN '2026-07-01' AND '2026-07-31'),
anc AS (SELECT c.user_id, MAX(so.service_date) last_dt,
  COUNT(*) FILTER (WHERE so.service_date BETWEEN ('2026-07-01'::date-1-INTERVAL '90 days')::date AND ('2026-07-01'::date-1)) v90
 FROM client_wechat_users c LEFT JOIN service_orders so ON so.client_user_id=c.user_id AND so.status='已完成' AND so.service_date<=('2026-07-01'::date-1)
 WHERE c.became_member_at IS NOT NULL AND c.became_member_at::date<=('2026-07-01'::date-1) GROUP BY 1)
SELECT COUNT(*) FILTER (WHERE a.last_dt IS NULL OR a.last_dt<('2026-07-01'::date-1-INTERVAL '12 months')::date) AS react_deep
FROM vip v JOIN anc a ON a.user_id=v.client_user_id JOIN client_wechat_users c ON c.user_id=v.client_user_id
WHERE a.v90=0 AND c.bound_store_id IN (SELECT store_id FROM act);
```

</details>

## A8. [P0][CONFIRMED] 人效 KPI「员工人均业绩」与「技师人均业绩」把同一笔钱按 role_type 重复求和，9 月整体虚高 30%

- 审计视角：人效板块　板块：efficiency　指标：empAvgRevenue（员工人均业绩）/ byMarket.techAvgRevenue（技师人均业绩）
- **断言**：Part A 的 qRevenueTotal 和 Part B 的 qRevenueByStore 直接 SUM(sale_payment_item_allocations.allocated_amount)。allocated_amount 是「某员工在某笔回款子项上的分成份额」，同一张 receipt 会按美容师/品项老师/养生师/推广部等多个 role_type 各分一份，单 receipt 的 allocation_ratio 合计常为 2.0 或 3.0。把它跨员工求和 = 同一笔钱算 2~3 次。该口径用作「人均业绩」的分子后，分子不再是门店业绩。metrics.md 第 430 行定义「人均业绩 = storeRevenue / employeeCount」，storeRevenue 即 sales.ts runStoreRevenue 的 SUM(spe.amount)；两者在同一站点上相差 30%。
- **规范依据**：notes/references/metrics.md:430 「| 人均业绩 日/月 | `storeRevenue.today / employeeCount.day` ; `storeRevenue.month / employeeCount.month` |」——分子是 storeRevenue（门店业绩），不是员工分摊份额之和。
- **代码证据**：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/efficiency.ts:141-152 `qRevenueTotal`：`SELECT COALESCE(SUM(spia.allocated_amount::numeric), 0) AS v FROM sale_payment_item_allocations spia JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id ...`（无 role_type 去重、无 receipt 层去重）；同一文件 :286-298 `qRevenueByStore` 同样写法；:800 `empAvgRevenue: mk(ratio(revenueTotal, technicianCount), 'amount')`；:864 `techAvgRevenue: ratio(m.revenue, m.technicianCount)`。对照 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/sales.ts:68-80 `runStoreRevenue`：`SELECT COALESCE(SUM(spe.amount::numeric), 0) ... AND spe.change_type IN ('首次支付','回款','退款')`。
- **数据证据（发现者）**：prod 只读库 2026-09-01~2026-09-21，全部在营门店：看板分子 SUM(spia.allocated_amount)=4,786,941.55；同期真实门店业绩 SUM(spe.amount)=3,672,217.98（= 销售板块「总业绩」同一 SQL），去重 receipt 金额 SUM(DISTINCT spir.amount)=3,680,919.90。多算 1,106,021.65（+30.1%）。成因实证：同期 1,123 张 receipt 的 allocation_ratio 合计 > 1（848 张恰为 2.00、124 张恰为 3.00），这些 receipt 上多分配出 1,276,068.42。技师数 150 → 看板「员工人均业绩」31,912.94，正确口径 24,481.45。分市场「技师人均业绩」偏差：自贡凤御 60,868.77 vs 44,979.49（+15,889.29/人）、南昌凤御 39,246.16 vs 28,869.58（+10,376.58/人）、九江凤御 24,735.74 vs 21,451.46（+3,284.28/人）、南昌易大师 4,771.61 vs 6,162.39（-1,390.78/人，反向偏低，因该市场有 receipt 未产生任何分配行）。
- **影响面**：9 月 KPI 卡「员工人均业绩」每人虚高 7,431.49 元（31,912.94 → 应为 24,481.45），全量虚增 110.6 万元；今年区间（2026-01-01~09-21）虚增 208.98 万元（9,569,742.92 vs 7,479,992.08，+27.9%）。「按市场人效」表 5 个市场的「技师人均业绩」全部失真，且偏差率从 -23%（南昌易大师）到 +36%（南昌凤御）不同向，市场间横向对比完全不可用。同一页的「门店排名榜-业绩」用的是正确的 spe 口径（3,672,217.98），与 KPI/按市场表相差 110 万，管理层两个 tab 对不上账。
- **验证员复算**：prod 只读库 fengyu_ro@118.178.196.26:5433，区间 2026-09-01~2026-09-21，带上代码真实的 activeStoreCondition 过滤后完全复现原告数字：

1) 同一 WHERE 子句下的「同筐对比」（排除了 scope/充值单/legacy 口径差异的干扰）：
   receipts=4332，去重后真实金额 SUM(receipt.amount)=3,680,919.90，看板分子 SUM(spia.allocated_amount)=4,786,941.55，虚高 +1,106,021.65（+30.05%）。
2) 成因逐张实证（按 receipt 聚合 allocation_ratio 合计的分布）：
   ratio=1.000 → 2089 张，alloc 1,890,609.87 ≈ receipt 1,890,609.57（正常）
   ratio=2.000 → 848 张，receipt 814,494.93 → alloc 1,628,989.88（恰好 ×2）
   ratio=3.000 → 124 张，receipt 119,417.00 → alloc 358,251.00（恰好 ×3）
   ratio>1 合计 1123 张，多算 1,276,068.42；
   反向：ratio=0 的 950 张 receipt（58,471.02）被完全漏计 → 偏差不同向、不可用统一系数校正。
3) 分母与 KPI：技师数（带 active store 过滤）=150，与原告一致。
   empAvgRevenue 看板值 = 4,786,941.55/150 = 31,912.94；按 metrics.md:428 口径（storeRevenue 3,672,217.98）应为 24,481.45，每人虚高 7,431.49（+30.4%）。
4) 同页自相矛盾：同一人效页「门店排名榜-业绩」走 spe.amount = 3,672,217.98，与 KPI 分子 4,786,941.55 相差 1,114,723.57。
5) 分市场 techAvgRevenue（看板 vs 去重）：南昌凤御 39,246.16 vs 28,915.51（市场多算 609,508.61）、自贡凤御 60,868.77 vs 45,274.86（+421,035.54）、九江凤御 24,735.74 vs 21,624.79（+93,328.50）、南昌易大师 4,771.61 vs 5,763.33（-17,851.00，反向偏低）、昭通凤御 0。偏差方向不一致 → 市场横向排序被改写。
6) 今年区间 2026-01-01~09-21：看板分子 9,569,742.92 vs storeRevenue 7,608,631.63，虚增 1,961,111.29（+25.8%）。（原告报 208.98 万，我算 196.11 万，差异来自他未套 active-store 过滤；量级与结论一致。）
7) 排除替代解释：全表 sale_order_performance_events 无任何 sale_payment_id 出现 >1 行（GROUP BY HAVING count>1 返回 0），所以 30% 不是 spe JOIN 扇出，确系跨 role_type 重复求和。
- **验证员理由**：我按「默认误报」立场找了五条证伪路径，全部没成立：

（a）怀疑原告拿两套不同 WHERE 硬比（efficiency 用 销售单/转换单、无 legacy/change_type 过滤；sales 用 +充值单+legacy+change_type）。→ 我改用同一套 WHERE 内部自比：同一批 4332 张 receipt，SUM(allocated_amount) 比 SUM(receipt.amount) 多 30.05%。口径差异被完全消掉，缺陷仍在。

（b）怀疑是 JOIN 扇出而非 role_type 重复。→ 验了 spe 对 sale_payment_id 唯一，排除。

（c）怀疑 ratio 合计 2.0/3.0 是脏数据（那样根因就在数据不在这段代码）。→ 读写入侧 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:634-651：校验是「按 (saleItemId, roleType) 分池，**池内** Σratio ≤ 1.0001」，即每个 role_type 各有一个独立的 100% 池，最多 3 个池。所以单 receipt 的 ratio 合计 = 所用 role_type 个数，2.0/3.0 是**写入侧明文允许并校验通过**的正常形态。结论反转：allocated_amount 按设计就是「角色归属额」而非钱，跨 role_type 求和必然不是钱。这条本想证伪，结果成了最强的坐实证据。

（d）怀疑是已拍板的设计意图。→ 同文件头注释 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/efficiency.ts:46-49 恰恰写反了方向：「⚠️ 所有 role_type 各算一份（用户拍板，不做角色去重）…故员工榜/明细表合计会大于门店实耗…**门店榜 / 全局大卡实耗（Part A/B）仍走 service_items 原口径，不受影响**」。即：作者明确知道角色重复会把合计吹大，并且**专门为「实耗」把 Part A/B 留在门店口径**；同样的保护没有施加到「业绩」的 Part A/B。头部那条「业绩(员工)=SUM(spia.allocated_amount)」红线的标题限定词是「(员工)」，指的是 Part D 员工榜按 employee_id 分组的场景，metrics.md:113 也只在「员工排行榜归属」表里这么定义——分组到人时它是对的，去掉 GROUP BY 跨人求和就不是。
git log -S / blame：该写法自 a2b38e4f(2026-05-26) 建板时就是 sale_allocations.total_amount，历次 commit（23405ddf 表改名、a5d64dcd 接 spe、1ce30dcc 明确只删了「收入」维度的 role_type 过滤、业绩维度保留）都没有为「全局合计用角色归属额」留下任何拍板记录；metrics.md「变更记录」章节（第 617 行起）与 2026-05-26 数据中心专属指标三条拍板（流量客业绩 / 单次客耗 / 店长人数）里都没有这一条。

（e）怀疑调用方/另一分支已兜底。→ 逐行读了 efficiency.ts:786-800（kpis 装配，revenueTotal 直接进 ratio）与 :838-866（byMarket 装配，revMap 直接累加），无任何除以角色数、无 DISTINCT receipt、无上游 CTE 去重。

反方唯一站得住的一点：如果把「员工人均业绩」理解成「全体产能员工各自归属业绩之和 ÷ 技师数」，这个数在内部是自洽的。但即便如此，它和同一页「门店排名榜-业绩」差 111 万、和销售板块「总业绩」差 30%，且 950 张零分配 receipt 使偏差在南昌易大师反向，横向对比失真——仍是会误导管理层的数字错误，不是单纯的口径分歧。故不降到 P2。
- **既有守护**：未被覆盖。fengyu-admin/src/actions/data-center/__tests__/consistency.efficiency.test.ts:65-72 只做正则字面量比对（`expect(adminBody).toMatch(/SUM\(\s*spia\.allocated_amount::numeric\s*\)/i)`），只防漂移、恰恰把当前写法钉死；fengyu-admin/src/actions/data-center/__tests__/efficiency.test.ts:160 是 mock db 的单测（`expect(res.kpis.empAvgRevenue.value).toBe(200) // 2000 / 10`），喂的是伪造标量，无法暴露跨 role_type 重复求和。fengyu-admin/src/lib/data-center/*.test.ts 只覆盖 time-range / scope-sql / format 等公共层，不碰本指标。全仓无任何对真实数据做「分子 ≤ 门店业绩」的数值守护。
- **是否设计意图**：否。同文件头注释 efficiency.ts:46-49 对「实耗」的同型问题明确做了相反处理（「门店榜 / 全局大卡实耗（Part A/B）仍走 service_items 原口径，不受影响」），说明作者拍板的是「员工级不做角色去重」，而非「全局大卡可以按角色重复求和」。metrics.md:428 明确 `人均业绩 = storeRevenue / employeeCount`，storeRevenue = SUM(spe.amount)；metrics.md:113 的 SUM(spia.allocated_amount) 只出现在「员工排行榜归属」表（按 employee_id 分组）。metrics.md 变更记录（第 617 行起）与 2026-05-26 数据中心三条拍板口径均无此项。staff 端对端 mgmt-dashboard.js:210-224 queryStoreRevenue 走的正是 SUM(spe.amount)，其前端 buildDisplay 的人均业绩分子是 storeRevenue —— 两端同名指标分子不同源。git log -S「业绩（员工归属，全局合计）」只回溯到建板 commit a2b38e4f，无口径拍板记录。
- **建议修法**：把 efficiency.ts:141-152 (qRevenueTotal) 与 :286-298 (qRevenueByStore) 的分子换成与销售板块 sales.ts:68-80 runStoreRevenue 同源的 `SUM(spe.amount)`（spe.store_id + status='已支付' + change_type IN ('首次支付','回款','退款') + sale_order_type IN ('销售单','转换单','充值单') + legacy_source IS DISTINCT FROM 'workfine' + performance_date BETWEEN），使 KPI「员工人均业绩」「技师人均业绩」与同页门店排名榜、销售板块总业绩三处对齐 metrics.md:428。若产品方坚持人效板块要看「员工归属业绩」，则须改指标名并在 metrics.md 登记该口径必然大于门店业绩（同 2026-09-03 实耗那条的写法），同时补一条「分子 ≤ 门店业绩」的数值守护，不能靠现有字面量 snapshot。注意修改要同步 consistency.efficiency.test.ts 的字面量断言。

<details><summary>验证 SQL</summary>

```sql
SELECT (SELECT COALESCE(SUM(a.allocated_amount::numeric),0) FROM sale_payment_item_allocations a JOIN sale_payment_item_receipts r ON r.id=a.sale_payment_item_receipt_id JOIN sale_items si ON si.sale_item_id=r.sale_item_id JOIN sale_orders so ON so.sale_order_id=si.sale_order_id JOIN sale_order_performance_events spe ON spe.sale_payment_id=r.sale_payment_id WHERE a.is_void=FALSE AND so.sale_order_type IN ('销售单','转换单') AND spe.status='已支付' AND spe.performance_date BETWEEN '2026-09-01' AND '2026-09-21') AS 看板分子, (SELECT COALESCE(SUM(spe.amount::numeric),0) FROM sale_order_performance_events spe WHERE spe.sale_order_type IN ('销售单','转换单','充值单') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.status='已支付' AND spe.change_type IN ('首次支付','回款','退款') AND spe.performance_date BETWEEN '2026-09-01' AND '2026-09-21') AS 销售板块总业绩;
```

</details>

## A9. [P2][UNCERTAIN] 员工排行榜 / 按技师人效明细的分子子查询完全没有 scope 过滤，门店视角会把该员工在别的门店做的业务算进来

- 审计视角：人效板块　板块：efficiency　指标：staffRankings.revenue / consume / projectCount / income、byStaff 全部金额列
- **断言**：Part D / Part E 的 6 个指标 CTE（revenue_by_emp、consume_by_emp、new_member_by_emp、project_by_emp、sales_comm/service_comm、revenue_by_emp_cat/consume_by_emp_cat/service_count_by_emp）都没有调用 scopeFilterSql，也没有 activeStoreCondition；scope 只作用在 producer_employees 员工池上。因此 UI 选「某门店」时，榜单里每个员工显示的是他在全集团所有门店的合计值，而不是在该门店的产出。这既让该门店的人效数字偏高，也让门店级账号（店长）看到了本不可见门店的经营金额（虽是按员工聚合的形式）。
- **规范依据**：notes/references/metrics.md:103 「**scope 走 JOIN 上游表**：`sale_allocations` / `service_commissions` 不直接持有 store_id，分别 JOIN `sale_items` → `sale_orders` / `service_items` → `service_orders` 拿 store_id 命中 scope 子查询。」——代码已经 JOIN 出了 so.store_id，却没有命中任何 scope 子查询。
- **代码证据**：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/efficiency.ts:533-544 `revenue_by_emp AS ( SELECT spia.employee_id, COALESCE(SUM(spia.allocated_amount::numeric), 0) AS v ... WHERE spia.is_void = FALSE AND so.sale_order_type IN ('销售单', '转换单') AND ${performanceEventDateBetween('spe', cur.start, cur.end)} GROUP BY spia.employee_id )` —— WHERE 子句里没有 `${scopeFilterSql(session, scope, 'so.store_id')}`；同文件 :557-568 `consume_by_emp`、:579-586 `new_member_by_emp`、:599-613 `project_by_emp`、:624-645 `sales_comm`/`service_comm`、:669-735 明细五个 CTE 同样缺失。scope 仅出现在 :526-527 `WHERE (pb.store_id IS NOT NULL AND ${scopeFilterSql(session, scope, 'pb.store_id')}) OR (pb.store_id IS NULL AND ${orgAnchorScopeSql(session, scope)})`。
- **数据证据（发现者）**：prod 只读库 2026-09-01~2026-09-21，仅统计有门店归属的在职员工：业绩方面 52,181.54 元 / 6 名员工来自「同市场的其它门店」（本店 3,298,679.56）；实耗方面 76,899.93 元 / 19 名员工来自同市场其它门店（本店 2,920,416.64）。跨市场部分对有门店员工为 0（跨市场的 1,071,595.34 元 / 27 人全部来自 store_id 为空的直挂员工，属 orgAnchorScopeSql 的既定行为，不计入本条）。
- **影响面**：选择单门店时，该店「员工排名榜-业绩」合计虚高约 5.2 万元（6 人受影响）、「员工排名榜-实耗」合计虚高约 7.7 万元（19 人受影响），「按技师人效」明细表同源同错。门店级账号因此能从榜单数值推知兄弟门店的经营量。市场级 / 集团级视角当期无金额偏差（跨市场部分全部落在直挂员工身上），但该缺陷不随数据变化而消失——只要出现跨市场外援就会放大。
- **验证员复算**：prod 只读库 fengyu_ro，窗口 2026-09-01~2026-09-21，按 producer_base 真实口径（emp_store = COALESCE(sw.store_id, ds.store_id)，hired/resigned 历史化）复算：
【实耗·员工榜】本店 2,920,416.64 元/140 人；同市场其它店 76,899.93 元/19 人；跨市场 6,055.09 元/1 人（原告漏了这 1 人，因其只按 sw.store_id 取数）；直挂无门店 1,014,006.86 元/26 人（store 视角本就不出现，market 视角由 orgAnchorScopeSql 兜底）。→ 单店视角实耗榜虚高合计 82,955.02 元 / 20 人。
【业绩·员工榜】本店 3,298,679.56 元/118 人；同市场其它店 52,181.54 元/6 人（提成额 5,839.31）；跨市场 0。与原告数字一致。
【逐店】9 个门店受影响，且 9 个全部存在门店级账号：九江长江店 榜 99,364.07 / 本店 78,669.56（+26.3%）、九江鸿蒙店 99,871.03 / 79,547.52、九江快乐店 50,884.03 / 35,948.17（+41.5%）、九江大润发 58,076.91 / 46,957.92、九江梦想店 156,196.65 / 149,339.15、南昌云暖店 9,218.69 / 3,163.60、九江联盛店 47,652.18 / 45,582.62、南昌蓝茉店 155,250.07 / 154,750.07、南昌九龙湖 63,144.00 / 62,744.00。
【最极端个人行】郭兰（九江快乐店）榜上实耗 13,939.86，本店实际 0.00（100% 来自外店）；王志军（南昌云暖店）6,055.09 / 0.00；金奇峰（九江长江店）40,232.64 / 19,538.13（2.06 倍）。
【权限面确认】permission_role_definitions 中 manager/finance/hr 均含 data_center:dashboard，且 permission_roles 里 manager@门店 = 70 条 / 60 人，门店级数据中心账号真实存在（不是只有总部/市场账号）。
【量级】对单店视角，实耗榜合计虚高约 2.8%、业绩榜约 1.6%；个别员工行可虚高 100%。
- **验证员理由**：四条证伪路径都走完了：
1）读错代码？没有。efficiency.ts:533/557/579/599/624/636/669/686/701/709/724 十处 CTE 确实只有 is_void / 单据类型 / 时间窗，无 scopeFilterSql，也无 activeStoreCondition；:522-528 的 scope 只管员工池；:883-935 装配段无后过滤。同文件 Part A/B/C（:151/:180/:296/:336/:345 等）则全部带 scopeFilterSql，说明作者确实分了两类处理。
2）数据不成立？不成立才怪——我独立复算，数字与原告吻合，还多挖出一个跨市场员工（王志军 6,055.09，因原告只按 sw.store_id 取数、漏了 store_id 为空但直挂门店节点的那 1 例档案）。
3）已被守护覆盖？没有。consistency.efficiency.test.ts 与 scope-sql.test.ts 只守「归属字段/公式/两端镜像」，对员工指标 CTE 是否带 scope 既无正向也无反向断言；给这 6 个 CTE 加 scope 不会让任何现有测试变红。
4）是否设计意图？这是本次裁决的关键，证据偏向「是」：
   · 移植源 staff mgmt-dashboard.js:982-1272 结构完全相同（storeFilter 只进 producerEmployeesCte），2026-04 上线至今 5 个月无异议，admin 文件头自述「移植源（照搬口径，禁止 import）」。
   · 原始拍板 ticket 2026-04-25-mgmt-staff-ranking-api.md:83「不接收 scopeType/scopeId：账号 staffLevel 决定可见员工」、:129「所有 6 个指标的 SQL 都先用 CTE 锁定『当前账号可见的产能员工』，再 LEFT JOIN 各指标聚合」——scope 的语义被明确定义为「筛人」，不是「筛事实行」。
   · metrics.md §员工排行榜归属（:105-118）逐指标列出归属字段/时间窗/筛选条件，六项无一含门店条件；原告引的 :103「scope 走 JOIN 上游表」属上一节「提成」（门店/市场级 salesCommissionIncome / serviceCommissionIncome），而那一节 admin 已照做（efficiency.ts:151/:180/:326/:345），引用错位。
   · metrics.md 变更记录 2026-08-08 条「门店/员工排行榜及范围下拉同步过滤 is_active」——员工榜那次扫描也是落在员工池上，作者考虑过员工榜并选择了池级过滤。
   · 2026-09-03 刻意放宽候选池纳入直挂无门店员工（品项老师/养生师），这批人的产出天然跨店跨市场（本次实测 1,014,006.86 元/26 人），原告自己承认这属「orgAnchorScopeSql 既定行为」——同一语义对有门店员工就判 bug，逻辑不自洽。
   · consistency.efficiency.test.ts 里那条 describe 标题「门店排行榜业绩 = 付款流水现金流（员工榜/提成口径保持独立）」也钉了「员工榜口径独立于门店榜」。
反向、支持原告的证据也真实存在，所以我不能给 REFUTED：admin 数据中心的 scope 是用户主动选择的业务维度（不只是权限天花板），选中单店时同页 KPI「员工人均业绩/人均实耗」的分子是门店过滤后的数（Part A 带 scopeFilterSql），而下方员工榜不是，同页两套口径；efficiency.ts 文件头把「员工榜合计>门店实耗」只归因于 role_type 不去重（实测约 +25%），完全没提跨店这一项，说明作者大概率没意识到这个来源；门店级账号（60 人）看到的数值里确实混入了本账号无权门店产生的金额（虽然对端门店身份不可辨识）。
结论：代码行为清楚且与两端镜像/原始 ticket 一致，数字在「员工个人产出」语义下自洽；争点是数据中心 scope 选门店时员工榜该显示「该员工个人总产出」还是「该员工在本店的产出」，这需要业务方拍板，不是可以单方面判定的实现缺陷。故裁 UNCERTAIN，严重度由 P1 降至 P2（口径待确认、数字自洽），不按 P1「特定条件下数字错」记。
- **既有守护**：否。/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/consistency.efficiency.test.ts 只做「公式/归属字段/两端字面镜像/producer_employees 三段兜底」断言（:100-240），对员工指标 CTE 是否带 scope 无任何正向或反向断言；/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/scope-sql.test.ts 只测 helper 自身；efficiency.test.ts 把 scopeFilterSql vi.mock 成空对象（:45）。因此无论加不加 scope，现有测试都是绿的——这一点是真空区。
- **是否设计意图**：大概率是（但未针对「跨店外援」场景显式拍板）。证据：/Users/nv/proj.xt.com/fengyu-wxapp/notes/tickets/archives/2026-04-25-mgmt-staff-ranking-api.md:83「不接收 scopeType/scopeId：账号 staffLevel 决定可见员工」、:129「所有 6 个指标的 SQL 都先用 CTE 锁定『当前账号可见的产能员工』，再 LEFT JOIN 各指标聚合」；/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:982-1272 移植源同构（storeFilter 只进 producerEmployeesCte）；/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md:105-118 员工榜 6 指标无门店条件；同文件变更记录 2026-08-08 条把员工榜的 is_active 过滤落在员工池；efficiency.ts:76-94 文件头自述「照搬口径」。反证：文件头把「员工榜>门店实耗」只归因 role_type 不去重（+25%），未登记跨店来源；admin 数据中心的 scope 是 UI 主动选择的维度，与 staff 端「权限即范围」的前提已不同。
- **建议修法**：先让产品对「数据中心选单店时，员工排名榜/按技师人效明细的数值＝该员工个人总产出 还是 该员工在本店的产出」拍一次板并写进 metrics.md §员工排行榜归属。若选「本店产出」：在 efficiency.ts 那 9 个 CTE 的 WHERE 补 ${scopeFilterSql(session, scope, 'so.store_id' / 'so2.store_id')}，并同步 staff mgmt-dashboard.js 的 6 个 staffRanking（跨端 snapshot 守护要求同改），同时给 consistency.efficiency.test.ts 补一条反漂移断言；注意副作用——直挂员工（实测 101 万元/26 人）在市场视角会因其产出落在他市场门店而缩水，需一并定义。若维持现状：把「员工榜数值为个人全域产出、与门店榜不可相加」写进 metrics.md 与前端列头 hint，并在文件头补登跨店这一虚高来源（当前只登记了 role_type 不去重 +25%）。

<details><summary>验证 SQL</summary>

```sql
WITH emp AS (SELECT sw.employee_id, sw.store_id AS emp_store FROM staff_wechat_users sw WHERE sw.store_id IS NOT NULL AND sw.hired_at IS NOT NULL AND sw.hired_at::date<='2026-09-21' AND (sw.resigned_at IS NULL OR sw.resigned_at::date>'2026-09-21')), c AS (SELECT sc.employee_id, so.store_id AS ostore, SUM(sit.unit_real_price::numeric*sit.session_used*sc.allocation_ratio) v FROM service_commissions sc JOIN service_items sit ON sit.service_item_id=sc.service_item_id JOIN service_orders so ON so.service_order_id=sit.service_order_id WHERE sc.is_void=FALSE AND so.status='已完成' AND so.service_date BETWEEN '2026-09-01' AND '2026-09-21' GROUP BY 1,2) SELECT (c.ostore<>e.emp_store) AS 跨门店, round(SUM(c.v),2), count(DISTINCT c.employee_id) FROM c JOIN emp e USING(employee_id) GROUP BY 1;
```

</details>

## A10. [P0][CONFIRMED] 品项板块明细表「新增人数」用内连接归店，漏掉 2/3 的品项进入顾客，同屏 KPI 与合计差 3 倍

- 审计视角：品项板块　板块：product　指标：新增人数（newCount）/ 新增客单价（newAvgTicket）/ 复购率（repurchaseRate）—— byMarket / byStore 明细表
- **断言**：KPI 卡的「品项进入人数」走 `FROM cohort c LEFT JOIN period_agg pa`（product.ts:262-266），把所有 entry_date 落区间的顾客全数计入；而 byMarket/byStore 明细表的同名列走 `FROM period_agg pa JOIN xinzeng x`（product.ts:444-451）内连接归店。凡「进入达标日的当日金额全部来自寄存单」的顾客，其 purchase_received=0 → 被 period_agg 的 `purchase_received > 0` 过滤掉 → 在明细表里整体消失。结果：同一屏上 KPI 写 2429 人，下面按市场/按门店表格的「新增人数」列合计只有 832 人（明细还有跨店重复计数，真实缺口更大）。连带 newAvgTicket（product.ts:509）与 repurchaseRate（product.ts:511）两个派生列分母被腰斩，明细行的客单价虚高约 2.9 倍、复购率虚高约 3 倍。metrics.md:827-828 明确 newCount=COUNT(DISTINCT xinzeng.client_user_id)、newRevenue=SUM(period_agg) WHERE client ∈ xinzeng（即 LEFT JOIN 语义），明细表的内连接写法与规范不符。
- **规范依据**：/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md:827-828 —「品项进入人数（newCount）per product_kind | `COUNT(DISTINCT xinzeng.client_user_id)` | CTE `xinzeng`」「进入业绩（newRevenue）per product_kind | `SUM(period_agg.day_received)` WHERE client ∈ xinzeng」；metrics.md:748 —「**品项进入（xinzeng/newEntry）** | entry_date 落在 `[startDate, endDate]` 内的顾客」；metrics.md:750 —「进入基线汇总三类订单（含寄存单），复购达标仅汇总销售单/转换单」。
- **代码证据**：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:444-451（明细，内连接）:
```sql
    new_store AS (
      SELECT pa.store_id,
             COUNT(DISTINCT pa.client_user_id) AS cnt,
             COALESCE(SUM(pa.day_received), 0) AS revenue
      FROM period_agg pa
      JOIN xinzeng x ON x.client_user_id = pa.client_user_id AND x.grp = pa.grp
      GROUP BY pa.store_id
    ),
```
对比 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:261-266（KPI，左连接）:
```sql
    SELECT
      COUNT(DISTINCT c.client_user_id) AS count,
      COALESCE(SUM(pa.day_received), 0) AS revenue
    FROM cohort c
    LEFT JOIN period_agg pa
      ON pa.client_user_id = c.client_user_id AND pa.grp = c.grp
```
过滤源头 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:228-231:
```sql
      FROM daily_agg
      WHERE purchase_date BETWEEN ${range.start} AND ${range.end}
        AND purchase_received > 0
```
- **数据证据（发现者）**：prod 只读库，threshold=1990（system_configs.new_member_threshold），scope=集团全部在营门店（40 家）：
· 今年 2026-01-01~2026-09-22：KPI 新增人数 = 2429；byStore 合计 = 832；缺口 1597。拆解：xinzeng (client,grp) 对 4029 条 / 去重顾客 2429 人，其中 **2034 人在期内没有任何 period_agg 行**（进入达标日 100% 由寄存单金额触发）。
· 本月 2026-09-01~2026-09-22：KPI 672 vs byStore 合计 280。
· 新增业绩两边完全相等（8,005,411.23），佐证缺口顾客业绩为 0、只丢人数。
· 派生列：newAvgTicket KPI = 8,005,411.23/2429 = 3,295.8；明细口径 = 8,005,411.23/832 = 9,621.9。repurchaseRate KPI = 275/2429 = 11.32%；明细口径 = 275/832 = 33.05%。
· 根因数据：寄存单 9709 单、total_amount 全为 0，但其 sale_items.received 走视图 residual 分支产生 38,542,939.89 元业绩事件（占全部 46,020,551.97 的 84%），performance_date 全部落在 2026-07~2026-09（WorkFine 存量导入）。
- **影响面**：今年视角 1597 名顾客（占 KPI 的 65.7%）在按市场/按门店明细里凭空消失；本月视角 392 名（58.3%）。明细表的「新增客单价」整体虚高 ~2.9 倍（3,295.8 → 9,621.9），「复购率」整体虚高 ~3 倍（11.32% → 33.05%）。运营按门店排名做考核时，寄存单存量多的门店被系统性低估。
- **验证员复算**：全部数字由我在 prod 只读库（118.178.196.26:5433 / fengyu_ro）按代码原样 CTE 逐句复算，threshold 取 system_configs.new_member_threshold = 1990（实查，非默认 1980），scope = 集团全部在营门店。

【集团 scope · 今年 2026-01-01~2026-09-22】
一次查询同时给出四个口径：
kpi_new=2429 | kpi_pairs(client,grp)=4029 | bystore_new_sum=832 | xz_with_pa_distinct=832 | new_revenue_detail=8005411.23 | kpi_repurchase=275 | bystore_repurchase_sum=275
- KPI（product.ts:262 `FROM cohort c LEFT JOIN period_agg pa`）新增人数 = 2429
- 明细（product.ts:444-451 `FROM period_agg pa JOIN xinzeng x`）各门店相加 = 832，缺口 1597（65.7%）
- 关键：bystore_new_sum(832) == xz_with_pa_distinct(832)，说明这 832 人**没有任何跨店重复计数**，缺口 1597 是纯粹的「整行消失」，不是归组语义差异
- 新增业绩两边完全相等（8,005,411.23），证明消失的 1597 人业绩恒为 0 → 只丢人数不丢钱，派生列分母被腰斩
- 派生列实算：newAvgTicket KPI = 8005411.23/2429 = 3295.77，明细口径 = 8005411.23/832 = 9622.13（虚高 2.92 倍）；repurchaseRate KPI = 275/2429 = 11.32%，明细口径 = 275/832 = 33.05%（虚高 2.92 倍）
- 复购人数两边均为 275、体验人数不受影响 —— 因为 fugou 要求 purchase_received≥threshold、tiyan 直接派生自 period_agg，两者成员必然有 period_agg 行。**缺陷精确地、且仅仅命中 newCount 这一列**

【集团 scope · 本月 2026-09-01~2026-09-22】
kpi_new=672 | detail_sum=280 | rev=1828129.03 —— 缺口 392（58.3%），与原告一致。

【单店 scope 复算（决定性证据，彻底排除「跨店重复」这个唯一已备案的解释）】
把 first_entry 的分组键加上 store_id（等价于 scope.type='store' 时 SQL 被收窄到单店）后逐店对拍，今年区间前 6 名：
南昌梦祥店 KPI 133 / 明细 31（业绩 272,699.54 → 客单价 2050.4 vs 8796.8）
九江梦想店 143 / 43；自贡富豪店 112 / 22；南昌蓝茉店 127 / 41；自贡南湖店 110 / 27；自贡双美店 106 / 27
即：选中单店时页面上只有一行明细，它和正上方 KPI 卡对同一个概念给出相差 4.3 倍的两个数。

【根因数据】
sale_orders 按类型：销售单 21592 单 / 82,520,210.77，寄存单 9709 单 / total_amount 全 0，转换单 418 单 / 911,716.32。
寄存单在 sale_item_performance_events 上的业绩事件全部落在 2026-07(20964 条 / 9,665,294.43)、2026-08(50331 条 / 22,288,495.69)、2026-09(14597 条 / 6,629,161.87)，合计 38,582,952 元，且 2026-09 仍在持续产生 —— 不是一次性存量，是活跃链路。
这批金额按 metrics.md:750 只进「进入基线」(day_received)、不进 purchase_received，于是 period_agg 的 `purchase_received > 0`（product.ts:229-231 / 412-414）把这些顾客整体滤掉。
- **验证员理由**：我按「默认是误报」的立场逐条找证伪路径，四条都走不通：

证伪尝试 1「原告漏看上游过滤 / 另有兜底」——读了 product.ts:180-290（KPI 路径）与 300-500（明细路径）全文。两处 daily_agg 完全同构（同样的 sale_item_performance_events → sale_items → sale_orders → product_skus → product_categories 链、同样的三类订单、同样的 status 排除、同样的 `performance_date <= range.end`、同样的 `HAVING SUM > 0`），scope 也都是 `scopeFilterSql(session, scope, 'so.store_id')`。差异只有最后一跳：KPI 是 `FROM cohort c LEFT JOIN period_agg pa`，明细是 `FROM period_agg pa JOIN xinzeng x`。调用方 getProductBoard(product.ts:592-660) 只是把 cycleByStore 的 Map 取出来填进 skeleton（`cyc?.newCount ?? 0`）再在 JS 里按 marketId 求和（product.ts:653），没有任何补偿。buildMetrics(product.ts:505-513) 直接用这个 newCount 当 newAvgTicket / repurchaseRate 的分母。证伪失败。

证伪尝试 2「这是跨店重复计数的已备案偏差，属业务接受」——这是唯一有备案的解释，但它预测「明细 ≥ KPI」。我实测 bystore_new_sum(832) 与 xz_with_pa_distinct(832) 完全相等，跨店重复贡献为 0，偏差方向完全相反。更强的是单店 scope 复算：把 first_entry 的分组键加上 store_id 即等价于 scope='store' 时的 SQL，此时跨店因素在定义上被消除，南昌梦祥店仍是 KPI 133 / 明细 31。证伪失败。

证伪尝试 3「派生列其实自洽，不算错」——部分成立但救不了主指标。per-store 的 newRevenue 与 newCount 确实都只覆盖「本店有真实购买的新增顾客」，avgTicket 在集合意义上自洽；但 (a) newCount 这一列本身就是给运营看的绝对人数，标签与 KPI 同名同义，133→31 就是错数；(b) repurchaseRate 的分子 repurchaseCount 实测 275 与 KPI 完全一致（fugou 成员必有 period_agg 行），分母却被腰斩，分子分母不同源，33.05% 这个数在任何口径下都不成立；(c) 明细走 exportView 'product-market'/'product-store' 导出，错数会落到线下考核表。证伪失败。

证伪尝试 4「已被守护 / 已被拍板」——consistency.product.test.ts 自述明细部分不在守护范围且 staff 端无对端；product.test.ts 整体 mock 掉 db.execute，SQL 从不执行；metrics.md、.42cog/、git log 均无该收窄的任何依据，反而函数 docstring 记录了一个被现实推翻的相反不变量。证伪失败。

补充定位（缩小结论边界，避免夸大）：缺陷只命中 newCount 一列及其两个派生列。trialCount 的 tiyan 直接派生自 period_agg，repurchaseCount 的 fugou 要求 purchase_received ≥ 1990（蕴含 > 0），两者成员必然存在于 period_agg，实测复购 275=275 印证。触发条件明确：顾客的「进入达标日」当日金额 100% 来自寄存单 → purchase_received=0 → 被 period_agg 滤掉；这在当前 prod 是主流而非边角（今年 2429 人中 1597 人、66%），且寄存单业绩事件 2026-09 仍在新增，不会随存量导入结束自愈。

定级说明：原告给 P0，我维持 P0 而非降到 P1。虽然触发条件可描述为「某类订单被错误排除」（形式上像 P1），但实际影响是整列失真（今年 -65.7%、本月 -58.3%，每一行门店都受影响）、两个派生列整体偏 2.9 倍、且与同屏 KPI 直接冲突，符合 P0 的「人数算错 / 整列失真」。
- **既有守护**：无任何守护覆盖，且现有两个测试从结构上不可能覆盖。
1. /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/consistency.product.test.ts —— 头注释自述「两端 ORM 不同 + admin 额外支持二级品项下钻 + byMarket/byStore 明细 → 完整 SQL snapshot 不可行」，守护策略是对 staff 端 mgmt-product.js 做 7 条关键字面量比对；而 staff 端**根本没有 byStore 明细**，new_store/new_group 这段 admin 独有代码在守护清单之外。
2. /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/product.test.ts —— `vi.mock('@/db')` 把 execute 换成「按 SQL 文本路由 canned 行」，SQL 从不真正执行。第 288 行 `expect(m.metrics.newAvgTicket).toBe(10000)` 用的是 fixture 直接喂的 new_count=3 / new_revenue=30000，只验 JS 侧除法，与 SQL 是否漏人无关。
3. fengyu-admin/src/lib/data-center/ 下的测试只覆盖 time-range/params/columns 等公共层，不碰 product 取数。
- **是否设计意图**：不是设计意图，反而有代码自证「与预期相反」。
1. 函数自己的 docstring（/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:341-347）白纸黑字写明预期不变量：「store_id 归组采用 period_agg.store_id（消费发生的门店）……**明细各门店人数相加 ≥ KPI 总量**（同顾客跨门店购买会在多店各计一次），与 sales 板块明细的归组语义一致（业务接受）」。业务接受的是「≥、因跨店重复而偏高」，实测是 832 < 2429、且 0 跨店重复 —— 方向和成因都与备案相反，属于写代码时未预见的场景。
2. metrics.md:827-828 给出的公式是 `newCount = COUNT(DISTINCT xinzeng.client_user_id)`、`newRevenue = SUM(period_agg.day_received) WHERE client ∈ xinzeng`（即 KPI 的 LEFT JOIN 语义）。metrics.md 全文（含 897 行起的数据中心专属章节、636/645 行的变更记录）对 byMarket/byStore 明细的 newCount 没有任何「收窄为本店实际消费者」的另案定义；910 行只说明细表不做同比环比。
3. git 侧无拍板痕迹：`git log -S "new_store" -- .../product.ts` 只有 a2b38e4f（初版）与 aeb6f805（「统一数据中心指标口径」，做的是 store_id→group_id 的重命名类改动），从未有提交把 LEFT JOIN 改成 INNER JOIN，也没有任何 commit message / 注释说明该列要与 KPI 脱钩。
4. .42cog/ 与 notes/ 全库 grep「明细各门店人数相加」「归店」「period_agg.store_id」零命中。
5. 同屏自相矛盾无法用口径解释：KPI 卡标签「品项进入人数」(product-board.tsx:22) 与明细列标签「新增人数」(columns.ts:99) 指向同一个 metric key `newCount`，单店 scope 下两者必须相等却相差 4.3 倍。
- **建议修法**：给 xinzeng 补一个门店归属维度再做明细聚合：qualifying_days(product.ts:396-399) 本来就带 store_id，据此建 `xinzeng_store AS (SELECT DISTINCT q.client_user_id, q.store_id, q.grp FROM qualifying_days q JOIN xinzeng x USING(client_user_id, grp) WHERE q.purchase_date = x.entry_date)`，把 new_store 改成 `FROM xinzeng_store xs LEFT JOIN period_agg pa ON pa.client_user_id=xs.client_user_id AND pa.grp=xs.grp AND pa.store_id=xs.store_id GROUP BY xs.store_id`，与 KPI 的 LEFT JOIN 语义对齐；同时 store_ids 要从 `period_agg ∪ xinzeng_store` 取并集，否则当期零真实消费的门店整行仍会漏。改完把「明细 newCount 相加 ≥ KPI newCount」「单店 scope 下明细 newCount == KPI newCount」写成断言补进 consistency.product.test.ts，并同步修正 product.ts:341-347 那段已被数据推翻的 docstring。若产品方反而认可「明细 = 本店实际消费的新增顾客」，则必须给该列换标签并在 metrics.md 立案，不能与 KPI 同名。

<details><summary>验证 SQL</summary>

```sql
WITH act AS (SELECT s.store_id FROM stores s JOIN org_nodes n ON s.org_node_id=n.id WHERE n.type='门店' AND n.is_active),
g AS (SELECT so.client_user_id, so.store_id, pc.product_kind grp, sipe.performance_date d,
        SUM(sipe.amount::numeric) dr,
        COALESCE(SUM(sipe.amount::numeric) FILTER (WHERE so.sale_order_type IN ('销售单','转换单')),0) pr
      FROM sale_item_performance_events sipe
      JOIN sale_items si ON si.sale_item_id=sipe.sale_item_id
      JOIN sale_orders so ON so.sale_order_id=si.sale_order_id
      JOIN product_skus sk ON sk.sku_id=si.sku_id
      JOIN product_categories pc ON pc.category_id=sk.category_id
      WHERE so.store_id IN (SELECT store_id FROM act)
        AND so.sale_order_type IN ('销售单','转换单','寄存单')
        AND so.status NOT IN ('已关闭','已作废','未审核','待审批','支付失败')
        AND so.client_user_id IS NOT NULL AND pc.product_kind IS NOT NULL
        AND sipe.performance_date <= DATE '2026-09-22'
      GROUP BY 1,2,3,4 HAVING SUM(sipe.amount::numeric)>0),
fe AS (SELECT client_user_id, grp, MIN(d) e FROM g WHERE dr>=1990 GROUP BY 1,2),
pa AS (SELECT * FROM g WHERE d BETWEEN DATE '2026-01-01' AND DATE '2026-09-22' AND pr>0),
xz AS (SELECT * FROM fe WHERE e BETWEEN DATE '2026-01-01' AND DATE '2026-09-22')
SELECT (SELECT count(DISTINCT client_user_id) FROM xz) AS kpi_new,
       (SELECT sum(c) FROM (SELECT pa.store_id, count(DISTINCT pa.client_user_id) c
                            FROM pa JOIN xz ON xz.client_user_id=pa.client_user_id AND xz.grp=pa.grp
                            GROUP BY 1) z) AS bystore_new_sum;
```

</details>

## A11. [P1][CONFIRMED] 新增业绩/复购业绩整组剔除退款负数冲销，今年虚高 86.6 万元（+12.1%）

- 审计视角：品项板块　板块：product　指标：新增业绩（newRevenue）、复购业绩（repurchaseRevenue）、新增客单价、复购客单价（KPI 与 byMarket/byStore 明细同源）
- **断言**：`period_agg` 的 `AND purchase_received > 0`（product.ts:230 与 414）+ `daily_agg` 的 `HAVING SUM(sipe.amount::numeric) > 0`（product.ts:209 与 393）联合导致：某 (顾客,门店,品项,日) 组的销售单/转换单净额为负（当日只有退款冲销事件，或退款的 performance_attribution_date 落在与原单不同的日期）时，整组被丢弃，而不是把负数计入本期业绩合计。退款按项目红线是「负数冲销不删行」，此处等于把冲销行整批吞掉，业绩只进不出。视图 sale_item_performance_events 确实带负数行（3973 行 / -2,178,139.59 元，其中 change_type='退款' 697 行 / -920,604.46 元），并非理论推断。
- **规范依据**：/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md:777 `HAVING SUM(sipe.amount::numeric) > 0`、metrics.md:795-797 `period_agg ... WHERE purchase_date BETWEEN $startDate AND $endDate AND purchase_received > 0` —— 实现与规范字面一致，但规范本身与「退款走 refund_cascade 负数冲销，不删行，任何 SUM 若没考虑负数行就会虚高」的全局红线冲突，需产品拍板哪一侧改。
- **代码证据**：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:205-231:
```sql
      GROUP BY so.client_user_id, so.store_id, ${groupCol}, sipe.performance_date
      HAVING SUM(sipe.amount::numeric) > 0
    ),
    ...
    period_agg AS (
      SELECT client_user_id, store_id, grp, purchase_date, purchase_received AS day_received
      FROM daily_agg
      WHERE purchase_date BETWEEN ${range.start} AND ${range.end}
        AND purchase_received > 0
    ),
```
同样两处在 byStore 查询：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:393 与 :414。
- **数据证据（发现者）**：prod 只读库，threshold=1990，集团在营 40 店，区间 2026-01-01~2026-09-22：
· 新增（xinzeng）cohort 的期内业绩：看板取数 = 8,005,411.23 元；同 cohort 含负数组的真实净额 = 7,139,621.12 元；**被丢弃的冲销额 = -865,790.11 元，虚高 12.13%**。
· 不限 cohort 的全量期内池：净额 7,437,599.98，看板口径 8,375,111.97，被丢弃 -937,511.99 元，涉及 324 个 (顾客,门店,品项,日) 组。
· 视图负数行总览：3973 行 / -2,178,139.59 元（首次支付 legacy residual -668,504.17、首次支付 receipt -567,423.91、退款 -920,604.46、回款 -18,074.05、储值卡抵扣 -3,533.00）。
- **影响面**：集团「新增业绩」KPI 今年虚高 865,790.11 元（+12.1%），同口径流向 byMarket/byStore 的「新增业绩」「复购业绩」「新增客单价」「复购客单价」四列。退款集中的门店虚高更多（324 个被丢弃组全部集中在有退款的门店）。
- **验证员复算**：全部数字由我本人在 prod 只读库（fengyu_ro@118.178.196.26:5433）跑出，区间 2026-01-01~2026-09-22，threshold=1990（实测 system_configs.new_member_threshold），scope=集团（复刻 scope-sql.ts 的 activeStoreCondition：org_nodes.type='门店' AND is_active）。

1) 逐字复刻 product.ts:184-267 的 CTE 链（看板口径）vs 同 cohort 不做 >0 丢弃（净额口径）：
   · 新增业绩 newRevenue：看板 8,005,411.23 / 净额 7,139,621.12 → 虚高 865,790.11 元（+12.13%）
   · 复购业绩 repurchaseRevenue：看板 4,347,229.89 / 净额 4,062,368.34 → 虚高 284,861.55 元（+7.01%）
   · 人数不变（newCount=2429、repurchaseCount=275），故派生客单价同步虚高：新增客单价 3,295.76→应为 2,939.57；复购客单价 15,808.11→应为 14,772.25。
   与原告报的 8,005,411.23 / 7,139,621.12 / -865,790.11 完全吻合，逐分不差。

2) 被丢弃的组（期内 NOT(dr>0 AND pr>0) 且 pr<0）：324 组，合计 -937,511.99 元，涉及 259 名顾客 / 35 家门店，单组最大 -31,839.60。另有 6,546 组 pr=0（纯寄存日，本就贡献 0，丢弃无害）、415 组 dr<=0 被 HAVING 挡在 daily_agg 外。

3) 决定性的「口径自相矛盾」证据 —— 同一批负数事件行按落点分裂成两种待遇：
   · 落在保留组（pr>0）：814 行 / -834,600.56 元，**真的被净入了业绩**
   · 落在丢弃组：3,154 行 / -1,341,939.03 元，**被整组吞掉**
   即退款按金额算只有约 38% 被净入。这说明现状不是「业绩不扣退款」的一致策略，而是「日净额碰巧为正就扣、为负就不扣」。

4) 门店级更严重（新增业绩 看板 vs 净额）：自贡贡井店 272,157.00 vs 208,701.00（+30.4%，虚高 63,456）、南昌梦时代 +30.1%、南昌江信店 457,568.07 vs 363,528.98（+25.9%，虚高 94,039.09）、南昌梦祥店 +24.2%、南昌象湖店 +22.7%。

5) 纯退款日失败样例（0 条正数事件，整日只有退款，整组被丢）：store-1779810635716 / 明星 / 2026-09-12 / -29,780.00；store-1780297766899 / 明星 / 2026-08-06 / -22,800.00。混合日样例：store-1779845104225 / 王牌 / 2026-09-20，含 50 条正数事件但日净 -31,839.60，正负一起被丢。

6) 视图负数行总览与原告一致：3,973 行 / -2,178,139.59（首次支付-legacy residual 1771/-668,504.17、首次支付-receipt 1314/-567,423.91、退款 697/-920,604.46、回款 189/-18,074.05、储值卡抵扣 2/-3,533.00）。

最小复跑 SQL（返回 board_kept / net_with_refunds / dropped / dropped_neg_groups）：
WITH act AS (SELECT s.store_id FROM stores s JOIN org_nodes n ON s.org_node_id=n.id WHERE n.type='门店' AND n.is_active),
g AS (SELECT so.client_user_id, so.store_id, pc.product_kind grp, sipe.performance_date d,
        SUM(sipe.amount::numeric) dr,
        COALESCE(SUM(sipe.amount::numeric) FILTER (WHERE so.sale_order_type IN ('销售单','转换单')),0) pr
      FROM sale_item_performance_events sipe
      JOIN sale_items si ON si.sale_item_id=sipe.sale_item_id
      JOIN sale_orders so ON so.sale_order_id=si.sale_order_id
      JOIN product_skus sk ON sk.sku_id=si.sku_id
      JOIN product_categories pc ON pc.category_id=sk.category_id
      WHERE so.store_id IN (SELECT store_id FROM act)
        AND so.sale_order_type IN ('销售单','转换单','寄存单')
        AND so.status NOT IN ('已关闭','已作废','未审核','待审批','支付失败')
        AND so.client_user_id IS NOT NULL AND pc.product_kind IS NOT NULL
        AND sipe.performance_date BETWEEN DATE '2026-01-01' AND DATE '2026-09-22'
      GROUP BY 1,2,3,4)
SELECT round(sum(pr) FILTER (WHERE dr>0 AND pr>0),2) board_kept, round(sum(pr),2) net_with_refunds,
       round(sum(pr) FILTER (WHERE NOT(dr>0 AND pr>0)),2) dropped,
       count(*) FILTER (WHERE NOT(dr>0 AND pr>0) AND pr<0) dropped_neg_groups FROM g;
- **验证员理由**：我按「默认是误报」的立场，逐条尝试证伪，五条路径全部失败：

1. 「原告读错代码 / 漏看上游过滤」→ 失败。我亲自读了 product.ts:184-270（KPI queryCycle）与 :368-499（queryCycleByStore），两处确认 `HAVING SUM(sipe.amount::numeric) > 0`（:209/:393）与 `AND purchase_received > 0`（:230/:414）原文存在；上游 WHERE 只排除 5 个坏状态与非三类订单类型，没有任何剔除负数事件的条件。视图定义（pg_get_viewdef）确认 receipt 分支与 legacy residual 分支都会产出负数 amount。KPI 出口 `FROM cohort c LEFT JOIN period_agg pa` 无扇出（sale_item_id/sku_id/category_id 均唯一），调用方 buildMetrics/getProductBoard 也没有任何兜底。

2. 「负数其实在别处被扣掉了」→ 失败。period_agg 是 newRevenue/repurchaseRevenue 的唯一来源（product.ts:263、:447、:455），byMarket 只是 JS 侧对 byStore 求和（:651-657），没有第二条补偿链路。

3. 「负数行根本不进这条链」→ 失败。实测 324 个期内组 pr<0，合计 -937,511.99，且其中确有 0 条正数事件的纯退款日（样例见 dataEvidence 第 5 条）。

4. 「这是已拍板的反直觉口径」→ 失败，详见 isDesignIntent。最致命的是自相矛盾：期内 814 行负数事件（-834,600.56）落在保留组里**确实被净入了业绩**，3,154 行（-1,341,939.03）落在丢弃组里被吞。没有任何业务规则能表述成「退款按金额 38% 计入、62% 不计入，取决于当日净额符号」。这一点把「这是故意的口径」这个最后的辩护也证伪了。

5. 「量级不足以误导」→ 失败。集团年度 +12.13%（86.6 万），门店级最高 +30.4%（自贡贡井店 6.35 万 / 南昌江信店 9.40 万）。且方向是**单向**的：pr=0 的组丢弃不影响数值，只有 pr<0 的组被丢，所以该 KPI 结构上只会偏高、永远不会偏低。

需要给原告做的两处订正（不影响结论）：
· 原告写「四列受影响」正确，但要明确**人数列不受影响** —— threshold=1990 > 0，HAVING 的 >0 对 qualifying_days 是冗余条件，newCount/repurchaseCount 实测两种口径下一致（2429 / 275）。受影响的只有 newRevenue / repurchaseRevenue 及其派生的两个客单价。
· 原告把负数统称「退款冲销」略粗：324 个丢弃组里的负数事件按 change_type 拆是 退款 -349,008.11、首次支付(legacy residual) -293,609.70、首次支付(receipt) -292,587.71、回款 -13,082.47 —— 后两类是 refund_cascade 写负数 receipt / 压低 si.received 的产物，实质仍是退款冲销，但如果按 `change_type='退款'` 去核对会对不上账。

结论：代码行为、口径出处、数据量级三者都已确证，且「哪个口径才对」在本项目内部已有明确成文答案（metrics.md:338-339 的不 clamp 原则 + :749 的退款逐笔入账），不需要再拍板，故判 CONFIRMED 而非 UNCERTAIN。维持原告的 P1：它不是随机乱数，而是「某类事件被错误排除」导致的系统性单向偏高。
- **既有守护**：被「漂移守护」覆盖，但没有任何守护能发现这个错。
· /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/consistency.product.test.ts:167 用正则 `/period_agg\s+AS\s*\([\s\S]*?purchase_received\s+AS\s+day_received[\s\S]*?purchase_received\s*>\s*0/` 把 `> 0` 字面量钉死；
· /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/__tests__/routes/mgmt-product.test.js:395 是同一条正则的 staff 副本。
这两条只比对源码文本，不跑数据、不做数值断言 —— 反而意味着**修这个 bug 必须同步改这两个测试**，否则改一端就红。
· `HAVING SUM(sipe.amount::numeric) > 0`（product.ts:209/393）**完全没有守护**，consistency.product.test.ts 里搜不到任何 HAVING 断言。
· /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/ 下与 product.test.ts 里也没有任何构造负数 sipe 行的用例。
- **是否设计意图**：否 —— 查不到任何把「净退款日整组剔除」拍板为意图的记录，反而查到三条反向证据。
① git 考古：`purchase_received` 这一列连同 `AND purchase_received > 0` 是 2026-08-17 的 546eb644（staff）/ d8f38bd9（admin）在**同一次提交里为「把寄存单加进 daily_agg 但不让寄存金额计入区间业绩」**而引入的（同一 diff 把 `so.sale_order_type IN ('销售单','转换单')` 改成加 '寄存单'，并新增 repurchase_qualifying_days）。它要排除的是 pr=0 的纯寄存日，不是负数。
② 并行谱系 aeb6f805（同为 HEAD 祖先，2026-08-18）在同一位置用的是 `BOOL_OR(sipe.amount::numeric > 0) AS has_purchase` + `WHERE pa.has_purchase`，语义同样是「这天算不算购买日」。两条谱系的意图一致地指向「排除非购买日」，都没有「不扣退款」的表述；HEAD 的版本是 60b64e3c 这次 merge 选中了 d8f38bd9 那一侧的结果。
③ 文档反向证据：metrics.md:636 的 2026-04-25「5 决策点已全部拍板」列的是「复购业绩=**客群全期收入**」，无一字提剔除退款；metrics.md:749 明写「回款/**退款已逐笔入账**」；metrics.md:338-339 对同属数据中心的客量板块明确「含退款负行…**不做 clamp**（clamp 会掩盖退款净流出，且与组织业绩失去可对账性）」。metrics.md:777/797 只是把实现 SQL 逐字誊抄进文档，没有给出任何「>0 是为了剔除退款」的理由说明。
补充：#137（2026-09-14）把时间轴从 `SUM(si.received)` 切到逐笔 `sipe.amount` 事件后，退款才变成带独立归属日的负数行，`>0` 的副作用才被放大到今天这个量级，而那次切换（metrics.md:644）通篇只谈时间轴，没有回头复核这个符号条件。
- **建议修法**：把两个符号条件从「排除非正」改成「排除零」即可，语义（剔除纯寄存日）不变、不再吞负数：product.ts:209/:393 的 `HAVING SUM(sipe.amount::numeric) > 0` → `<> 0`，:230/:414 的 `AND purchase_received > 0` → `AND purchase_received <> 0`；按项目禁跨端共享的规矩，必须同步 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js:284 及其 HAVING，并同轮改掉 consistency.product.test.ts:167 与 mgmt-product.test.js:395 两条字面量快照、订正 metrics.md:777/797，否则守护会红。若产品方反过来坚持「业绩只算购买日、不扣退款」，那最低限度要把该 KPI 改名（如「新增购买额」）并在 metrics.md 注明它与销售板块业绩不可对账 —— 但当前实现连这个口径都不成立（38% 的退款已经被净入），无论哪一侧拍板都必须改代码。

<details><summary>验证 SQL</summary>

```sql
WITH act AS (SELECT s.store_id FROM stores s JOIN org_nodes n ON s.org_node_id=n.id WHERE n.type='门店' AND n.is_active),
g AS (SELECT so.client_user_id, so.store_id, pc.product_kind grp, sipe.performance_date d,
        SUM(sipe.amount::numeric) dr,
        COALESCE(SUM(sipe.amount::numeric) FILTER (WHERE so.sale_order_type IN ('销售单','转换单')),0) pr
      FROM sale_item_performance_events sipe
      JOIN sale_items si ON si.sale_item_id=sipe.sale_item_id
      JOIN sale_orders so ON so.sale_order_id=si.sale_order_id
      JOIN product_skus sk ON sk.sku_id=si.sku_id
      JOIN product_categories pc ON pc.category_id=sk.category_id
      WHERE so.store_id IN (SELECT store_id FROM act)
        AND so.sale_order_type IN ('销售单','转换单','寄存单')
        AND so.status NOT IN ('已关闭','已作废','未审核','待审批','支付失败')
        AND so.client_user_id IS NOT NULL AND pc.product_kind IS NOT NULL
        AND sipe.performance_date BETWEEN DATE '2026-01-01' AND DATE '2026-09-22'
      GROUP BY 1,2,3,4)
SELECT round(sum(pr) FILTER (WHERE dr>0 AND pr>0),2) AS board_kept,
       round(sum(pr),2)                              AS net_with_refunds,
       round(sum(pr) FILTER (WHERE NOT(dr>0 AND pr>0)),2) AS dropped,
       count(*) FILTER (WHERE NOT(dr>0 AND pr>0) AND pr<0) AS dropped_neg_groups
FROM g;
```

</details>

## A12. [P1][CONFIRMED] 持卡占比分子分母不同源，KPI 恒显示 253%、单店高达 2600%

- 审计视角：品项板块　板块：product　指标：持卡占比（cardHolderRate）—— KPI 卡与 byMarket/byStore 明细同名列
- **断言**：分子 queryCardHolders 数的是「在本店下过含 paid_sessions>0 子项订单的 DISTINCT so.client_user_id」（全部下单顾客），分母 queryMemberCount 数的是「client_wechat_users.became_member_at IS NOT NULL」（已成为会员的顾客），两者不是同一个人群，分子完全不是分母的子集，比值必然突破 100%，作为「占比」展示（format.ts formatPercent 会再乘 100）毫无意义。明细行更严重：分子按 so.store_id（下单门店）归组、分母按 c.bound_store_id（绑定门店）归组，两把尺子。byMarket 还把各店分子直接相加（product.ts:651，跨店持卡顾客重复计数），分母却是天然去重的绑定门店会员数，进一步放大。
- **规范依据**：/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md:731-732 —「持卡人数（cardHolderCount）per product_kind | `COUNT(DISTINCT so.client_user_id)` ... ∩ scope（`so.store_id`）」「占比（cardHolderRate）per product_kind | `cardHolderCount / memberCount × 100%`」；分母定义见 metrics.md:727 —「分母『总会员人数』同 `memberCount`（`client_wechat_users.became_member_at IS NOT NULL` ∩ scope by `bound_store_id`）」。实现与文档字面一致，问题出在文档口径本身。
- **代码证据**：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:559-562:
```ts
    const cardHolderRate: KpiCell = {
      value: safeDiv(cardHoldersTotal, memberCountTotal),
      unit: 'percent',
    }
```
分子 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:131-135 `SELECT COUNT(DISTINCT so.client_user_id) AS v FROM sale_items si JOIN sale_orders so ...`
分母 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:150-155 `SELECT COUNT(*) AS v FROM client_wechat_users c WHERE ${sc} AND c.became_member_at IS NOT NULL`
明细派生 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:505 `cardHolderRate: safeDiv(agg.cardHolders, memberCount),`
市场层裸加 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:651 `m.agg.cardHolders += s.agg.cardHolders`
- **数据证据（发现者）**：prod 只读库，scope=集团（40 家在营门店）：持卡人数 = 4804，会员数（became_member_at IS NOT NULL ∩ bound_store 在营）= 1897 → 持卡占比 = **253.24%**。拆解 4804 名持卡人：1882 人是会员、**2922 人 became_member_at IS NULL（根本不在分母人群里）**、0 人不在 client_wechat_users 表中。门店层更极端：南昌春天店 52/2 = 2600.0%、南昌凯旋店 45/2 = 2250.0%、南昌恒茂店 152/12 = 1266.7%、南昌太一店 39/4 = 975.0%、自贡南湖店 187/28 = 667.9%。另：KPI 分子去重后 4804，按门店相加为 4811（7 人跨店重复），市场行再叠加这层重复。
- **影响面**：品项看板首屏「持卡情况」区两张卡之一恒为三位数百分比；40 家在营门店里至少 8 家显示 500%~2600%。任何按「持卡渗透率」做的门店对比都不成立——排名实质由『非会员下单顾客占比』驱动，而非持卡渗透。
- **验证员复算**：prod 只读库（118.178.196.26:5433，fengyu_ro），scope=集团（40 家 is_active 门店，与 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/scope-sql.ts:31-39 的 activeStoreCondition 同条件）：

【KPI 卡】分子 queryCardHolders = 4804，分母 queryMemberCount = 1897 → cardHolderRate = 2.5324 → formatPercent（format.ts:33-36 乘 100）显示 **253.24%**。原告数字逐位复现。

【分子完全不是分母的子集】4804 名"持卡人"按 customer_type 拆解：流量客 2004 / 会员客 1882 / 小美客 596 / 体验客 322。became_member_at IS NULL 的有 **2922 人（60.8%）**，一个都不在分母人群里；0 人不在 client_wechat_users 表中。
排除"分母是回填漏洞"这一辩护：SELECT count(*) FILTER (WHERE customer_type='会员客' AND became_member_at IS NULL)=0，FILTER (WHERE customer_type<>'会员客' AND became_member_at IS NOT NULL)=0 —— 两个方向都 0 偏差，分母就是真·会员客人群（全库 5276 个 client_wechat_users 里仅 1898 个会员）。

【分子 ≈ 全部下单顾客】同一 WHERE 去掉 paid_sessions>0 后 all_buyers = 4806，加上 paid_sessions>0 = 4804 → 该条件只筛掉 2 个人（0.04%）。所谓"持卡人数"实质就是"在本店下过已支付单的顾客总数"。

【口径漂移量化】同一 scope 下四种口径的分子：
- 2026-04-25 拍板原口径（product_type='疗程卡' ∩ remaining_sessions>0 ∩ 销售单/转换单）= **1169** → 61.6%（<100%，合理）
- "已付未用>0"（GREATEST(paid_sessions-(session_count-remaining_sessions),0)>0，即 MEMORY project_treatment_card_remaining_caliber 的展示口径）= 4130 → 217.7%
- remaining_sessions>0（任意 product_type）= 4135
- 现行 paid_sessions>0 = **4804** → 253.24%

【门店层】按 so.store_id 分子 / bound_store_id 分母：南昌春天店 52/2=2600.0%、南昌凯旋店 45/2=2250.0%、南昌恒茂店 152/12=1266.7%、南昌太一店 39/4=975.0%、南昌梦时代 81/9=900.0%、自贡南湖店 187/28=667.9%、自贡富豪店 168/33=509.1%、自贡吉祥店 111/22=504.5%、九江丽都店 94/20=470.0%…… 40 家在营门店里 ≥8 家落在 500%~2600%。
【市场层（product.ts:651 裸加）】南昌易大师 231/20=1155.0%、自贡凤御 1006/292=344.5%、九江凤御 757/335=226.0%、南昌凤御 2817/1250=225.4%。

【原告归因中被我修正的一点】原告把明细行的失真部分归给"so.store_id vs c.bound_store_id 两把尺子"和"byMarket 裸加跨店重复"。实测这两项都是噪声级：(store,uid) 组合共 4811 对，其中会员对 1886、且绑定门店==下单门店的 1875 —— 归属轴只差 11 对；跨店重复只有 4811-4804=7 人。南昌春天店 52 个持卡人全部 bound 在本店，只是其中仅 2 人是会员客。**唯一主因是会员/非会员两个人群不同源。**

【致命佐证】若把分子收成"绑定本店且为会员客的持卡人"（与分母同源），全集团 1875/1897 = **98.8%** —— 会员几乎人人持卡、门店之间几乎无差异。也就是说现行「持卡占比」列在门店间的全部差异（2600% vs 200%）**100% 由"非会员下单顾客 ÷ 会员数"驱动，与持卡渗透率无关**，按它做门店排名会得到完全相反的结论（春天店 2600% 排第一，其真实会员持卡渗透只有 2 个会员的样本）。
- **验证员理由**：我按"默认误报"立场逐条找辩护点，五条全部被数据推翻：

1. 「原告漏看上游过滤」——读 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:75-95 resolveGrouping，默认分支 filter 只是 `pc.product_kind IS NOT NULL`，不收窄任何人群；queryCardHolders(product.ts:127-147) / queryMemberCount(product.ts:149-159) 两条 SQL 之间没有任何共同 CTE 或后置交集。调用方 product.ts:559-563 与 buildMetrics(product.ts:502-513) 也只是 safeDiv 直除，无封顶、无 clamp。scope 两侧都走 scopeFilterSql（分子 so.store_id、分母 c.bound_store_id），无越权，但也无共同人群。**原告没读错。**

2. 「分母是数据回填缺口，不是口径问题」——查 customer_type 与 became_member_at 双向一致性，两边都是 0 偏差，MEMORY 里 backfill-became-member-at 的自检结论在 prod 仍成立。分母是干净的，只是天然只有 1897 人。**辩护失败。**

3. 「>100% 是早就接受的设计」——回溯 git，找到 83eaa9fa（2026-07-22）把分子从 remaining_sessions>0 换成 paid_sessions>0。用 prod 数据回算原口径 = 1169 → 61.6%。也就是说这块卡在 2026-04-25 拍板时是个正常百分比，是 7 月那次"三端同步"把它推过 100% 的，且该 commit 只字未提分母/占比。**辩护失败。**

4. 「也许 paid_sessions>0 才是正确的持卡定义，只是数值大」——对照 MEMORY project_treatment_card_remaining_caliber（疗程卡展示口径 = 已付未用 = GREATEST(paid_sessions-(session_count-remaining_sessions),0)）与 product-board.tsx:17-18 的 hint 文案，两处"持卡"的业务语义都是"手上还有没用完的次数"。实测 paid_sessions>0 = 4804 而 all_buyers = 4806，该条件只排除 2 人 —— 它根本不表达"持卡"，就是"下过单"。**辩护失败，且顺带坐实 UI 提示文案与 SQL 不符。**

5. 「明细失真主因是 store_id/bound_store_id 两把尺子 + byMarket 裸加，也许两轴互相抵消或幅度很小」——这是唯一我替被告找到的点，但方向是削弱原告归因、不救结论：归属轴只差 11 个 (store,uid) 对，跨店重复只有 7 人，南昌春天店 52 人全部 bound 在本店。主因单一，就是会员/非会员不同源。我据此修正了原告的归因描述，但结论不变。

最后做了一次"如果口径一致会怎样"的反算：同源交集 1875 / 分母 1897 = 98.8%，各店几乎无差异 —— 证明现行列的全部店间方差都来自非会员数量，用它排名会给出与"持卡渗透率"相反的结论。这已不是"数字自洽只是口径待定"，而是一张首屏 KPI 卡 + 明细表整列在 100% 的时间里输出无业务含义的三位数百分比，且卡片 hint 对自己的分子做了虚假描述。故判 CONFIRMED。

定级：不给 P0 —— 没有金额算错、没有 JOIN 扇出、没有越权、没有时间轴错位，每个数字都严格等于写明的公式。不给 P2 —— 代码与文档字面一致，不存在"实现偏离文档"。给 P1：品项看板首屏两张卡之一恒为三位数，明细表 cardHolderRate 列对 40 家门店全部失真，属于"某类顾客被错误纳入分子"。修哪个分母需要产品拍板，但"标 占比、走 formatPercent、却恒 >100%"和"hint 写未用完疗程卡、SQL 却不看 remaining"这两点无需拍板即为缺陷。
- **既有守护**：没有守护，而且既有守护的 mock 正好把问题遮住了。
- /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/consistency.product.test.ts:202-207 只做字面量比对（"admin/staff 会员数用 became_member_at IS NOT NULL"），即跨端一致性守护，不校验数值合理性。
- /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/product.test.ts:206-214 的 mock 是 `scalarCard={v:10}` / `scalarMember={v:40}` → 断言 cardHolderRate≈0.25。夹具刻意让分子 < 分母，把真实世界里分子是分母 2.5 倍的反转彻底测不出来；product.test.ts:312 只覆盖 memberCount=0 → null。
- /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/format.ts 无 percent 上界校验（formatPercent 对 25.0 会老老实实打印 2500.00%）。
- staff 端 fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js:167-171 同一公式（rate=count/memberCount*100），同样无守护；差别是 staff 只出 per-kind 行（实测最高 招牌 3134/1897=165.2%），admin 的 KPI 卡是跨 kind DISTINCT 汇总（4804），所以 admin 这张卡是全系统最夸张的一个。
- **是否设计意图**：部分是、但关键的一跳不是。
- 2026-04-25 确实"拍板"过（/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md:636 "5 决策点已全部拍板：持卡=截面快照"；ticket /Users/nv/proj.xt.com/fengyu-wxapp/notes/tickets/archives/2026-04-25-mgmt-product-cycle-page.md:122-123），但当时的分子是 `product_type IN ('疗程卡','单品') ∩ remaining_sessions>0`，实测 = 1169 → **61.6%，是个正常百分比**。
- 分子在 2026-07-22 被 commit 83eaa9fa `fix(metrics): 持卡人数口径改为 paid_sessions>0（三端同步）` 单方面换掉（去掉 product_type、去掉 remaining、并把寄存单纳入），commit body 只讲"三端同步 + snapshot 同步"，**全文未提分母、未提占比、未提 >100%**；metrics.md 的变更记录行也只是就地改写了 2026-04-25 那条（git show 83eaa9fa -- notes/references/metrics.md 可见），没有新增决策记录。分母 memberCount 自始至终没人动过。
- 所以"实现 == 文档"成立（metrics.md:726/731/732/870 与 product.ts 字面一致），但"253%/2600% 是想要的"**没有任何拍板证据**。
- 反向铁证（不依赖业务拍板即可判错）：UI 提示文案至今写的是旧口径 —— /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/app/(main)/(analytics)/data-center/_components/product/product-board.tsx:17-18 `{ key: "cardHolders", label: "持卡人数", hint: "以当前时刻未用完疗程卡为准，不随时间区间变化" }` / `{ key: "cardHolderRate", label: "持卡占比", hint: "持卡人数 ÷ 会员数（以当前时刻未用完疗程卡为准）" }`。而现行 SQL 既不看 remaining、也不看 product_type，4804 人里含已用光的卡和家居产品行。提示文案与 SQL 不是同一件事，这一条无需产品拍板就是错的。
- 另查：.42cog/ 下无相关口径条款（只有 backend.pr.spec.md:191 写"次数维度持卡人数显式纳入寄存单"）；MEMORY 无 持卡占比/cardHolderRate 条目；gh issue 全量搜索"持卡"无对应单。
- commit 83eaa9fa 已是 origin/main 祖先 → **已上线生产**。
- **建议修法**：两步：(1) 立即修可无争议的部分 —— 把分子与分母拉回同源，即 cardHolderRate 改成「本店会员中持卡者 ÷ 本店会员数」（分子加 `JOIN client_wechat_users c ON c.user_id=so.client_user_id AND c.became_member_at IS NOT NULL AND c.bound_store_id = so.store_id`，同时 byMarket 的 cardHolders 不能再裸加、需改成按市场重新 DISTINCT），并同步修正 product-board.tsx:17-18 已失效的 hint 文案（现行 SQL 既不看 remaining 也不看 product_type）。(2) 需产品拍板的部分 —— "持卡"到底取 paid_sessions>0（曾买过）还是 已付未用>0（当前手上有次数，实测 4130 人，与 MEMORY project_treatment_card_remaining_caliber 的展示口径一致）；拍板后必须三端同步（product.ts / mgmt-product.js / metrics.md:726,731-732,870）并跑 consistency.product.test.ts，同时把 product.test.ts 的夹具从 10/40 改成会触发 >100% 的组合，避免再次被 mock 遮蔽。

<details><summary>验证 SQL</summary>

```sql
WITH act AS (SELECT s.store_id FROM stores s JOIN org_nodes n ON s.org_node_id=n.id WHERE n.type='门店' AND n.is_active),
ch AS (SELECT DISTINCT so.client_user_id uid
       FROM sale_items si JOIN sale_orders so ON so.sale_order_id=si.sale_order_id
       JOIN product_skus sk ON sk.sku_id=si.sku_id
       JOIN product_categories pc ON pc.category_id=sk.category_id
       WHERE so.store_id IN (SELECT store_id FROM act) AND si.paid_sessions>0
         AND so.sale_order_type IN ('销售单','转换单','寄存单') AND so.status='已支付'
         AND so.client_user_id IS NOT NULL AND pc.product_kind IS NOT NULL)
SELECT (SELECT count(*) FROM ch) AS cardholders,
       (SELECT count(*) FROM client_wechat_users c
         WHERE c.bound_store_id IN (SELECT store_id FROM act) AND c.became_member_at IS NOT NULL) AS members,
       (SELECT count(*) FROM ch JOIN client_wechat_users c ON c.user_id=ch.uid
         WHERE c.became_member_at IS NULL) AS cardholders_not_member;
```

</details>

## A13. [P2][CONFIRMED] 环比基期与当期长度不等：本周/本月的「环比」拿残缺当期比完整上期，所有 KPI 卡片系统性失真

- 审计视角：时间轴与范围闸门　板块：公共层　指标：全部走 withComparison 的 KPI 的「环比」徽章（销售 8 项 / 客量 ~15 项 / 品项 5 项）
- **断言**：preset=week 时 current=[本周一, 今天]（今天是周二就只有 2 天），previous 却是完整上周 7 天；preset=month（默认档）时 current=[月初, 今天]（今天 22 号就 22 天），previous 是完整上月 31 天。deltaPct 直接拿两个长度不等的区间相除，于是每个 KPI 的环比都被月初/周初的天数差系统性压低，用户看到的红色跌幅是日历假象不是经营变化。
- **规范依据**：notes/references/metrics.md:918-919「**同比/环比**：仅 KPI 卡片标量计算（本期/上期/去年同期 delta%）」——文档只登记了「上期」概念，未定义上期是否等长；metrics.md 全文没有「环比基期取完整上月」的口径登记。time-range.ts:11-12 的文件头注释是唯一出处，属实现自述而非拍板口径。
- **代码证据**：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/time-range.ts:106-116
```ts
} else if (input.preset === 'week') {
  const monday = startOfWeekMonday(today)
  current = { start: monday, end: today }          // 本周一~今天（可能只有 1~2 天）
  previous = { start: addDays(monday, -7), end: addDays(monday, -1) }  // 完整上周 7 天
} else if (input.preset === 'month') {
  const first = startOfMonth(today)
  const lastMonthAnyDay = addDays(first, -1)
  current = { start: first, end: today }           // 月初~今天
  previous = { start: startOfMonth(lastMonthAnyDay), end: endOfMonth(lastMonthAnyDay) } // 完整上月
```
消费方：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/comparison.ts:48-56（runner 对 previous 原样重跑）；/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/sales.ts:220-227、customer.ts:961-1000、product.ts:551-555 全部 withComparison。
- **数据证据（发现者）**：prod 只读库 2026-09-22 实跑「业绩」（spe 口径，全集团在营门店）：
· 本月当期 09-01~09-22（22 天）= 3,672,217.98；代码基期 08-01~08-31（31 天）= 3,452,804.49 → 看板显示环比 +6.35%；等长基期 08-01~08-22（22 天）= 2,808,430.45 → 真实环比 +30.75%。差 24.4 个百分点。
· 本周当期 09-21~09-22（2 天，09-22 为周二）= 199,786.00；代码基期 09-14~09-20（7 天）= 1,309,920.91 → 看板显示环比 -84.75%；等长基期 09-14~09-15（2 天）= 431,982.41 → 真实环比 -53.75%。差 31 个百分点、且把「跌一半」放大成「近乎腰斩八成」。
- **影响面**：影响面：3 个板块（销售/客量/品项）共约 28 个 KPI 卡片的环比徽章，默认 preset 就是 month、默认 cmp 开启（params.ts:107 `withComparison: raw.cmp !== '0'`），即任何人打开数据中心首屏看到的就是这套数。失真幅度随日历日推移，月初 1~3 号最极端（1 天比 30 天，环比恒显示 -95% 级红字）。周维度每周一/周二必现 -80% 级红字。按 9 月实跑：全集团业绩环比被低估 24.4pp，周环比被高估跌幅 31pp。
- **验证员复算**：prod 只读库（fengyu_ro@118.178.196.26:5433，2026-09-22 周二，Shanghai 05:32）按 sales.ts:67-80 runStoreRevenue 原句 + scopeFilterSql(admin/all) 的在营门店过滤实跑，全部复现原告数字，并新增一条原告没跑的对照：

| 区间 | 天数 | SUM(spe.amount) | 行数 |
|---|---|---|---|
| A 当期月 09-01~09-22 | 22 | 3,672,217.98 | 1324 |
| B 代码基期 08-01~08-31 | 31 | 3,452,804.49 | 1260 |
| C 等长基期 08-01~08-22 | 22 | 2,808,430.45 | 960 |
| G custom 预设基期 08-10~08-31 | 22 | 2,508,512.97 | — |
| D 当期周 09-21~09-22 | 2 | 199,786.00 | 63 |
| E 代码基期周 09-14~09-20 | 7 | 1,309,920.91 | 407 |
| F 等长基期周 09-14~09-15 | 2 | 431,982.41 | 118 |

deltaPct 折算：
· 本月：看板显示 +6.35%（A/B），等长口径 +30.76%（A/C）→ 差 24.4pp。
· 本周：看板显示 -84.75%（D/E），等长口径 -53.75%（D/F）→ 差 31.0pp。
· 关键新证据（原告未发现）：同一个当期窗口 [09-01, 09-22]，若用户改从「自定义」选同样的起止日，time-range.ts:85-96 走等长分支给出基期 [08-10, 08-31]=2,508,512.97 → 环比 **+46.39%**。即同一份当期数据，点「本月」得 +6.35%、点「自定义 09-01~09-22」得 +46.39%，两个数在同一块卡片上相差 40 个百分点。这不是口径取舍问题，是同一函数内两条分支自相矛盾。
- **验证员理由**：我按「默认是误报」的立场逐条找退路，四条退路全部走不通：

1）读错代码？没有。time-range.ts:106-116 原文与指控一致；comparison.ts:48-51 对 previous 原样重跑 runner，没有任何按天数归一/日均化的处理；deltaPct(comparison.ts:20-24) 就是裸除。params.ts:93 默认 preset='month'、:107 `withComparison: raw.cmp !== '0'` 默认开 —— 首屏就是这套数。

2）UI 已兜底？没有。kpi-card.tsx:41 只渲染「环比 -84.75%」，DeltaBadge 无 title/tooltip，scope-time-filter.tsx:149 只有「显示同比/环比」开关，全页面任何位置都不显示基期区间，用户无从知道自己在拿 2 天比 7 天。

3）数据上不成立？不成立的是这条退路 —— prod 实跑与原告数字逐位吻合（见 dataEvidence）。

4）是已拍板的反直觉口径？查不到任何拍板依据：metrics.md:918-919 只写「同比/环比：仅 KPI 卡片标量计算（本期/上期/去年同期 delta%）」，未定义上期长度；metrics.md:876-880「时间窗口补充」那张表里的「上月」是 staff sales-data 页的**用户可选周期**，不是对比基期；notes/meetings/meeting-20260417 逐字稿 00:12:19 有人问「同比环比是都要算吗？」但话题当场被岔开，没有结论；.42cog/design/admin.ui.spec.md:151/821 只写了筛选器里有这个开关。唯一出处是 time-range.ts:8-13 的文件头自述 + 同一个 commit（e10a1b14, 2026-05-26）里作者自己写的单测，属实现自述。

反而找到了反向证据：同一个 resolveTimeRange 里，today(:102-105)、year(:117-123)、custom(:85-96) 三个分支的 previous 都是与 current 等长/对齐到同一相对日的，只有 week(:106-110) 和 month(:111-116) 用完整上周/上月。5 个预设里 3 个等长、2 个不等长，且能造出「同一当期窗口两个环比值相差 40pp」的场景 —— 这说明它不是一个成体系的口径选择，至少有一条分支是错的。

影响面我做了下修：原告说「约 28 个 KPI」偏高。efficiency 板块整体没有 withComparison（grep 零命中），customer 18 个 KPI 里有 8 个显式传 enabled=false（customer.ts:965-973）根本不渲染徽章，registeredMembers/retainedMembers 是锚在 range.end 的截面量、memberAvgTicket/newCustomerAvgTicket/consumePerVisit 是比率，都不随区间长度线性缩放。真正被天数差系统性压低的是**可加流量型** 16 个：sales 6（storeRevenue/shengmeiRevenue/storeConsume/shengmeiConsume/newCustomerRevenue/trafficCustomerRevenue）+ customer 5（operatedMembers/newMembers/trafficCustomers/serviceCount/projectCount，其中 operatedMembers 带 ≥1990 阈值，失真比线性更重）+ product 5（product.ts:551-555）。

定级下调到 P2：当期值本身没算错，delta 在它自己的定义下也自洽，属于「基期口径未登记 + 分支自相矛盾」，修哪一侧（把 week/month 基期截成等长，还是把当期改成上一个完整周/月）需要业务方拍板。但如果产品确认「环比应等长」，它立刻升为 P1 级展示错误 —— 月初 1~3 号是 1~3 天比整月，徽章会恒显 -90% 级红字。
- **既有守护**：有守护，但守护的是错误的一侧。/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/time-range.test.ts:42-48 用例名直接写死「month：月初至今 / 整个上月 / 去年同区间」并断言 previous={2023-12-01, 2023-12-31}；:34-40 同样钉死 week 的完整上周。也就是说这不是漂移出来的 bug，是被单测锁住的既有行为，改代码必须同步改这两个断言。反过来说，没有任何测试校验「previous 与 current 等长」这个性质，也没有任何测试发现 custom 与 month 分支对同一窗口给出不同基期。
consistency.*.test.ts（sales/customer/product/efficiency）全部只比对 SQL 字面量与 staff 端同源，完全不碰 time-range，对本条零覆盖。
- **是否设计意图**：否 —— 没有任何拍板依据，只有实现自述。
· notes/references/metrics.md:918-919：「**同比/环比**：仅 KPI 卡片标量计算（本期/上期/去年同期 delta%），明细表与排名榜不做逐行对比。」只登记了「上期」这个概念，全文未定义上期是否与本期等长。
· metrics.md:876-880「时间窗口补充（sales-data 页专用口径）」里的「上月 = date_trunc('month', NOW()-1month) ~ 本月初-1天」是 staff 端用户可选的**查看周期**，不是环比基期，把它挪用成基期属于语义搬家。
· time-range.ts:8-13 文件头「month current=[月初,今天] previous=[上月初,上月末]」是作者自述，与单测同属 commit e10a1b14（2026-05-26「feat(admin): 新增数据中心看板共享 lib 地基」）；后续唯一一次改动 dd1e6025 只修了 fmt() 的 UTC 拼接，没碰基期逻辑。
· 会议逐字稿 notes/meetings/meeting-20260417/...-1.txt:25 有「同比环比是都要算吗？」的提问，无人回答，随即转到沉睡/冰冻话题。
· .42cog 全目录检索「环比」只有 design/admin.ui.spec.md:151、:821 两处，都只描述筛选器上有这个开关，不涉及基期定义。
- **建议修法**：建议按「口径统一」而非「换一种算法」来修：把 week/month 的 previous 收成与 current 等长（week → [上周一, 上周一+本周已过天数-1]，month → [上月1号, 上月同日]，与 today/year/custom 三个分支已有的语义一致），单测 time-range.test.ts:34-48 同步改断言。若业务方坚持要看「本月至今 vs 上月全月」这种进度对比，那就必须在 kpi-card.tsx 的 DeltaBadge 上把基期区间显式标出（如 title="基期 2026-08-01~2026-08-31（31天）"），不能让一个 2 天比 7 天的 -84.75% 裸着挂在首屏；无论选哪条，都要把结论回写 metrics.md 第 918 行那节，并顺手消掉 custom 与 month 对同一窗口给出两个环比值的矛盾。

<details><summary>验证 SQL</summary>

```sql
WITH act AS (SELECT s.store_id FROM stores s JOIN org_nodes o ON s.org_node_id=o.id WHERE o.type='门店' AND o.is_active=TRUE),
r(lbl,s,e) AS (VALUES
  ('当期 09-01~09-22(22天)','2026-09-01'::date,'2026-09-22'::date),
  ('代码基期 08-01~08-31(31天)','2026-08-01'::date,'2026-08-31'::date),
  ('等长基期 08-01~08-22(22天)','2026-08-01'::date,'2026-08-22'::date))
SELECT r.lbl, ROUND(COALESCE(SUM(spe.amount::numeric),0),2)
FROM r LEFT JOIN sale_order_performance_events spe
  ON spe.performance_date BETWEEN r.s AND r.e
 AND spe.status='已支付' AND spe.change_type IN ('首次支付','回款','退款')
 AND spe.sale_order_type IN ('销售单','转换单','充值单')
 AND spe.legacy_source IS DISTINCT FROM 'workfine'
 AND spe.store_id IN (SELECT store_id FROM act)
GROUP BY r.lbl ORDER BY r.lbl;
```

</details>

## A14. [P1][CONFIRMED] deltaPct 未处理基期为负：净业绩为负的门店/日期，环比符号翻转、暴涨被标成红色暴跌

- 审计视角：时间轴与范围闸门　板块：公共层　指标：全部 KPI 的 mom / yoy 徽章（凡基期可为负的金额类指标）
- **断言**：deltaPct 只挡了 base==null 和 base===0，没挡 base<0。业绩/实耗/客单价等口径含退款负行（metrics.md 明确「年度消费可为负…不 clamp」），基期为负时 (cur-base)/base 的符号被负分母翻转，KpiCard 的 DeltaBadge 直接按数值正负上色，于是「从亏转盈」被渲染成大幅红色负增长。
- **规范依据**：notes/references/metrics.md:533「⚠ **年度消费可为负**：含退款负行，顾客当年只有退款时显示负数，表达「本年净消费」，不 clamp。」+ metrics.md:583「防除零 / 数据缺失 | 一律 `--`（不显示 0）」——规范承认金额可为负、且对无法计算的比率要求显示 '--'，但未登记基期为负时环比该怎么算，代码默认走了会翻符号的数学公式。
- **代码证据**：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/comparison.ts:20-24
```ts
export function deltaPct(cur: number | null, base: number | null): number | null {
  if (cur == null) return null
  if (base == null || base === 0) return null   // ← 未挡 base < 0
  return (cur - base) / base
}
```
渲染侧：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/app/(main)/(analytics)/data-center/_components/kpi-card.tsx:9-17 `value > 0 ? 绿 : value < 0 ? 红('#D94040')`。
- **数据证据（发现者）**：prod 只读库实跑：全集团在营门店中，单店单日净业绩为负的有 41 个店-日，涉及 22 家门店，最低 -22,800.00。取相邻两天构造真实复现场景（scope=该门店，preset=自定义单日，环比基期=前一天）：
· 南昌梦祥店：基期 2026-08-06 = -22,800.00 → 当期 2026-08-07 = +29,060.00，代码算出环比 **-227.5%（红色）**
· 自贡贡井店：2026-09-11 = -16,300.00 → 2026-09-12 = +27,800.00，环比 **-270.6%（红色）**
· 南昌万科店：2026-09-08 = -19,000.00 → 2026-09-09 = +2,000.00，环比 **-110.5%（红色）**
· 南昌蓝茉店：2026-09-12 = -16,800.00 → 2026-09-13 = +5,366.00，环比 **-131.9%（红色）**
· 南昌丽景店：2026-08-21 = -14,800.00 → 2026-08-22 = +398.00，环比 **-102.7%（红色）**
- **影响面**：影响面：22 家门店的 41 个店-日会触发；门店级账号选「今日」或单日自定义区间时，只要前一日净业绩为负，环比徽章方向与事实相反。上面 5 例中最极端的是南昌梦祥店 8/7：实际从 -22,800 转为 +29,060（净改善 51,860 元），看板给出「环比 -227.5%」红字。客量板块的会员客单价、人效板块若将来开对比同样受影响（metrics.md 对 spend 为负是明文允许的）。
- **验证员复算**：prod 只读库（fengyu_ro@118.178.196.26:5433，数据跨度 2026-07-08 ~ 2026-09-21 共 75 天）实测，全部按 sales.ts:68-80 `runStoreRevenue` 的**完整 WHERE**（含 scope-sql.ts 的 activeStoreCondition 在营门店过滤）复算：

1) 店-日净业绩为负：41 个店-日 / 22 家门店，最低 -22,800.00（未加在营过滤时的原告口径，一致）。
2) 加上代码真实的「在营门店」过滤后，**相邻两日可构成「基期<0」的组合共 29 对，涉及 19 家在营门店，且 29 对的当期值全部 > 0**（真实向好），代码算出的环比全部为负（红色），区间从 -100.68% 到 **-54,080,100.00%**。逐条实测（基期日/基期值 → 当期日/当期值 → 代码环比）：
   · 南昌梦祥店 2026-08-06 -22,800.00 → 08-07 +29,060.00 → -227.46%
   · 自贡贡井店 2026-09-11 -16,300.00 → 09-12 +27,800.00 → -270.55%
   · 九江梦想店 2026-08-19 -4,000.00 → 08-20 +26,750.00 → -768.75%
   · 南昌梦祥店 2026-09-15 -2,646.00 → 09-16 +29,127.00 → -1,200.79%
   · 自贡汇东店 2026-08-12 -8.00 → 08-13 +2,000.00 → -25,100.00%
   · 南昌蓝茉店 2026-07-28 -0.01 → 07-29 +5,408.00 → **-54,080,100.00%**（formatDelta 原样打印，DeltaBadge 上红色 #D94040）
3) 不止「自定义单日」能触发，**「本周」预设同样命中**：周粒度基期为负的相邻周对 8 例，例如 南昌梦时代 8/31 当周 -19,800.00 → 9/7 当周 +9,600.00 → -148.48%；南昌云锦店 9/7 当周 -4,276.00 → 9/14 当周 +54,654.00 → -1,378.16%。
4) 「本月」也已成型：南昌梦时代 2026-09 当月净业绩 = -6,104.00（今天 9/22 该店总业绩卡就是负值，属 metrics.md 允许）；进入 10 月后该店选「本月」，基期即 -6,104，徽章必然翻向。
5) 同比（yoy）当前恒为 '--'：库里最早业绩日期 2026-07-08，去年同期无数据 → SUM COALESCE 0 → base=0 → 已被现有分支挡住，本条只影响环比。

可复跑最小 SQL：
WITH act AS (SELECT s.store_id FROM stores s JOIN org_nodes o ON s.org_node_id=o.id WHERE o.type='门店' AND o.is_active=TRUE),
d AS (SELECT spe.store_id, spe.performance_date dt, SUM(spe.amount::numeric) v FROM sale_order_performance_events spe
      WHERE spe.status='已支付' AND spe.change_type IN ('首次支付','回款','退款')
        AND spe.sale_order_type IN ('销售单','转换单','充值单')
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND spe.store_id IN (SELECT store_id FROM act) GROUP BY 1,2)
SELECT st.store_name, p.dt 基期日, p.v 基期值, c.dt 当期日, c.v 当期值, ROUND(((c.v-p.v)/p.v)*100,2) 代码环比
FROM d p JOIN d c ON c.store_id=p.store_id AND c.dt=p.dt+1 LEFT JOIN stores st ON st.store_id=p.store_id
WHERE p.v<0 ORDER BY p.v;  -- 返回 29 行，全部为「实际向好却算出负环比」
- **验证员理由**：我按「默认是误报」去找了六条证伪路径，全部未能站住：

(1) 代码引用是否准确 —— 准确。/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/comparison.ts:20-24 原文确为 `if (base == null || base === 0) return null; return (cur - base) / base`，无 base<0 分支；上游 withComparison（同文件:38-58）也不做任何符号处理，直接把 runner 的原值喂进去。渲染侧 kpi-card.tsx:9-17 确实是纯按数值正负上色，format.ts:52-57 的 formatDelta 对任意有限数原样打印，无截断、无阈值兜底。

(2) 上游 WHERE / CTE 是否已排除负行 —— 没有。sales.ts:68-80 的 change_type 明确**包含 '退款'**，且文件头 15-26 行的「口径红线」把它写成 consistency.sales.test.ts 字面量守护的内容，即负行是有意纳入的（metrics.md:36 也明确「退款 amount 为负数，按退款自身归属日期入账」）。所以净值可为负是设计，不是脏数据。

(3) 调用方是否已兜底 —— 没有。context.ts:120 `enabled = params.withComparison !== false`，params.ts:107 `withComparison: raw.cmp !== '0'` 默认**开启**；sales-board.tsx:74 把 action 返回的 kpis 原样丢进 KpiGrid，没有任何二次判定。

(4) 场景是否可达 —— 可达，且不是只能靠构造 URL。time-range.ts:102-105 「今日」预设 previous = 昨日；:85-96 custom 的 previous = 紧邻等长区间，params.ts:88 允许 `start <= end`（即单日自定义合法）；:106-110 「本周」previous = 上一整周。scope-options.ts:17-24 `resolveDefaultDataCenterScope`：**单店账号默认 scope 就落到该店**，正是暴露面最大的那类账号。scope-sql.ts:63-65 store scope 就是 `store_id = $id` 等值，与我复算口径一致。

(5) 是否已被守护覆盖 —— 未覆盖。comparison.test.ts:12-16 只测了 base=0 / base=null / cur=null 三种，没有任何负基期用例；consistency.*.test.ts 是 SQL 字面量快照，根本不经过 deltaPct。

(6) 是否属已拍板设计意图 —— 查无。`git log -- fengyu-admin/src/lib/data-center/comparison.ts` 只有一条 e10a1b14「feat(admin): 新增数据中心看板共享 lib 地基」，`git log -S "base === 0"` 同样只命中这一条，无后续讨论；全仓 `grep -rn "deltaPct|基期" .42cog notes` 零命中；metrics.md 的数据中心章节（:910）只写「同比/环比仅 KPI 卡片标量计算」，对基期为负只字未提。唯一相关的规范表述是 metrics.md:610「防除零 / 数据缺失 | 一律 `--`（不显示 0）」——方向上支持「算不出就显示 '--'」，反而不支持现状。

唯一能替被告说话的一点：主数值本身是对的（-22,800.00 会如实显示为负），错的只是环比徽章的符号与量级。但徽章本身就是给人读方向的，-54,080,100.00% 这种数既不自洽也无法解释，不属于「口径之争」，因此不下 UNCERTAIN。

严重度修正：原告定 P2（口径与文档不符但数字自洽）不成立 —— 数字并不自洽。按本次评级口径 P1 明确把「除零」列为 P1 家族，负分母与除零同源、同属「特定条件下错」，故上调为 P1；未到 P0 是因为主 KPI 数值正确、错的是派生徽章。
- **既有守护**：未被覆盖。/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/comparison.test.ts:12-16 仅断言 base=0 / base=null / cur=null 三种返回 null，无负基期用例；/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/consistency.sales.test.ts 等是 SQL 字面量快照，不经过 deltaPct；kpi-card.tsx 无对应组件测试。
- **是否设计意图**：否。comparison.ts 仅一条提交 e10a1b14「feat(admin): 新增数据中心看板共享 lib 地基」，`git log -S "base === 0" -- fengyu-admin/src` 亦只命中该条，无任何关于负基期的决策记录；`grep -rn "deltaPct|基期" .42cog notes` 零命中；metrics.md 数据中心章节（notes/references/metrics.md:910）只规定「同比/环比仅 KPI 卡片标量计算」，未登记负基期口径。相反，metrics.md:610「防除零 / 数据缺失 | 一律 `--`（不显示 0）」与 metrics.md:546「年度消费可为负…不 clamp」两条合起来，说明「金额可为负」是拍板过的、而「算不出的比率显示 '--'」也是拍板过的，唯独两者交叉处（负基期）规范留白，代码默认套了会翻符号的公式。
- **建议修法**：在 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/comparison.ts:22 把守卫改为 `if (base == null || base <= 0) return null`，即基期非正时环比一律 '--'，与 metrics.md:610「防除零 / 数据缺失 一律 `--`」同源；同时在 comparison.test.ts 补三条用例（base<0 且 cur>0 / base<0 且 cur<base / base<0 且 cur=0）锁死行为，并在 metrics.md「数据中心」章节补登一行「基期 ≤ 0 时同比/环比不计算，显示 '--'」。若产品更希望保留信息量，替代方案是分母取 |base| 并在徽章旁标注「基期为负」，但这属口径新增，需产品拍板后再写进 metrics.md，不建议在修 bug 的同轮夹带。

<details><summary>验证 SQL</summary>

```sql
WITH act AS (SELECT s.store_id FROM stores s JOIN org_nodes o ON s.org_node_id=o.id WHERE o.type='门店' AND o.is_active=TRUE),
d AS (SELECT spe.store_id, spe.performance_date dt, SUM(spe.amount::numeric) v
      FROM sale_order_performance_events spe
      WHERE spe.status='已支付' AND spe.change_type IN ('首次支付','回款','退款')
        AND spe.sale_order_type IN ('销售单','转换单','充值单')
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND spe.store_id IN (SELECT store_id FROM act)
      GROUP BY 1,2)
SELECT st.store_name, p.dt AS 基期日, p.v AS 基期值, c.dt AS 当期日, c.v AS 当期值,
       ROUND(((c.v-p.v)/p.v)*100,1) AS 代码算出的环比百分比
FROM d p JOIN d c ON c.store_id=p.store_id AND c.dt=p.dt+1
LEFT JOIN stores st ON st.store_id=p.store_id
WHERE p.v<0 AND c.v>0 ORDER BY p.v;
```

</details>

## A15. [P0][CONFIRMED] 品项板块「持卡占比」分子数全部购卡顾客、分母只数会员，生产实测 253%~1155%

- 审计视角：SQL 结构性错算　板块：product　指标：cardHolderRate（持卡占比，KPI 卡 + 市场/门店两张明细表 + xlsx 导出同源）
- **断言**：分子 queryCardHolders 用 COUNT(DISTINCT so.client_user_id) 统计「在 scope 内门店买过带次数商品的所有顾客」，不含任何会员条件；分母 queryMemberCount 只数 became_member_at IS NOT NULL 的会员。两个集合的总体不一致（分子含流量客/体验客/小美客），导致这个以百分比渲染的「占比」必然大于 100%。集团视角 4804/1897=253.20%，按市场行最高 1155.00%（南昌易大师 231/20）。把分子限定为会员后，各市场立刻回到 99.0%~100.3%，证明唯一根因就是分子口径。
- **规范依据**：/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md:731「持卡人数（cardHolderCount）per product_kind | `COUNT(DISTINCT so.client_user_id)` | `sale_items si` JOIN `sale_orders so` ... `si.paid_sessions > 0` ∩ `so.sale_order_type IN ('销售单','转换单','寄存单')` ∩ `so.status='已支付'` ∩ scope（`so.store_id`）」；:727「分母『总会员人数』同 `memberCount`（`client_wechat_users.became_member_at IS NOT NULL` ∩ scope by `bound_store_id`…）」——规范本身就把一个全顾客口径的分子配了一个只含会员的分母。
- **代码证据**：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:133-145 分子：
```sql
SELECT COUNT(DISTINCT so.client_user_id) AS v
FROM sale_items si
JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
JOIN product_skus sk ON sk.sku_id = si.sku_id
JOIN product_categories pc ON pc.category_id = sk.category_id
WHERE ${sc} AND si.paid_sessions > 0
  AND so.sale_order_type IN ('销售单','转换单','寄存单')
  AND so.status = '已支付' AND so.client_user_id IS NOT NULL AND ${filter}
```
（全无 c.became_member_at / customer_type 条件）
/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:152-157 分母：`SELECT COUNT(*) FROM client_wechat_users c WHERE ${sc} AND c.became_member_at IS NOT NULL`
/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:505 `cardHolderRate: safeDiv(agg.cardHolders, memberCount)`
/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:560-563 KPI 同式
/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:651+657 byMarket 把各门店 DISTINCT 人数直接相加（`m.agg.cardHolders += s.agg.cardHolders`），与分母 `m.memberCount` 的归属轴（bound_store_id）也不同，属二阶放大（实测仅 7 人，非主因）
/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/format.ts:36 `formatPercent` = value*100 + '%'，所以 2.532 直接渲染成「253.20%」；导出 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/export.ts:13 同样写 253.2 进「持卡占比(%)」列
- **数据证据（发现者）**：prod 只读库 2026-09-22 实测（40 家在营门店）：分子（实现口径）4804 人；其中 became_member_at IS NOT NULL 仅 1882 人，2922 人（60.8%）从未成为会员；分母会员数 1897 → 集团持卡占比 = 253.20%。分市场：南昌易大师 231/20 = 1155.0%、自贡凤御 1006/292 = 344.5%、九江凤御 757/335 = 226.0%、南昌凤御 2817/1250 = 225.4%。把分子限定为会员后：100.0% / 100.0% / 100.3% / 99.0%。按一级品项单选时也超 100%：招牌 3134/1897 = 165.2%、王牌 2107/1897 = 111.1%。
- **影响面**：「持卡占比」这一整列/整卡在四个层级（集团 KPI、5 个市场行、40 个门店行、xlsx 导出列）全部失真 2.25~11.55 倍。任何用它判断「疗程卡渗透率」的决策都被误导；1155% 这种值在页面上直接是一个荒谬数字。受影响顾客口径：2922 名非会员被算进分子。注意 notes/references/metrics.md:727/731 的公式与实现逐字一致，因此规范与代码要同改，不能只改一边。
- **验证员复算**：prod 只读库（118.178.196.26:5433，fengyu_ro）2026-09-22 实跑，40 家在营门店：

1) 集团口径（完全按 product.ts:133-145 原样，不额外 JOIN client_wechat_users，避免漏行）：
   holders_impl(代码口径分子)=4804 | 其中在 client_wechat_users 有行=4804（无漏行，原告的 verify SQL 未失真）| became_member_at IS NOT NULL 者=1882 | 分母 members(bound_store_id ∈ 在营店 ∩ became_member_at NOT NULL)=1897 | 全库会员总数=1898。
   → cardHolderRate = 4804/1897 = 2.5324 → formatPercent 渲染「253.24%」，导出列写 253.24。

2) 分子人群构成（证明两个集合总体确实不同，不是我误读）：
   流量客 2004 人(非会员) / 会员客 1882 人 / 小美客 596 人(非会员) / 体验客 322 人(非会员)，全部 bound_store_id 非空。
   → 2922 人（60.8%）永远不可能进分母。

3) 按代码 byMarket 逻辑（per-store DISTINCT 相加 / per-store memberCount 相加）逐市场复算：
   南昌易大师 231/20 = 1155.00% | 自贡凤御 1006/292 = 344.52% | 九江凤御 757/335 = 225.97% | 南昌凤御 2817/1250 = 225.36% | 昭通凤御 0/0 = --。
   与原告给的数字逐位一致。JS 侧跨店相加的二阶放大：4811(分市场相加) vs 4804(集团 DISTINCT) = 仅 7 人，确非主因；分母两侧一致（20+292+335+1250=1897），无第二处偏差。

4) 追加证伪实验——「是不是 2026-07-22 那次口径变更造成的、回滚即可」：
   同一 WHERE 下换回旧口径 remaining_sessions>0 → 4135 人，4135/1897 仍 = 218%。
   → 即使回滚到旧定义也压不到 100% 以内，说明根因确实是「分子全顾客 / 分母仅会员」的总体错配，而非单次变更。
- **验证员理由**：我按「默认误报」立场逐条尝试推翻，五条路径全灭：

A. 「原告漏看上游 WHERE / CTE 过滤」——不成立。product.ts:127-147 的 queryCardHolders 全文只有 scopeFilterSql(so.store_id) + paid_sessions>0 + sale_order_type 三值 + status='已支付' + client_user_id IS NOT NULL + resolveGrouping 的品项过滤（product.ts:75-94，最宽时是 pc.product_kind IS NOT NULL）。确无任何 became_member_at / customer_type 条件。分母 product.ts:150-159 确为 became_member_at IS NOT NULL。

B. 「调用方已兜底 / 另有分支」——不成立。safeDiv(product.ts:67) 只防分母<=0（返回 null→'--'），不做上限裁剪。三处消费点：KPI product.ts:560-563（unit:'percent'）、明细表 buildMetrics product.ts:505（byStore 40 行 + byMarket 5 行共用）、导出 lib/data-center/export.ts:13-17 metricCell（percent → value*10000/100）。渲染 lib/data-center/format.ts:36 formatPercent = value*100+'%'，无 clamp。columns.ts:97 与 product-board.tsx:18 都标为 percent。四个层级无一处兜底。

C. 「已被守护测试覆盖」——不成立。__tests__/consistency.product.test.ts:56-58 与 :202-207 只做字面量断言（两端 SQL 含 paid_sessions>0、含 became_member_at IS NOT NULL），属跨端防漂移，不碰真实数据；product.test.ts:213-214 用 mock 的 10/40=0.25 走通，恰好掩盖了真实数据下的越界。lib/data-center/ 下无 __tests__ 目录，formatPercent 无上限用例。全仓 grep「超过 100/>100/大于 100」在 metrics.md 与 data-center 代码中零命中——没有任何「允许超 100%」的注记。

D. 「属已拍板的反直觉设计意图」——反被证伪，证据反向支持原告：
   · notes/tickets/archives/2026-04-25-mgmt-product-cycle-page.md:54-63 的原始 UI 稿写死「持卡人数 ÷ 总会员人数」，示例值 33.33%/16.67%/16.67%/8.33%，四项合计 75% —— 设计时的预期值域明确是 0~100%。
   · 同文件 :109「持卡人数为截面，无 period_start/end，仅用 NOW() 时刻的 remaining_sessions」。
   · notes/meetings/meeting-20260723/summary.md:101 甲方原话：「『持卡会员数』按当前仍有剩余疗程/卡项次数的顾客统计；卡项消耗完后不再计入。**该口径与『购买过卡项人数』不同**。」
   而 commit 83eaa9fa（2026-07-22，即该会议前一天）把口径从 product_type IN('疗程卡','单品') AND remaining_sessions>0 改成 paid_sessions>0。db/schema/order.ts:267-273 明确 paid_sessions = floor((received-refunded)/total*session_count)，**只随收退款变动、核销不减**，即语义就是「买过」。所以现口径与甲方当面否定的那个口径正好一致，UI 提示 product-board.tsx:18「以当前时刻未用完疗程卡为准」也与 SQL 不符（提示撒谎）。这不是设计意图，是与拍板口径相悖。

E. 「数据上不成立 / 分母被 became_member_at 回填缺口压小了」——不成立。我专门查了分子人群的 customer_type：2922 名非会员分别是 流量客/小美客/体验客，是该项目 customer_type 口径下真实的非会员（#187 实收跃迁已于 v1.16.34 上线并回填），不是 became_member_at 漏填。

结论：代码忠实实现了 metrics.md:727/731 的公式，但该公式本身给「全顾客分子」配了「仅会员分母」，产出的是一个以百分比渲染、值域可达 1155% 的荒谬数字。哪种修法（收窄分子 / 放宽分母）需产品拍板，但「看板上这一列/这张卡的数字是错的且误导」这一点不需要拍板——原始设计稿的 0~100% 值域已经给出判据。故给 CONFIRMED 而非 UNCERTAIN，维持 P0。
- **既有守护**：否。fengyu-admin/src/actions/data-center/__tests__/consistency.product.test.ts:56-58 与 :202-207 仅做 SQL 字面量跨端防漂移断言；fengyu-admin/src/actions/data-center/__tests__/product.test.ts:213-214 用 mock 数据 10/40=0.25 通过，恰好落在 0~1 内而掩盖越界；fengyu-admin/src/lib/data-center/ 下无 __tests__ 目录，formatPercent(format.ts:36) 无上限用例。四端（admin product.ts、staff mgmt-product.js、consistency snapshot、metrics.md）全部同错，snapshot 守护只会保证「一起错」。
- **是否设计意图**：否，且证据反向。① notes/tickets/archives/2026-04-25-mgmt-product-cycle-page.md:54-63 原始设计稿示例 33.33%/16.67%/16.67%/8.33%（合计 75%），预期值域 0~100%；:109「仅用 NOW() 时刻的 remaining_sessions」。② notes/meetings/meeting-20260723/summary.md:101 甲方明确：「持卡会员数按当前仍有剩余疗程/卡项次数的顾客统计；卡项消耗完后不再计入。该口径与『购买过卡项人数』不同」。③ commit 83eaa9fa（2026-07-22）「fix(metrics): 持卡人数口径改为 paid_sessions>0（三端同步）」把分子改成了甲方次日当面否定的「买过」口径（db/schema/order.ts:267-273：paid_sessions 只随收退款变动、核销不减）。④ metrics.md 变更记录与 data-center 代码中「超过 100%/>100」零命中，无任何「允许超 100%」的书面拍板。
- **建议修法**：分子分母必须同源：把 queryCardHolders / queryCardHoldersByStore 的分子按业务拍板的「持卡」语义重建 —— 恢复「当前仍有剩余次数」(si.remaining_sessions > 0，对齐 meeting-20260723:101 与 UI 提示 product-board.tsx:18)，并与分母同集合（追加 JOIN client_wechat_users c ON c.user_id=so.client_user_id AND c.became_member_at IS NOT NULL；若产品改判「分母应为全体顾客」，则改 queryMemberCount 去掉会员条件，二选一但必须同侧）。byMarket 的 cardHolders 不能在 JS 里跨店相加，应下沉成市场级 COUNT(DISTINCT) 单查以消除 7 人重复。metrics.md:727/731 与 fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js:133-170 必须同步改，再跑 consistency.product.test.ts 重建字面量快照；建议在 buildMetrics 处加一条「占比类指标 >1 即告警」的单测防回归。

<details><summary>验证 SQL</summary>

```sql
WITH ast AS (
  SELECT s.store_id FROM stores s
  JOIN org_nodes o ON s.org_node_id = o.id AND o.type = '门店' AND o.is_active
)
SELECT COUNT(DISTINCT so.client_user_id) AS holders_impl,
       COUNT(DISTINCT so.client_user_id) FILTER (WHERE c.became_member_at IS NOT NULL) AS holders_member_only,
       (SELECT COUNT(*) FROM client_wechat_users x
         WHERE x.bound_store_id IN (SELECT store_id FROM ast)
           AND x.became_member_at IS NOT NULL) AS members
FROM sale_items si
JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
JOIN product_skus sk ON sk.sku_id = si.sku_id
JOIN product_categories pc ON pc.category_id = sk.category_id
JOIN client_wechat_users c ON c.user_id = so.client_user_id
WHERE so.store_id IN (SELECT store_id FROM ast)
  AND si.paid_sessions > 0
  AND so.sale_order_type IN ('销售单','转换单','寄存单')
  AND so.status = '已支付'
  AND pc.product_kind IS NOT NULL;
-- 期望 4804 | 1882 | 1897 → holders_impl/members = 2.532（板上 253.20%）
```

</details>

## A16. [P2][CONFIRMED] 销售板块「流量客业绩」卡片提示写「流量/体验/小美客」，SQL 只取纯流量客，差 20.7 万

- 审计视角：SQL 结构性错算　板块：sales　指标：trafficCustomerRevenue（流量客业绩，KPI 卡 + 市场/门店明细同名列）
- **断言**：SQL 条件是 `c.customer_type = '流量客'`（仅纯流量客，metrics.md 也是这么定的），但 KPI 卡的 hint 文案写「流量/体验/小美客」，把三类客型都许诺进去了。用户读卡时会以为这就是「非会员业绩合计」，而实际漏掉体验客与小美客两类。
- **规范依据**：/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md:899「流量客业绩 | 销售 | `SUM(spe.amount)` WHERE `c.customer_type = '流量客'` | **仅纯流量客（不含体验/小美客）**」——规范明确排除体验/小美客，前端 hint 与规范相反。
- **代码证据**：/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/sales.ts:167 `AND c.customer_type = '流量客'`（runTrafficCustomerRevenue）
/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/sales.ts:353 明细表同条件
/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/app/(main)/(analytics)/data-center/_components/sales/sales-board.tsx:21 `{ key: "trafficCustomerRevenue", label: "流量客业绩", hint: "流量/体验/小美客" }`
（sales.ts 文件头注释第 28-30 行自己写着「仅纯流量客，不含体验客/小美客」，与前端 hint 直接打架）
- **数据证据（发现者）**：prod 只读库，区间 2026-09-01~2026-09-22，按板块同款过滤（spe.status='已支付' ∩ change_type IN ('首次支付','回款','退款') ∩ sale_order_type IN ('销售单','转换单','充值单') ∩ legacy_source<>'workfine' ∩ performance_date 区间）：流量客 197,240.00（52 行）、小美客 191,636.43（360 行）、体验客 15,920.00（185 行）、会员客 3,267,421.55（727 行）。卡面显示 197,240.00，而 hint 暗示的三类合计为 404,796.43，差 207,556.43（相对 hint 口径少 51.3%）。
- **影响面**：卡片数字本身与 metrics.md 一致（不是算错），但提示文案让读者少看 20.76 万/月的非会员业绩，且直接影响「流量客业绩」这一列在市场/门店明细与 xlsx 导出中的解读。修法二选一：改 hint 为「仅纯流量客」，或按业务要真的扩成三类客型（后者要同步改 metrics.md:899 与 staff 端镜像）。
- **验证员复算**：prod 只读库（118.178.196.26:5433 / fengyu_ro），完全按板块口径复算（spe.status='已支付' ∩ change_type IN ('首次支付','回款','退款') ∩ so.sale_order_type IN ('销售单','转换单','充值单') ∩ so.legacy_source IS DISTINCT FROM 'workfine' ∩ spe.performance_date 区间，无 scope 过滤=集团口径）：

【2026-09-01 ~ 2026-09-22】按 customer_type 分组（无 NULL 分组）
- 会员客 3,267,421.55（727 行）
- 流量客 197,240.00（52 行）← 代码实际口径，即卡面数字
- 小美客 191,636.43（360 行）
- 体验客 15,920.00（185 行）
hint 暗示的三类合计 = 197,240.00 + 191,636.43 + 15,920.00 = 404,796.43。
卡面 197,240.00 只占 hint 口径的 48.7%，差 207,556.43。原告数字逐位复现。

【2026-01-01 ~ 2026-09-22（YTD，验证不是单月偶然）】
- 会员客 6,916,987.38（1755 行）/ 小美客 345,599.39（618 行）/ 流量客 317,801.86（105 行）/ 体验客 28,243.00（325 行）
hint 三类合计 691,644.25，卡面 317,801.86 只占 45.9%，差 373,842.39。

【附带核实：流量客业绩为何非零（排除「这个桶本来就该是空的/是脏数据」这一反驳）】
同区间 52 行拆解：销售单·部分支付 24 行 119,189.00 / 转换单·已支付 14 行 63,768.00 / 充值单·已支付 10 行 12,183.00 / 转换单·部分支付 2 行 2,100.00 / 销售单·已退款 2 行 0.00。
与 .42cog/pm/backend.pr.spec.md:893 的跃迁规则自洽（「部分支付订单不参与判定」+ 聚合范围限销售单），所以「纯流量客」确实是一个有钱的合法桶，指标本身成立，卡面数字没算错。
- **验证员理由**：我按「默认是误报」的立场逐条找反驳点，四条路都没走通：

1. 原告是否读错代码 / 漏看上游过滤？
   亲读 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/sales.ts:153-173（runTrafficCustomerRevenue）与 :341-355（门店/市场明细同款 CTE），两处 WHERE 都只有 `AND c.customer_type = '流量客'`，没有任何 IN(...) 或上游 CTE 把体验/小美客并进来。文件头注释 sales.ts:28-30 自述「仅纯流量客，不含体验客/小美客」。原告没读错。

2. 前端是否其实不展示这段文案（比如 hint 只是 tooltip、或条件渲染）？
   kpi-card.tsx:45 `{hint && <div className="text-xs ...">{hint}</div>}` —— 是常驻子文案，直接印在卡片数值下方；sales-board.tsx:74 确实把 KPI_ITEMS 传给 KpiGrid。反驳不成立。

3. 是否属于已拍板的设计意图（「反直觉但故意」）？
   拍板的是 SQL 那一侧，不是文案那一侧，两者方向相反：
   - metrics.md:642 变更记录「2026-05-26 …3 项用户拍板口径——流量客业绩=仅 `customer_type='流量客'`」
   - metrics.md:673 / :904 两处均写「**仅纯流量客**，不含体验客/小美客；2026-05-26 用户拍板」
   - git log：SQL + 「仅纯流量客」注释来自 a2b38e4f（2026-05-26 16:58:43，commit body 明写「含本期拍板口径：流量客业绩=仅 customer_type='流量客'」）；hint 文案来自 **同日 12 秒后**的另一个 commit 2cc5ce35（16:58:55，「数据中心明细表按维度/类型分 Tab 子标签」），commit body 只字未提口径扩围。
   - 全仓 grep 「流量/体验/小美客」共 6 处，另外 5 处（notes/tickets/archives/2026-04-24-member-*.md、member-benefits-page.tsx:165）全部是「`customer_type != '会员客'` 的泛指注解」。这是把一句现成惯用语误用到了一个明确排除该范围的指标上，不是设计意图。
   - 加重情节：数据中心内部这个词本身就打架 —— customer.ts:394/408/730/738「流量客人数（成交率分母）= 体验客 + 小美客」（D-conv-denom=B 已拍板），**恰恰不含纯流量客**。所以 hint 写的「流量/体验/小美客」与本仓任何一处实现都不对应：销售板=纯流量客、客量板=体验+小美。读者若跨板对读必然错位。

4. 数据上是否根本不成立（差额其实很小 / 桶为空 / 三类重叠）？
   跑了上面两个区间，差额 20.76 万（月）和 37.38 万（YTD），量级实打实；customer_type 是单值枚举列不存在重叠；也不存在 NULL 分组吞行。

结论：代码、metrics.md、守护测试、git 提交信息四者一致指向「仅纯流量客」，唯独前端 hint 与之相反，属真实存在的用户可见错误陈述。数字本身没错，错的是印在数字下面的口径声明，故不升 P1/P0，维持 P2（「口径与文档不符但数字自洽，需产品确认改文案还是改口径」）。
- **既有守护**：未被守护。/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/consistency.sales.test.ts:146-151 只守 SQL 侧，且方向正好相反——它断言 `expect(adminSrc).toMatch(/customer_type\s*=\s*'流量客'/)` 并显式 `expect(adminSrc).not.toMatch(/'流量客'\s*,\s*'体验客'\s*,\s*'小美客'/)`，即「把 SQL 改成三类客型」会被测试红掉。前端文案零覆盖：唯一相关的 UI 测试 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/app/(main)/(analytics)/data-center/[board]/page.test.tsx 里 grep 不到 hint / 流量 任何字样；columns.ts:120,136 的明细列只有 label「流量客业绩」无 hint，xlsx 导出同样不带口径说明。
- **是否设计意图**：口径（SQL）是设计意图，文案不是。设计意图原文三处：notes/references/metrics.md:642「2026-05-26 … 流量客业绩=仅 `customer_type='流量客'`」；metrics.md:673「`c.customer_type = '流量客'` ∩ 同上（**仅纯流量客**，不含体验客/小美客；2026-05-26 用户拍板）」；metrics.md:904 同义重述。代码侧 sales.ts:28-30 文件头注释「流量客业绩（trafficCustomerRevenue，2026-05-26 用户拍板）… 仅纯流量客，不含体验客/小美客」。git log -S 显示 SQL 与 hint 由同日相隔 12 秒的两个 commit（a2b38e4f → 2cc5ce35）分别引入，后者 commit message 未提口径变更 —— hint 是笔误而非拍板。注意组织内确有竞争性用法（.42cog/design/staff.ui.spec.md:561「全部(128) 会员客(85) 流量客(43)」，128=85+43，那里的「流量客」=非会员客），这正是这句笔误的来源，也是必须由产品明确钉死的点。
- **建议修法**：二选一，默认建议走 (a)：(a) 把 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/app/(main)/(analytics)/data-center/_components/sales/sales-board.tsx:21 的 `hint: "流量/体验/小美客"` 改为 `hint: "仅纯流量客"`，一行改完即与 metrics.md:673/904 + consistency.sales.test.ts:146 对齐，零数据影响；同时建议给客量板的「流量客人数（=体验+小美）」也补一句 hint，消除同页同名异义。(b) 若产品真要按 staff.ui.spec 的「非会员客」口径扩成三类，则属口径变更：需同步改 sales.ts:167 与 :353 两处 SQL（`c.customer_type IN ('流量客','体验客','小美客')`）、metrics.md:642/673/904、放宽 consistency.sales.test.ts:149 的 not.toMatch 断言，并核对 staff 端镜像 mgmt-dashboard.js；按 YTD 该列会从 317,801.86 抬到 691,644.25（+118%），属看板数字跃变，必须先拍板再动。

<details><summary>验证 SQL</summary>

```sql
SELECT c.customer_type, round(SUM(spe.amount), 2) AS amt, count(*) AS rows
FROM sale_order_performance_events spe
JOIN sale_orders so ON so.sale_order_id = spe.sale_order_id
JOIN client_wechat_users c ON c.user_id = so.client_user_id
WHERE spe.status = '已支付'
  AND spe.change_type IN ('首次支付','回款','退款')
  AND so.sale_order_type IN ('销售单','转换单','充值单')
  AND so.legacy_source IS DISTINCT FROM 'workfine'
  AND spe.performance_date BETWEEN '2026-09-01' AND '2026-09-22'
GROUP BY 1 ORDER BY 2 DESC;
-- 流量客 197240.00 / 小美客 191636.43 / 体验客 15920.00
```

</details>

## A17. [P0][CONFIRMED] 人效「人均业绩」分子含 106 名无门店员工的 141 万，分母把他们整体剔除

- 审计视角：上游数据质量　板块：efficiency　指标：人均业绩 empAvgRevenue（及同源的人均收入 empAvgIncome）
- **断言**：分子 qRevenueTotal 按「订单门店 so.store_id」过滤，把所有拿到分配额的员工都算进去；分母 qTechnicianCount 按「员工门店 s.store_id」过滤，而 scopeFilterSql 生成的是 `s.store_id IN (SELECT …)`，store_id IS NULL 的员工三值逻辑恒为 NULL → 被整体剔除。prod 有 106 名 store_id IS NULL 的员工（品项老师/推广部/售前老师等直挂市场或部门节点），他们的业绩进分子、人头不进分母。同一文件的员工排行榜已用 orgAnchorScopeSql 专门兜住这批人（L527），KPI 分母漏了同一处理。叠加多角色满额分配（品项老师1.0+美容师1.0），分子还比实际受票金额高约 30%。
- **规范依据**：/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md:428 「人均业绩 日/月 | `storeRevenue.today / employeeCount.day` ; `storeRevenue.month / employeeCount.month`」—— 文档口径的分子是**门店业绩**（storeRevenue），不是员工分配额之和；metrics.md:113 「业绩 | `SUM(spia.allocated_amount)` | `sale_payment_item_allocations.employee_id`」只定义了**按员工分组**的业绩，未授权跨员工求和当门店总额。
- **代码证据**：分子 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/efficiency.ts:141-152 —— `SELECT COALESCE(SUM(spia.allocated_amount::numeric), 0) AS v FROM sale_payment_item_allocations spia … WHERE ${scopeFilterSql(session, scope, 'so.store_id')} AND spia.is_void = FALSE AND so.sale_order_type IN ('销售单','转换单')`（注意 scope 打在 so.store_id，对 spia.employee_id 无任何约束）；分母 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/efficiency.ts:230-238 —— `FROM staff_wechat_users s WHERE ${scopeFilterSql(session, scope, 's.store_id')} AND s.skills && ARRAY['美容师','养生师']::text[] …`；装配 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/efficiency.ts:800 `empAvgRevenue: mk(ratio(revenueTotal, technicianCount), 'amount')`；NULL 被吞的根因 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/scope-sql.ts:31-39 `${storeCol} IN (SELECT active_store.store_id FROM stores active_store JOIN org_nodes …)`；已存在但没用上的兜底 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/data-center/scope-sql.ts:90-115 orgAnchorScopeSql（其 doc 明写「按 store_id 过滤会被整体挡在员工榜外」）。
- **数据证据（发现者）**：prod 只读库实测，2026-09-01~09-22 集团 scope：分子 revenueTotal = 4,786,941.55；其中 employee.store_id IS NULL 的员工占 1,413,227.75（29.5%，1810 条分配行，岗位为 科美老师/美艺首席/项目经理/售前老师/推广员…）。分母 technicianCount = 150（skills && ['美容师','养生师'] ∩ store_id 在启用门店）→ 看板显示人均业绩 31,912.94。staff_wechat_users 共 106 人 store_id IS NULL（99 在职 + 7 离职），其中 18 人带美容师/养生师技能也一并被分母排除。同区间销售板块「业绩」= 3,672,217.98（销+转+充）/ 3,633,638.78（仅销+转），与分子差 +1,114,723.57（+30.4%）；同区间 receipt 实际金额合计 3,680,919.90，分子比它高 1,106,021.65，因 6831 张 receipt 中 2039 张分配比例之和 >1（最高 3.0，典型组合『品项老师:1.000 + 美容师:1.000』745 张）。
- **影响面**：人效板块首屏 KPI「人均业绩」在 2026-09 被抬高：若把 141 万挪出分子或把 106 人并入分母，人均业绩从 31,912.94 分别降到约 22,490（剔分子）或 28,493（并分母，按 150+18 计）。同一天、同一 scope 下销售板块给出 3,672,217.98、人效板块给出 4,786,941.55，两块板对同一个「业绩」差 111 万（30.4%），管理层做门店/人效对标时必然打架。empAvgIncome（提成收入）走同一条 spia 链路，同向失真。
- **验证员复算**：prod 只读库（118.178.196.26:5433/fengyu_wxapp），区间 2026-09-01~09-22、scope=集团(all)、admin 会话，逐条复算：

【分子 revenueTotal，efficiency.ts:141-152 原样复现】= 4,786,941.55（5568 行 spia）
  · 按员工是否有门店拆：有门店 3,373,713.80 / 3758 行；store_id IS NULL 1,413,227.75 / 1810 行 —— 与原告数字**逐位一致**。
【分母 technicianCount，efficiency.ts:230-238 原样复现】= 150。
  · 被 `IN (子查询)` 三值逻辑整体剔除的无门店技师 = **14 人**（按代码自带的 hired_at<=区间末 ∩ resigned_at>区间末 历史化）；不做历史化的裸口径才是原告说的 18 人。staff_wechat_users 全表 store_id IS NULL = 106（99 在职 + 7 离职），原告此数正确。
【看板实际显示】4,786,941.55 / 150 = **31,912.94**。
【metrics.md:428 口径复算】storeRevenue = 3,672,217.98（销+转+充）→ 3,672,217.98 / 150 = **24,481.45**。差 **+30.35%**。

★ 但原告的归因大部分是错的。把分子按「是否属于分母人群（skills && ['美容师','养生师']）」× 「是否有门店」四象限拆开：
  在分母池 + 有门店：115 人  3,372,550.16
  在分母池 + 无门店：  7 人     86,580.44  ← 原告指控的 store_id IS NULL 机制，**只占 1.8%**
  不在分母池 + 无门店：34 人  1,326,647.31 ← 真正的大头
  不在分母池 + 有门店：  6 人      1,163.64
即「分子有、分母无」合计 1,414,391.39（29.5%），其中 **93.9% 来自根本没有技师技能的角色**（科美老师/美艺首席/项目经理/推广员/售前老师/店经理…），跟 store_id 是否为 NULL 无关 —— 按 role_type 拆分子：美容师 3,229,180.04、养生师 229,950.56、品项老师 1,013,631.30、推广部 216,799.01、售前老师 96,217.00、店经理 1,163.64。

★ 分子本身还不是任何一笔真实金额（原告只写了结论，我做了 receipt 级对账）：
  同区间 receipt 实际金额合计 = 3,680,919.90；分配额合计 = 4,786,941.55。
  1,123 张 receipt 的 allocation_ratio 之和 > 1（848 张=2.0，124 张=3.0，73 张=1.5…），**重复计数 1,276,068.42**；
  另有 950 张 receipt 完全没有分配行，5.8 万元根本没进分子。净差 +1,106,021.65。

★ 同一屏自相矛盾：同页「门店业绩排行榜」(efficiency.ts:~393 起) 用 `SUM(spe.amount)` 现金流口径，合计 3,672,217.98；KPI 分子用 spia 合计 4,786,941.55。同一个「业绩」在同一个人效页差 111 万。
- **验证员理由**：我按「默认误报」去证伪，试了五条路，四条没打穿、一条打穿了原告的归因但没打穿结论：

① 试图证明「分子含无门店员工天经地义」——**这条我打穿了原告**。metrics.md:428 的分子是 storeRevenue（门店业绩），门店业绩本来就包含外援/直挂市场人员在本店产生的钱；所以「141 万进分子」本身不是罪证，原告提的两个修法（剔分子→22,490、并分母→28,493）**都会得到错误的数**，正确的 metrics.md 口径值是 24,481.45。原告把 106 人/141 万当作核心证据是误导性的。

② 试图证明「store_id IS NULL 被剔除是无关紧要的噪声」——部分成立：四象限拆解显示，真正「是技师却被 NULL 语义挡在分母外」的只有 7 人 86,580.44（占差额 6.1%）。所以原告点名的 scope-sql.ts:31-39 NULL 三值逻辑确实存在（我确认了 `IN (子查询)` 对 NULL 左值恒为 NULL，且 orgAnchorScopeSql 已为员工榜兜住同一批人），但它不是载重原因。

③ 试图证明「分子分母不一致是已拍板」——**失败**。git log 证据链（见 isDesignIntent）反向证明：初版分子本来带 role_type 白名单、1ce30dcc 刻意保留、23405ddf 在一次表迁移重构中无声删掉。同文件对「实耗」明确写了 Part A/B 必须避开多角色重复口径，业绩侧漏做同一隔离。

④ 试图证明「数字其实对得上」——**失败**，反而查出比原告更硬的证据：receipt 级对账 3,680,919.90 vs 分配额 4,786,941.55，1,123 张 receipt 的 ratio 之和 >1（848 张恰好 2.0、124 张恰好 3.0），重复计数 1,276,068.42；同时 950 张 receipt 无分配行、5.8 万漏进。分子既不等于门店收到的钱，也不等于任何可审计的金额。

⑤ 试图证明「有守护兜住 / 产品已知情」——**失败**。单测 db 全 mock 只验除法；consistency 快照反过来把「不按 role_type 截断」钉死；UI 标签无 hint。

结论：原告的**机制描述属实、数字可逐位复现、结论（人均业绩被抬高约 30%）成立**，但**归因错了**（把 1.8% 的 store_id NULL 当主因，真主因是 23405ddf 丢掉的 role_type 白名单 + 多角色重复分配），且**提出的两种修法都会给出错误的数**。因为「看板上的数字确实错了、且是重复计数、且永远错而非条件性错、且同页两处对同一个『业绩』自相矛盾差 111 万」，我把定级从 P1 上调到 P0，但在建议里纠正归因。
- **既有守护**：否，而且既有守护把错误现状钉死了。
· /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/efficiency.test.ts:160 `expect(res.kpis.empAvgRevenue.value).toBe(200) // 2000 / 10` —— db 全 mock，只验除法，碰不到口径。
· /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/consistency.efficiency.test.ts:76-84 反向断言 `expect(adminBody).not.toMatch(/spia\.role_type\s+IN\s*\(\s*'美容师'\s*,\s*'养生师'\s*\)/i)`（staff 端同款），即**把「业绩分子不按 role_type 截断」锁成字面量快照**。修这条 bug 必须同时改这两条断言，否则红。
· lib/data-center/*.test.ts 与 scope-sql 无任何「分子分母人群一致性」用例。
- **是否设计意图**：不是。git 谱系显示这是一次无声的口径回归，不是拍板：
1. 初版 a2b38e4f「feat(admin): 数据中心四板块取数 action」里，qRevenueTotal 明确带 `AND sa.role_type IN ('美容师', '养生师')` —— 与分母的 skills 白名单同源，正是 metrics.md 第 99-100 行那句「推广师虽享提成但人头不计入「员工数」…**分子分母口径必须一致**」。
2. 1ce30dcc「管理层收入排行/KPI 移除 role_type 过滤向绩效页对齐」的 commit body 明写：「efficiency.ts 删 6 处**收入维度** role_type IN…，**业绩维度 total_amount 保留**」「mgmt-dashboard.js …**staffRankingRevenue 业绩保留**」—— 当时是刻意只动收入、留住业绩。
3. 23405ddf「refactor: 支付分配/退款联级/已付会话跨四端一致性重构」（sale_allocations → sale_payment_item_allocations 迁移）把 `role_type IN ('美容师','养生师')` 从**业绩**侧一并删了，commit body 只字未提口径变更，只说「跨四端镜像同步」。
4. 同一文件头对「实耗」有明确隔离声明：efficiency.ts:48-50「所有 role_type 各算一份…故**员工榜/明细表合计会大于门店实耗**（2026-09 实测高约 25%）。**门店榜 / 全局大卡实耗（Part A/B）仍走 service_items 原口径，不受影响**」—— 作者清楚「多角色各算一份」只能用在员工榜、不能用在全局大卡，业绩侧却没做同样的隔离。
5. efficiency.ts:56-73 的「⚠️ 偏离 metrics.md 说明」列了 4 条偏离，唯独没有「人均业绩分子改用员工分配额」，反而自称「人均派生分母『员工数』= 技师口径，与 metrics.md §派生指标分母 employeeCount 对齐」—— 只声明分母对齐、分子悄悄换源。
6. 跨端也已漂移：staff 端「人均业绩」分子是 mgmt-dashboard.js:210 `queryStoreRevenue` = `SUM(spe.amount)`（销+转+充，现金流），与 metrics.md:428 一致；admin 数据中心换成了 spia 合计。
7. .42cog/pm/admin.pr.spec.md、design/admin.ui.spec.md 只规定路由与权限，无任何人均业绩口径条款；UI 标签 efficiency-board.tsx:17「员工人均业绩」没有 hint，不向用户披露分子含多角色重复分配。
- **建议修法**：分子必须与分母同源，二选一并同步改 consistency.efficiency.test.ts:76-84 那条把现状钉死的快照：
(A) 推荐——回归 metrics.md:428：把 efficiency.ts:141-152 的 qRevenueTotal（及 L285 的 qRevenueByStore）换成与同页门店榜、销售板块同源的 `SUM(spe.amount)` 现金流口径（status='已支付' ∩ change_type IN ('首次支付','回款','退款') ∩ legacy_source IS DISTINCT FROM 'workfine'），分母维持 150 不变 → 2026-09-01~22 集团人均业绩 31,912.94 → 24,481.45。
(B) 若产品坚持「员工人均」语义：分子恢复 `spia.role_type IN ('美容师','养生师')` 并对同一 receipt 同一员工去重（防 2.0/3.0 倍重复），同时用已有的 orgAnchorScopeSql 把 store_id IS NULL 的产能技师并入分母（efficiency.ts:230-238）—— 两侧都改才自洽，只做其中一半仍然错。
无论选哪条，都要把 empAvgIncome（走同一条 spia 链路，同向失真）和 byMarket 的 revenue 列一并处理，并在 KPI 卡加 hint 披露口径。

<details><summary>验证 SQL</summary>

```sql
-- 分子里属于「无门店员工」的部分 + 分母
WITH act AS (SELECT s.store_id FROM stores s JOIN org_nodes n ON s.org_node_id=n.id WHERE n.type='门店' AND n.is_active)
SELECT (sw.store_id IS NULL) AS emp_no_store, count(*) rows, round(sum(spia.allocated_amount),2) amt
FROM sale_payment_item_allocations spia
JOIN sale_payment_item_receipts spir ON spir.id=spia.sale_payment_item_receipt_id
JOIN sale_items si ON si.sale_item_id=spir.sale_item_id
JOIN sale_orders so ON so.sale_order_id=si.sale_order_id
JOIN sale_order_performance_events spe ON spe.sale_payment_id=spir.sale_payment_id
JOIN staff_wechat_users sw ON sw.employee_id=spia.employee_id
WHERE so.store_id IN (SELECT store_id FROM act) AND spia.is_void=false
  AND so.sale_order_type IN ('销售单','转换单')
  AND spe.performance_date BETWEEN '2026-09-01' AND '2026-09-22'
GROUP BY 1;

WITH act AS (SELECT s.store_id FROM stores s JOIN org_nodes n ON s.org_node_id=n.id WHERE n.type='门店' AND n.is_active)
SELECT count(*) FILTER (WHERE s.store_id IN (SELECT store_id FROM act)) AS denominator_now,
       count(*) FILTER (WHERE s.store_id IS NULL) AS dropped_no_store
FROM staff_wechat_users s
WHERE s.skills && ARRAY['美容师','养生师']::text[] AND s.hired_at IS NOT NULL
  AND s.hired_at::date <= '2026-09-22' AND (s.resigned_at IS NULL OR s.resigned_at::date > '2026-09-22');
```

</details>

## A18. [P1][CONFIRMED] 品项「持卡占比」= 253%，单店最高 2600% —— 分子数持卡人、分母只数会员

- 审计视角：上游数据质量　板块：product　指标：持卡占比 cardHolderRate（KPI 卡 + byMarket/byStore 明细列）
- **断言**：分子 queryCardHolders 统计「paid_sessions>0 的订单所属门店下的去重顾客」，不限 customer_type，且按 so.store_id 归组（同一顾客跨店重复计入）；分母 queryMemberCount 只数 became_member_at IS NOT NULL 的会员，且按 c.bound_store_id 归组（每人只落一家店）。寄存单迁移把存量次卡发给了大量非会员，导致分子里 60.8% 的人根本不在分母集合里，比值必然 >100%。
- **规范依据**：/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md:727 「分母『总会员人数』同 memberCount（client_wechat_users.became_member_at IS NOT NULL ∩ scope by bound_store_id…）」；metrics.md:731-732 「持卡人数（cardHolderCount）… `si.paid_sessions > 0` ∩ `so.sale_order_type IN ('销售单','转换单','寄存单')` ∩ `so.status='已支付'` ∩ scope（so.store_id）」/「占比（cardHolderRate）… `cardHolderCount / memberCount × 100%`」。实现与文档字面一致，但文档隐含「持卡人 ⊆ 会员」的前提已被寄存单迁移数据推翻 —— 需产品拍板是分子加 became_member_at 守卫，还是分母换口径。
- **代码证据**：分子 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:133-145 —— `SELECT COUNT(DISTINCT so.client_user_id) AS v FROM sale_items si JOIN sale_orders so … WHERE ${sc} AND si.paid_sessions > 0 AND so.sale_order_type IN ('销售单','转换单','寄存单') AND so.status='已支付'`（scope 打在 so.store_id，无 customer_type/became_member_at 约束）；分母 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:150-158 —— `FROM client_wechat_users c WHERE ${scopeFilterSql(session, scope, 'c.bound_store_id')} AND c.became_member_at IS NOT NULL`；派生 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:560-563 `cardHolderRate: { value: safeDiv(cardHoldersTotal, memberCountTotal), unit: 'percent' }`；按店版同构缺陷 product.ts:288-315 vs 318-330。
- **数据证据（发现者）**：prod 只读库实测（集团 scope，启用门店，product_kind IS NOT NULL）：持卡人数 = 4804，会员数 = 1897 → 持卡占比 = 253.2%。分子按 customer_type 拆分：流量客 2004 / 会员客 1882 / 小美客 596 / 体验客 322，其中 became_member_at IS NOT NULL 的只有 1882 人（39.2%），2922 人（60.8%）不可能出现在分母。按门店更离谱：南昌春天店 52 持卡 / 2 会员 = 2600.0%，南昌凯旋店 45/2 = 2250.0%，南昌恒茂店 152/12 = 1266.7%，南昌太一店 39/4 = 975.0%，南昌梦时代 81/9 = 900.0%，自贡南湖店 187/28 = 667.9%。持卡来源构成：寄存单贡献 106339 个 paid_sessions>0 的明细行，销售单 5368 行、转换单 3631 行。
- **影响面**：品项板块 KPI 卡「持卡占比」及 byMarket/byStore 两张明细表的占比列全部大于 100%，最高 2600%，是一眼可见的错数；覆盖 40 家启用门店全部行。读数的人无法判断「持卡渗透率」，也无法横向比店（比值主要由该店寄存单录入量而非会员基数决定）。
- **验证员复算**：prod 只读库（118.178.196.26:5433 / fengyu_ro）实测，40 家启用门店 ∩ product_kind IS NOT NULL ∩ 集团 scope：

1) 按代码实际口径复算：分子 cardHolders = 4804，分母 memberCount = 1897 → 253.24%。原告数字逐位复现。渲染侧 format.ts:36 的 formatPercent 直接 ×100 且无 clamp，看板上就是 "253.24%"。
2) 分子构成（LEFT JOIN client_wechat_users 拆分）：会员客 1882（became_member_at 全非空）/ 体验客 322 / 流量客 2004 / 小美客 596，后三类 became_member_at 全部为 NULL。即 2922 人（60.8%）结构性不可能进分母。4804 人全部存在于 client_wechat_users 且 bound_store_id 非空 —— 排除了"分母漏回填/join 打空"这一解释。
3) 店级：40 家启用门店中 36 家 >100%。最高 南昌春天店 52/2 = 2600.0%，南昌凯旋店 45/2 = 2250.0%，南昌恒茂店 152/12 = 1266.7%，南昌太一店 39/4 = 975.0%，南昌梦时代 81/9 = 900.0%，自贡南湖店 187/28 = 667.9%。无一家因 memberCount=0 走 safeDiv→'--'。
4) 不是"不选品项才炸"：单选一级品项同样破 100% —— 招牌 3134/1897 = 165.21%、王牌 2107/1897 = 111.07%（其余 其他 91.04% / 明星 66.63% / 拓客引流卡 63.47% / 加项 3.58% / 家居 0.63%）。
5) 驱动因子实测：寄存单贡献 106339 行 paid_sessions>0 明细 / 4297 去重持卡人，其中 2492 人非会员；剔除寄存单后分子 1608 → 84.77%（<100%）。销售单 5368 行 / 1457 人，转换单 3631 行 / 303 人。
6) 同一时刻、同一分母 1897 的四种口径对照：
   A 原始拍板口径（product_type IN('疗程卡','单品') ∩ remaining_sessions>0 ∩ 仅销售单/转换单）= 1169 → 61.62%
   B 当前线上实现 = 4804 → 253.24%
   C 当前口径剔除寄存单 = 1608 → 84.77%
   D 分子加 became_member_at 守卫 = 1882 → 99.21%
7) 对原告一处说法的订正：**"同一顾客跨店重复计入"在数据上几乎不成立** —— 按 (uid, store_id) 去重得 4811 对 vs 全局去重 4804 人，只多 7 对，对 253% 无实质贡献。真正的病因只有分子/分母人群集合不同源这一条。
- **验证员理由**：我按"默认误报"立场做了六路证伪，前五路全部失败，第六路反而加重了指控：

证伪1「原告读错代码/漏看上游过滤」——失败。我逐段读了 fengyu-admin/src/actions/data-center/product.ts:127-147（总量分子，scopeFilterSql 打在 so.store_id）、:150-158（分母，scope 打在 c.bound_store_id + became_member_at IS NOT NULL）、:288-336（按店双查询）、:504-505 与 :560-563（buildMetrics / KPI 派生）。分子链路上唯一的额外守卫是 resolveGrouping 给的品项过滤，没有任何 customer_type / became_member_at 约束；调用方 getProductBoard 也未做任何兜底，byMarket 是把门店级分子与门店级分母各自求和后重新 safeDiv（product.ts:651-665），同样没有守卫。前端 columns.ts:97 unit:'percent'，format.ts:36 无 clamp。原告读对了。

证伪2「只有默认不选品项时才炸」——失败。见 dataEvidence 第 4 条，招牌/王牌两个一级品项单选时仍是 165%/111%。

证伪3「是数据没回填，不是代码口径问题」——失败。became_member_at 与 customer_type 在这 4804 人上完全对齐（会员客 1882 全有、其余三类 2922 全无），分母数据自洽；4804 人也全部有 bound_store_id。不存在"分母被数据坑吞掉"的解释。

证伪4「跨店重复计入把比值撑爆了」——部分证伪成功，但对结论无用。只多 7 对，我已在 dataEvidence 里订正原告这一处夸大。剔掉这条后核心指控依然成立。

证伪5「已被守护测试覆盖，说明是刻意口径」——失败。consistency.product.test.ts 是纯字面量快照，:204/:207 只断言两端出现 became_member_at IS NOT NULL；product.test.ts:207-214 用 mock 10/40=0.25 跑派生路径，比值永远 ≤1，看不到 >100%。全仓 grep 不到任何对该比值的合理性断言。

证伪6「属于已拍板的设计意图」——反转。原始拍板文件 notes/tickets/archives/2026-04-25-mgmt-product-cycle-page.md:170 与决策点 D-cardholder-definition（:204）白纸黑字定义分子为 `product_type IN ('疗程卡','单品') AND remaining_sessions > 0` ∩ `sale_order_type IN ('销售单','转换单')`，**不含寄存单**。用这个被拍板的口径在今天的库上复算是 1169/1897 = 61.62%，一个合理的渗透率。之后分子被两次单向放宽：a2b38e4f（2026-05-26，数据中心落地时把 '寄存单' 塞进 IN 列表）、83eaa9fa（2026-07-22，改 paid_sessions>0 并去掉 product_type 过滤，commit body 只写"三端同步"）。两次都只把 metrics.md 的**分子**描述改成跟代码一致，没有任何人回头看分母。所以 metrics.md:727/731-732「实现与文档字面一致」是文档追着代码走的结果，不构成对"占比可以到 2600%"的拍板。

结论：缺陷真实、可复现、覆盖 36/40 门店行与 KPI 卡，且默认视图即可见，无需任何边界条件。"哪个口径才对"确实需要产品拍板，但两种候选修法（分子加会员守卫 → 99.21%；或分母换成全体顾客）都落回 ≤100%，所以"存在缺陷"本身不需要拍板，只有修法选择需要。按裁决标准给 CONFIRMED 而非 UNCERTAIN。

严重度维持原告的 P1，不上调 P0：分子、分母各自的 SQL 都没算错，没有 JOIN 扇出、没有 scope 越权（scopeFilterSql 两侧都正常生效）、没有时间轴错位；病根是"某类订单（寄存单）被纳入分子而其持有人被系统性排除在分母外"，正好落在 P1 的定义上。
- **既有守护**：无守护。fengyu-admin/src/actions/data-center/__tests__/consistency.product.test.ts 是"代码 vs 逐字快照"，:202-208 只断言两端源码里出现 `became_member_at IS NOT NULL`，不校验比值；fengyu-admin/src/actions/data-center/__tests__/product.test.ts:206-214 用 mock 持卡 10 / 会员 40 断言 cardHolderRate≈0.25，:285-286 按店同理 6/24=0.25 —— 夹具数值天然 <1，永远触发不到 >100%。fengyu-admin/src/lib/data-center/format.ts:36 formatPercent 只做 ×100+toFixed(2)，无上界 clamp，所以 2600% 会原样打到页面。既有测试全绿也不会发现这条。
- **是否设计意图**：不是。分子与分母**各自**是设计意图，但"两者相除"从未被拍板过。原始决策 notes/tickets/archives/2026-04-25-mgmt-product-cycle-page.md:170 + 决策点 D-cardholder-definition(:204) 把分子限定为 `product_type IN ('疗程卡','单品') ∩ remaining_sessions>0 ∩ sale_order_type IN ('销售单','转换单')`（无寄存单），该口径下今天算出来是 61.62%，隐含的"持卡人 ⊆ 会员"前提成立。后续两次放宽 a2b38e4f（加寄存单，注释理由"WorkFine 剩余次数初始化，按次数维度纳入"）与 83eaa9fa（改 paid_sessions>0）都是只动分子、只同步分子文档。metrics.md:727/731-732 的字面一致是事后追平，不是对 >100% 的认可。全仓 notes/ 与 .42cog/ 搜不到任何"持卡占比可超 100%"的说明，gh issue 也无同题在案。staff 端 fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js:143-147 与 admin 同构，同样缺分母侧守卫 —— 是跨端同步的同一处缺陷，不是 admin 单方漂移。
- **建议修法**：推荐给分子加 `became_member_at IS NOT NULL` 守卫（语义变成"会员中的持卡渗透率"，与 KPI 标题"持卡占比"及分母最自洽），集团口径立即回到 1882/1897 = 99.21%，36 家破百门店全部落回 ≤100%。改动需四处同步 + 两处文档：admin product.ts:133-147 的 queryCardHolders 与 :293-312 的 queryCardHoldersByStore、staff mgmt-product.js:138-148 的 cardHolders，再更新 metrics.md:727/731-732 与 consistency.product.test.ts 快照。若产品要的其实是"全体顾客持卡渗透率"，则应改分母为 scope 内全体 client_wechat_users（去掉 became_member_at 条件），但这属于换指标语义，需一并改 KPI 文案。无论选哪种，都建议顺手修 fengyu-admin/src/app/(main)/(analytics)/data-center/_components/product/product-board.tsx:18 已过期的 hint —— 它仍写"以当前时刻未用完疗程卡为准"，而 83eaa9fa 起实际口径已是 `paid_sessions>0`（已解锁次数，不看剩余），这个陈旧提示正是读数人无法自行识破 253% 的原因之一。

<details><summary>验证 SQL</summary>

```sql
WITH act AS (SELECT s.store_id FROM stores s JOIN org_nodes n ON s.org_node_id=n.id WHERE n.type='门店' AND n.is_active),
ch AS (SELECT DISTINCT so.client_user_id uid, so.store_id
  FROM sale_items si JOIN sale_orders so ON so.sale_order_id=si.sale_order_id
  JOIN product_skus sk ON sk.sku_id=si.sku_id JOIN product_categories pc ON pc.category_id=sk.category_id
  WHERE so.store_id IN (SELECT store_id FROM act) AND si.paid_sessions>0
    AND so.sale_order_type IN ('销售单','转换单','寄存单') AND so.status='已支付'
    AND so.client_user_id IS NOT NULL AND pc.product_kind IS NOT NULL)
SELECT (SELECT count(DISTINCT uid) FROM ch) AS cardholders,
       (SELECT count(*) FROM client_wechat_users c WHERE c.bound_store_id IN (SELECT store_id FROM act) AND c.became_member_at IS NOT NULL) AS members,
       (SELECT count(DISTINCT ch.uid) FROM ch JOIN client_wechat_users c ON c.user_id=ch.uid WHERE c.became_member_at IS NULL) AS cardholders_not_member;
```

</details>


---

# 附录 B — 被证伪的发现（记录以免重复投入）

## B1. 生美业绩被父订单 status='已支付' 挡掉部分支付订单的已到账现金：漏 289,209 元（应有值的 9.5%），且历史月份数字会随订单状态翻转而事后变动

证伪理由：我按四步证伪，代码与数据两条都证实了原告，但规范依据这条塌了——而它正是本发现的立论基础（原告自己写的是「文档自身两条规则打架，应向 metrics.md:37 收敛」）。

证伪点一：metrics.md:36 的「不得用父订单 status 过滤」被 blockquote 标题显式限定了作用域。该 blockquote 起于 metrics.md:18「**组织层级业绩的归属规则**」、止于 metrics.md:52，全程讲 sale_order_performance_events。段内 metrics.md:43 的小标题直接写着「**组织层级业绩 vs 生美 / 品项 / 员工归属为何不同**」，metrics.md:51 把「相关报表常按父订单状态过滤」列为四条实打实差异之一。同样的「逐指标分别登记父订单闸门」贯穿全文：metrics.md:523「这四项**不**按父订单 status 过滤」（admin 工作台 #140）、metrics.md:751「周期统计**不要求** so.status='已支付'」（复购）。所以文档不是自相矛盾，而是按指标族分别声明——原告把组织层级业绩章的纪律跨章套到了子项类指标上。

证伪点二（决定性）：sale_item_performance_events 视图根本没有 status 列（见 dataEvidence【3】）。全文档其余每一行写款项级状态时都带别名前缀 `spe.status`（metrics.md:13/96/113/331/391/516/517/540 …），唯独 metrics.md:14 生美业绩那行写的是裸 `status='已支付'` 且数据源列注明「JOIN sale_items + sale_orders」。既然 sipe 无 status 列，这个裸 status 只能解析为 sale_orders.status。也就是说：权威定义表**明文要求**这个父订单闸门，代码与规范逐字一致。同时原告的建议修法（按 sipe 所属款项 status 过滤）不可实现，且款项级 status 过滤早已内建在视图的 paid_receipts CTE 里——这说明原告没读视图定义。

证伪点三：这条闸门是双谱系评审之后主动写进文档的，不是遗漏。git show f72a3b26（docs(metrics): 按 round-2 双谱系订正过度概括与三处失实 #142）commit message 原文：「**P2（codex 独有）· round-1 第 5 条改过头**：我写『三者差异只剩统计粒度和充值单』，实际还有储值卡抵扣/legacy 排除、**父订单状态过滤**、spia.is_void 与是否已分配、以及服务提成根本不走款项事件等差异。已列全。」即：评审明确识别出父订单状态过滤的存在，判定为真实差异并登记入文档，而非判为缺陷。

证伪点四：这不是 sales.ts 的一处孤立写法，而是「子项类」指标族的一致规则。metrics.md 变更记录 2026-09-14（#137）把金额类指标分流为「业绩/现金流类走 spe.performance_date」与「**子项类**（生美业绩、产品出库、品项周期业绩）走 sipe.performance_date」两族；该族内多处同样带父订单闸门：metrics.md 品项章「小美客产品出库 … so.sale_order_type IN ('销售单','转换单') ∩ **so.status='已支付'**」、admin product.ts:142 与 :303、staff 端 mgmt-dashboard.js:236（admin sales.ts 是 1:1 移植，两端零漂移）。

另外两处削弱原告表述：(a) 生美占比不是看板指标（sales-board.tsx KPI_ITEMS 无比值项），「比值失真」在 UI 上不成立；(b) 总业绩含充值单而生美业绩不含（metrics.md:43-44 明文），两者本就不可直接相比，不是本闸门造成的。

残留的真实议题（我不否认）：生美业绩采「已结清单」口径，确实导致历史月份会随订单结清或整单退款而事后变动（2026-09 单月 157,505 元，占该月应有值 12.1%；13 张 7 月单至今未结清，非纯粹时间差）。但这属于「口径选择的后果」，代码没有违反任何已登记规则，也没有算错任何一个已登记指标的值。按裁决标准，原告读错了规范依据、提出的修法在 SQL 上不可实现，且该口径经评审登记为设计差异 —— 判 REFUTED，残留议题降为 P3 产品确认项。

## B2. 人均 KPI 的分母漏掉 27 名无门店直挂的在职产能员工，而同一板块的员工榜把他们列了出来，人均实耗虚高 18%

证伪理由：证伪路径三条，三条都成立：

(1) 原告混淆了「产能技师」与「产能员工池」两个定义。分母指标 employeeCount 的定义（notes/references/metrics.md:161）显式含 `skills && ARRAY['美容师','养生师']`，metrics.md:99 还写明理由「管理层观察的是产能员工的人均产出；推广师虽享提成但人头不计入员工数」。原告口中的 27 人里有 17 人（品项老师 16 + 推广部 1）不带技师技能，按定义本就不该进分母。真正被"漏掉"的只有 14 人，其中 10 人当期有产出。因此断言里的「27 人 / 102 万元 / +18%」在数据上不成立。

(2) 「2026-09-03 放宽只落到榜单池、两处未对齐」的因果叙事不成立。`git show 827ff6a0 -- fengyu-admin/src/actions/data-center/efficiency.ts` 对 qTechnicianCount 零改动（grep `TechnicianCount|skills &&|技师` 的 +/- 行为空），分母口径自 2026-04-25 T3 起未变；而这些直挂员工的产出一直都在 Part A 的门店实耗分子里（分子是 service_items ∩ so.store_id，从来不看做事的人挂哪）。也就是说所谓"分子含他们、分母不含他们"在 2026-09-03 之前就已如此，那次提交没有改变任何人均数字。

(3) 「板块内部自相矛盾」被错误归因到 store_id。榜单池自 2026-05-20 起就**完全去掉了 skills 过滤**（mgmt-dashboard.js 注释：skills 在 1174/2020 条档案为空，按 skills 门控会漏算 33% 业绩），所以员工榜本就包含店经理、销售、品项老师等大量非技师——KPI 说 150 人而明细列出 ~310 行，主因是这个已拍板的差异，不是 14 名无门店技师。staff 端 mgmt-dashboard.js:962 更是逐字写明「metrics.md employeeCount 指标仍保留 skills 过滤（语义是"产能技师在职数"，与 ranking 候选池语义不同）」——两个池语义不同是明文设计意图。

残留的真问题（不足以支撑本条发现，但值得登记）：14 名直挂技师（养生部 12 + 品项公司 1 + 1 例档案 store_id 缺失）的产出确实在门店实耗分子里而人头不在分母里，放宽后人均实耗会降 8.5%。但这属于「产能技师在职数」该按"档案挂点"还是按"实际产出地"计头的业务口径选择：代码与 metrics.md:161 逐字一致、两端镜像、有字面量守护，改它要产品拍板，且 byMarket/单店视角下无门店员工无法归到任何单店（orgAnchorScopeSql 在 scope=store 时恒 FALSE），修法本身也需要定义。按「代码行为清楚、口径由业务定」的标准，这最多是一条 P3 的口径登记项，而非原告所述的 P2 数据错误。

## B3. 员工排行榜「新会员」只覆盖 20.8% 的新会员，与同页门店排行榜「新会员」合计相差 4.8 倍

证伪理由：我按四步做了证伪尝试：

一、读原文上下文，查原告有没有漏看上游过滤或兜底分支。
读了 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/efficiency.ts:444-457（qStoreRankNewMember）与 :579-597（qStaffRankNewMember）、:700-707（byStaff 的 new_member_by_emp，同一 CTE 复制）。原告对 SQL 的引用准确，无上游兜底、无 UNION「无归属」行。这一点原告没读错。

二、去 prod 复算，两个口径各算一遍。
数字全部复现：149 vs 31，差 118 人。但我额外算了两件原告没算的事：(a) 代码实际输出（含 producer_employees 与 value>0）仍是 31，说明代码没有在文档口径之外再丢人；(b) 按月覆盖率趋势，1-7 月是 56~64%，原告选的 9 月 20.8% 是历史最低点。用最低点的 1/4.8 去描述常态，夸大了约一倍。

三、查守护。consistency.efficiency.test.ts:175-186 双端锁死该口径，说明是被主动保护的约定。

四、查是否设计意图。这是决定性的一步：原告引用 metrics.md:118 作为「规范依据」，但那一行说的正是代码在做的事——原告实际上引用了一条**支持代码**的规范，却把结论写成「口径与文档不符」(P2)。staff 端注释里「本接口不展示」五个字更是把「不披露」本身也拍板了。同一文档还为实耗的「员工榜合计 ≠ 门店榜合计」明文背书，本条与之同型。

五、额外证伪：UI 上根本不存在被指控的对比场景。
读 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/app/(main)/(analytics)/data-center/_components/ranking-board.tsx:39-51，排行榜只有 排名/名称/所属市场/数值 四列，**无合计行、无总数、无占比**；读 .../efficiency/efficiency-board.tsx:97-115，两张榜分属 store-rank / staff-rank **两个互斥 Tab，永不同屏**。原告所称「合计相差 4.8 倍」是需要人工把所有行加起来、再切 Tab 加一遍才能得出的数，看板从不呈现任何一方的合计。「同页同名」在 Tab 互斥下的误导性远低于描述。

综合判定 REFUTED，理由三条且任一条独立成立：
(1) 不存在错误数字——榜上每一行「某员工纳客 N 人」都正确，无扇出、无重复计数、无 scope 泄漏、无时间轴错位，不满足本次审计「只报会让看板数字出错」的门槛；
(2) 不存在口径冲突——代码 == 文档 == 跨端注释 == 守护测试，四者一致，P2 的「与文档不符」定性事实错误；
(3) 残余诉求（「看板应加无归属披露脚注」）是产品增强需求，且 staff 端注释已明确拍板「本接口不展示」，需产品重新拍板才能推翻，不属数据准确性缺陷。

保留的不确定性（故未给满分 REFUTED 信心）：bound_employee_id 覆盖率从 7 月 63.5% 断崖跌到 9 月 20.8%，这个**趋势本身**值得警惕——它可能意味着 8 月起某条写入链路（如换店清空、或新客建档流程变更）在批量丢绑定。但那是上游数据质量/写入链路问题，与本条被指控的取数 SQL 无关，应另开单追查。

## B4. 「全部品项」默认视图下，体验人数与新增人数互相重叠 296 人，违反规范的「体验 ∩ 品项进入 = ∅」

证伪理由：证伪路径三条，三条都成立：

A. 规范作用域被误读。metrics.md:752 的「体验 ∩ 品项进入 = ∅」写在「品项顾客周期子页」章节里，紧挨着的 CTE 链每一处分组键都是 product_kind，metrics.md:826-827 的 trialCount/newCount 也都显式带 `per product_kind` 后缀。这句断言的论域就是 (顾客, 品项) 对，代码在该论域下 100% 满足（prod 实测 pair 级交集=0）。原告把一句 per-kind 的互斥断言搬到 person 级去检验，规范从未在 person 级作此承诺——原告自己也承认「规范未定义跨品项折叠后的语义」，那就不存在「违反规范」。

B. 因果链是错的。原告断言「admin 把它折叠成单个标量 → 于是重叠」。实测反证：换成 pair 折叠（318 / 502）重叠更大。重叠的唯一来源是「跨品项聚合」本身，不是 COUNT(DISTINCT)。staff 端那张 per-kind 表若把两列竖着加起来，同样是这 296 人。所以 product.ts:262 的 `COUNT(DISTINCT c.client_user_id)` 不是病因。

C. 现有折叠反而是唯一与卡片标签自洽的那个。同一组 KPI 里的 cardHolders（product.ts:127-140）用的是完全相同的跨品项 DISTINCT-person 折叠，而 cardHolderRate = 持卡人数 ÷ 会员数，一旦改成 pair 计数这个百分比会直接冲破 100%。既然「持卡人数」在「全部品项」下必须去重到人，「体验人数/进入人数」标的是「人数」而非「人次」，同样只能去重到人。改成 pair 折叠才是引入新错误。

D. 无任何消费方把两张卡相加。全仓 grep trialCount/newCount：只有 product-board.tsx 的 KPI 卡、columns.ts:98-99 的明细列、product.ts 内部。KPI 区标题是「体验 / 进入 / 复购」（不是原告说的「客群周期」），8 张卡 4 列网格，trialCount 与 newCount 只是其中第 1、2 张；明细表/导出只做同列纵向合计，没有任何「体验+进入=本期触达」的派生列或文案。「用户自然把它们当互斥人群相加」是原告的推测，代码里没有对应物。

残留的唯一真实瑕疵：「全部品项」下两条 hint 文案（product-board.tsx:21-22）省略了「在某一品项上」的限定语。这是 tooltip 措辞，不是数字错误，且本次审计明确不收命名/文案类问题。故定 P3 并判 REFUTED。

## B5. 人效板块员工排行榜/明细的金额 CTE 没拼 scope，门店账号看到员工在别店挣的钱

证伪理由：证伪路径与结果：

A. 代码是否被读错 —— 没读错。efficiency.ts:531-757 六段金额 CTE（revenue_by_emp / consume_by_emp / new_member_by_emp / project_by_emp / sales_comm+service_comm / qStaffDetail 五段）确实只按 employee_id 全库聚合，scope 只作用在 producerCte(:498-529) 的员工池上。调用方也没有兜底：context.ts 的 validateScope 只校验"UI 选的 scope 在不在权限内"，不改 SQL。单店 manager 的默认 scope 由 scope-options.ts:21-24 直接落到 {type:'store'}，暴露路径真实存在（prod 有 38 个门店级 manager 持 admin 密码，鸿蒙店 2 人）。

B. 是否属于已拍板的设计意图 —— 是，且证据链闭合。
   · metrics.md:110-117「员工排行榜归属」6 个指标的公式列**没有任何一条带 store 谓词**，scope 唯一出现在 :145「产能员工范围 … ∩ scope」，即约束员工池。
   · 原始 ticket notes/tickets/archives/2026-04-25-mgmt-staff-ranking-api.md:527-552 的验收标准把 scope 整节命名为「**员工范围过滤**」，权限条目写的是「market → 仅返回自己 scopeStoreIds 内门店的**员工**」，对金额零要求。
   · 原告援引的 metrics.md:464「提成两表…JOIN 后用 store_id 命中 scope 子查询」位于「scope（市场/门店）过滤」一节的机制脚注，讲的是"当你要 scope 这两张表时该怎么拿到 store_id"，服务的是组织层级业绩/销售提成收入这类**门店层**指标；它不是对员工榜的逐指标要求。原告自己也承认 :145 只约束员工池——那就没有第二条规范支撑"金额侧必须加"。
   · 2026-09-03 的池放宽（两端镜像，metrics.md:130-146 + efficiency.ts:491-496 + mgmt-dashboard.js:966-981 注释）是最强反证：团队明知这批人的分配额来自别人的门店，选择的是"放宽谁能上榜"，不是"按门店切金额"。语义模型就是 **scope 决定谁出现，归属决定数字**。
   · 语义自洽性检验：员工榜「收入」列 = 该员工实拿的销售提成+服务提成。若按 scope 切，一个去别店支援的养生师会看到低于自己实际提成的数字——那才是明确的错数。

C. 两端同源 —— staffApi mgmt-dashboard.js:1035-1061 及其余 5 个 metric 写法完全一致，说明是统一设计而非某端手滑。

D. 守护 —— 确实没有（见 guardedByTest），但"没守护"不等于"是缺陷"。

结论：数字差异真实存在且我逐分复现了，但把它判为 bug/越权站不住：代码与成文规范一致，规范依据是误读，附带影响（人均 KPI、两榜对账）是过度主张，且原告建议的改法会推翻已拍板的 2026-09-03 口径。残留的是一个 P2 呈现问题——门店级店长把"员工榜业绩"误读成"我店业绩的员工拆分"时会偏高（鸿蒙店 66.5%），值得产品拍一次板，但不是数据算错。越权定性也不成立：返回的行全部是 scope 内的员工，没有任何 scope 外的实体/门店/订单被暴露，跨市场越界金额（store_id 非空口径）实测为 0。

## B6. 销售板块「新增会员业绩」的 became_member_at 只写了下界没写上界，基期与历史区间被未来入会的顾客灌水

证伪理由：证伪路径与结果：

**第一步：核对原告引的规范条文是否管辖本指标 → 引错了。** 原告引 metrics.md:570 的时间窗口缩写表，据此推出「闭区间双边」。但那张表是全局缩写定义，而本指标（sales.ts:133 注释自述「新增客业绩（=新增会员业绩）」，UI 标签见 `columns.ts:119/135` 为「新增客业绩」）归 §「销售数据页 — 分客型业绩」管辖，该章节在 metrics.md:661/664 用整整一行 + 一个 worked example 把单边 `>=` 和「含期间结束后才入会的顾客」写死。规范内部并不矛盾：缩写表给通用语义，专章给本指标的覆写。原告只读了前者。

**第二步：查是不是「规范写了但没人拍板」→ 是拍过板的，而且是反向改的。** `git log -S` 定位到 commit 76c36d90（2026-04-25），diff 显示该次变更**主动把规范从 BETWEEN 改成 `>=`**。所以原告提议的「修复」其实是回滚一次已生效的产品决策。

**第三步：查「隔壁板块写的是 BETWEEN，两板块口径不一致」是否成立 → 不成立，是两个不同指标的张冠李戴。**
- 销售板块 `newCustomerRevenue` = **分客型业绩**（把总业绩按当前快照切成 小美客 / 新增会员 / 老会员 三桶，三者之和 ≤ 总业绩），定义在 metrics.md:661-671，用 `>=`。
- 客量板块 `queryNewMemberSpend`（customer.ts:378）= **新增会员对应消费**，定义在 metrics.md:390-391 的 §5「新会员经营」，用 `BETWEEN`，因为它必须与同章 `newMemberCount`（customer.ts:365，metrics.md:390 同样 BETWEEN）构成分子/分母配对去算「新增会员客单价」。若把它改成 `>=`，分子分母的人群就对不上了。
两者是不同指标、不同章节、不同用途，各自的写法都与各自规范一致。「同一群人给出不同数字」是设计上就允许的——规范 metrics.md:413-414 还专门为 newMemberSpend 登记了 D-3=A 决策。

**第四步：去 prod 实证 → 金额差确实存在，但差额的来源正是规范点名要纳入的那群人。** 三个区间跑下来，7 月 +14,942、8 月 +43,587、9 月当期 +0，趋势完全符合「单边 `>=` 在 end<今天 时纳入未来入会者、end=今天 时恒等」的数学预期。顺带发现原告的 8 月数据有硬伤：声称「来自 1 名 8 月 31 日之后才入会的顾客」，实测是 22 名顾客 / 14 家门店，原告这条数字是错的。

**四条独立证据（规范条文、git 反向变更记录、代码注释引注、守护测试逐字锁定）互相印证，且跨端 staff 实现同构。** 判 REFUTED。不判 UNCERTAIN，是因为「哪个口径才对」并非悬而未决——业务方已在 2026-04-25 明确从 BETWEEN 切到 `>=`，并在规范里用例子固化了该行为的反直觉之处。

## B7. 「持卡人数」用 paid_sessions>0（累计已解锁次数），与页面两处明文「未用完疗程卡」矛盾，多算 669 人

证伪理由：我按四步逐条尝试证伪：

① 读代码上下文。/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/product.ts:140（queryCardHolders）与 :301（queryCardHoldersByStore）确实是 `AND si.paid_sessions > 0`，上游没有别的 CTE/WHERE 兜底，调用方也没有二次过滤。product-board.tsx:17/18/122 三处文案确实写「以当前时刻未用完疗程卡为准」。原告对事实的描述没有读错。

② 库里复算。两个数字一字不差复现（4804 / 4135），但复算同时暴露了原告口径自己的三个缺陷（见 dataEvidence 第 2 条）：漏 2393 行 NULL、复活 82 行已退/未付卡、凭空加 2 人。所以「4135 才是真值」不成立——它既不是「当前还有卡可核销的人数」，也不比 4804 更接近那个语义。

③ 查守护。/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/__tests__/consistency.product.test.ts:64 有一条显式反向断言：`it('两端持卡查询不再按 remaining_sessions > 0 过滤')` → `expect(adminCode).not.toMatch(/remaining_sessions\s*>\s*0/)`，admin 与 staff 两端同守。原告建议的改法会直接把这条守护测试打红。

④ 查设计意图。git log 命中 83eaa9fa（2026-07-22）`fix(metrics): 持卡人数口径改为 paid_sessions>0（三端同步）`——正是把旧定义 `product_type IN ('疗程卡','单品') AND remaining_sessions > 0` 主动废弃、换成 paid_sessions>0，admin + staffApi + metrics.md + 三份 snapshot 测试一次性同步。notes/references/metrics.md 的变更记录行也被同步改写为「持卡=截面快照（paid_sessions>0）」。另有 c8566ff9（#122，2026-09-13）在提交正文里写死了原因原文：「退款不减 remaining_sessions（Model X，见 utils/refund.js），paid_sessions 才是『已退卡从卡包消失』的唯一机制。把门槛换成 remaining_sessions 等于拆了它——dev 实测 87 行已退款卡会重新出现并被标成待付清，伪造 ¥118605 债务」，且第 3 条陷阱明确写「admin 卡包基础集不能按次数过滤……若顺手加 remaining_sessions > 0 会与 status='exhausted' 互斥」。

结论：这不是「规范 vs 页面文案二选一、待拍板」，拍板在 2026-07-22 已经发生并留下了三端代码 + 文档 + 反向守护测试；数字（4804）与唯一权威口径 metrics.md:726 一致，也与 staff 端 mgmt-product.js:143 一致，看板上的数没有算错。真正残留的只有 product-board.tsx 三处未跟着 83eaa9fa 更新的过期文案（沿用 2026-07-22 之前的「未用完的疗程卡」措辞）。「多算 669 人」的指控因此不成立——那 669 人按已拍板口径本来就该算进去。

## B8. 人效板块员工榜与技师人效明细的 5 个指标 CTE 完全没有 scope 过滤，只有员工池被过滤

证伪理由：证伪路径分四步。第一步逐行读 `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/data-center/efficiency.ts:498-757`：原告对**代码事实**的描述是准确的——`producerCte`（:498-529）把 `scopeFilterSql`/`orgAnchorScopeSql` 加在 `producer_base` 上，而 `revenue_by_emp`(:533-544)、`consume_by_emp`(:557-568)、`new_member_by_emp`(:579-586)、`project_by_emp`(:599-613)、`sales_comm`/`service_comm`(:624-645) 以及 Part E 的 `revenue_by_emp_cat`/`consume_by_emp_cat`/`service_count_by_emp`(:669-735) 的 WHERE 里确实没有 `so.store_id` / `so2.store_id` 的 scope 条件，也没有上游 CTE 或调用方兜底（`prepareBoardContext` 只解析 scope，不注入 SQL）。所以这不是「读错代码」。
第二步查口径归属。原告的规范依据 metrics.md:465「提成两表无 store_id 列 … JOIN 回订单表后用其 store_id 命中 scope 子查询」被**误用**了：该句在「scope（市场/门店）过滤」通用章节，说的是「当一个指标需要按门店 scope 时，提成两表该怎么 scope」（对应 Part B 的 `salesCommByStore`/`serviceCommByStore`），它没有规定「按员工分组的指标也必须按订单门店 scope」。而同一份文档的员工榜专章（:104-146）把 scope 明确且唯一地挂在产能员工池上，指标表筛选条件列里一个 store 条件都没有。
第三步查是否已拍板。2026-04-25 的 staffRanking API ticket §5 风险表逐字列出了「同一员工跨多店服务」这个**完全相同的场景**，并给出了结论（按 employee_id 分组、门店列只作展示）。这不是「没人想过」，是「想过并选了跟人走」。2026-09-03 的无门店员工放宽（metrics.md:131-141）在结构上进一步锁死了这个选择。
第四步去 prod 实证，同时尝试从数据上推翻「这是个无害的设计」：结果是数据既支持也削弱原告——跨市场泄漏**确实存在**（实耗侧王志军 46 行/17,092.81 元，原告漏查），但「员工榜与门店榜对不上」的主因不是跨店（82,955 元），而是被设计性排除的无门店员工（1,037,674 元，12.5 倍）+ role_type 重复计（已登记 +25%）。
综合：代码行为与文档、ticket、跨端镜像、快照守护四者**完全自洽**，属「反直觉但故意」的既定口径，不构成看板数字错误。裁定 REFUTED，并把定级从 P3 下调为「非缺陷，仅可选的产品确认项」。唯一我认为还值得登记但不足以翻案的一点：跨市场那 1 人 6,055.09 元/月 会出现在「南昌易大师」市场视角——但按既定口径，那本就是该市场自己员工的产出总额，且 ticket 已把「跟人走」定为语义，不构成越权。

## B9. 寄存单迁移单把「品项」板块的新增/复购/客单价整列打歪（8 月新增人数虚高 3.8 倍）

证伪理由：我按「默认是误报」的立场去证伪，先打的是原告最硬的那句规范依据：「文档从未登记…也未规定新增人数分母含寄存、业绩分子不含寄存」。这句是错的，而且错得很彻底。

原告只引了 metrics.md:866-870（那是「二级品项 category_name 粒度」小节，讲的是一级/二级同构，和寄存单无关）和 :644。真正的权威章节在 metrics.md:729-836「体验 / 品项进入 / 复购」，那里把被指控的两半不对称**逐字登记**了：
- :741「entry qualifying day（进入达标日）= 销售单/转换单/**寄存单** 的 SUM(sipe.amount) … ≥ new_member_threshold」
- :742「repurchase qualifying day … 同一分组下**仅汇总销售单/转换单** … 寄存单金额不参与，不能触发复购」
- :749「寄存单只用于进入基线，**不计入体验/进入/复购的区间业绩**」
- :771 文档里的参考 SQL 原文就是 `AND so.sale_order_type IN ('销售单','转换单','寄存单')`
- :792 `period_agg AS ( -- 期内真实购买每日聚合（**排除寄存金额**）`
- :835「**新增人数 = 品项进入总人数**：…寄存单承载 WorkFine 历史实收时，**只作为进入基线的兼容数据**」
- :836「各类业绩口径：…（非仅达标当日，**排除寄存单**）」
文档第 771-800 行的 CTE 与 product.ts:185-251 的实现是字面同构的（连 HAVING、purchase_received FILTER、period_agg 的 `purchase_received > 0` 都一样）。所以这不是「实现偏离文档」，是「实现就是文档」。

第二，查沿革：`git log -S` 定位到代码 d8f38bd9「fix(admin): 修正商品一致性指标查询」（2026-08-17 10:56:16）与文档 941e18be「docs: 更新数据指标口径说明」（2026-08-17 10:56:19）相隔 3 秒，同一次作业提交。该 commit 的 diff 明确把 daily_agg 从 IN ('销售单','转换单') 改成加入 '寄存单'，同时新增 repurchase_qualifying_days 并把 period_agg 切到 purchase_received——即「分母含寄存、分子不含寄存」这个不对称是这次改动**刻意引入**的，头注释写死了：「寄存单只作为进入基线，不能触发复购」。原告把一次有意的口径拍板读成了漏网之鱼。

第三，跨端核对：staff 端 fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js:205「寄存单只参与首次进入基线；复购达标与区间业绩只统计销售单/转换单」+ :254 同样的 IN 列表——两端镜像，不是 admin 单端漂移。

第四，UI 口径核对：原告标题写「新增人数 newCount」，但品项板块 KPI 卡的实际文案是「**品项进入人数**」，hint 是「首次达标日落在区间内」（product-board.tsx:22），复购率 hint 是「复购人数 ÷ 品项进入人数」。看板显示的定义和计算完全一致，不构成误导。「新增人数」只是 byMarket/byStore 明细表的列名简写（columns.ts:99）。

第五，我试着从另一个方向翻案：如果寄存单的日期本应是历史购卡日、只是被 #137 改坏了，那仍是 bug。但 4(3) 的实测把这条路堵死了——9709/9709 的 sale_order_datetime 就等于 created_at 日期，库里压根没有历史购卡日可用，任何时间轴选择都只能落在录入日。所以这不是「走错时间轴」，而是「数据本身只有这一个日期」。

剩下的唯一真问题是：把 WorkFine 存量卡迁移日当作顾客的「品项进入日」，会让 2026-07~09 三个月的进入人数被迁移节奏主导（8 月 1384 vs 反事实 363）。但这是既定口径在迁移数据上的必然结果，不是代码算错；要不要为迁移期另设一个剔除寄存单的视图，属于产品拍板，不属于「看板数字算错」。按本次裁决标准（原告读错规范依据、误解已拍板口径），判 REFUTED。

## B10. 客量板块「沉睡 / 冰冻」两档恒为 0，「休眠」69 人语义错标 —— 到店历史只有 76 天

证伪理由：我按「默认误报」立场做了四轮证伪，三轮命中，原告的数据都对但定性错了。

第一轮 —— 查「语义错标」是否属实：REFUTED。原告断言「cron 把从未到店的会员打成休眠，看板会被读成 12 个月以上未到店」。但 notes/references/metrics.md:320 的规范原文就是 `-- 休眠：a.last_dt < ($startDate-1 - 12m) OR a.last_dt IS NULL` —— NULL（从无到店记录）归入休眠是写进口径文档的明文规则，不是实现擅自发挥。截面侧同理：refresh-customer-status.ts:10 文件头注释白纸黑字「段 3：会员客但完全无到店记录的，置 '休眠'」。原告在「代码证据」里自己引用了 RESET_NO_VISITS_SQL 和这条 CASE，却把规范当成了缺陷。

第二轮 —— 查看板是否真的做了「12 个月」这个断言：REFUTED。读 fengyu-admin/src/app/(main)/(analytics)/data-center/_components/customer/customer-board.tsx:23-28，KPI_STATUS 的 label 只有裸文案「沉睡人数 / 激活沉睡 / 冰冻人数 / 激活冰冻 / 休眠人数 / 激活休眠」，三档都没有 hint 字段（同组件里 operatedMembers / convRate / consumePerVisit 才带 hint）。看板上不存在任何「12 个月以上未到店」的文字。这个语义是原告自己推导出来再判它错的，属于给被告栽了一句它没说过的话。

第三轮 —— 查是不是代码算错了数：REFUTED。queryStatusCount（customer.ts:175-189）就是 COUNT(*) FROM client_wechat_users WHERE scope AND customer_status = $1，沉睡档额外加 customer_type='会员客'，与 metrics.md:249-253 表格逐字一致。没有 JOIN 扇出、没有 scope 泄漏（走 scopeFilterSql(session, scope, 'c.bound_store_id')）、没有日期边界问题、没有负数行漏算（本指标不涉金额）。0 和 69 都是定义在当前数据上的正确取值。formatCount(0) 返回 "0" 而非 "--"，所以确实会显示 0，但显示 0 是真实的：库里确实一个会员都没有连续 3-6 个月未到店。

第四轮 —— 查是否已拍板 + 是否自愈：REFUTED 加固。metrics.md:630 记载 2026-04-25 七决策点拍板 D-1=C（本月激活实时反推，anchor 展开），D-6=B（枚举重命名 '预警沉睡'→'沉睡'），正是这套分档逻辑的拍板记录。git log 显示 refresh-customer-status.ts 只有两次提交（b951ae97 从 client 云函数原样迁入 + 29a7bb5e 接时间注入），逻辑自迁移以来未动。再加上第 4 组复算证明沉睡档 2026-10-10 就会自愈，不需要任何代码改动。

唯一让我犹豫的是第 5 组复算跑出的 deep=284 —— 284 个人被标成「激活休眠」（暗示找回了流失 12 个月以上的老客），而实际只能证明他们 7-8 月没来过。这比原告报的 69 人更容易误导决策。但我仍判 REFUTED，因为：(a) 它是 metrics.md:320 那条 NULL→休眠 规则的忠实执行，属已拍板口径而非计算错误；(b) 284 这个人数本身是对的（这些人确实在 9 月回流且前 90 天无到店），错的只是"流失深度"这一档位标签的可解释性；(c) 它和沉睡档一样会随数据积累自然改善。

综合定性：原告发现的是「76 天的数据集上，基于流失时长的分档指标暂时没有区分力」，这是 WorkFine cutover 时到店史未迁库造成的、位于数据中心上游的数据资产问题，不是数据中心的取数缺陷。按任务的裁决标准，这落在「原告误解口径」—— 他把两处明文规范（metrics.md:320 + cron 段 3 注释）读成了 bug，并给看板安了一句它从未显示的文案。残留价值只有一条文档欠登记（口径文档没写"当前到店史起点 2026-07-08，6/12 个月窗口尚不可计算"这个前提），这不是数字出错，故降为 P3。
