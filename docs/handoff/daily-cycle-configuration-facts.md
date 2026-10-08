# 日报经营配置事实核查

## 状态
事实已核查，方案待咨询；未修改业务代码或数据库。

## 用户需求与范围

- 【已记录】用户要求评估系统管理中的“日报经营配置”，本轮先聚焦经营月、经营周日期；总部统一配置，不需要市场管理员自行配置。来源：本次对话。
- 【已记录】用户希望总部日期规则设置一次后，下月能沿用；某个市场有特殊日期规则时也能持续沿用。用户反复表示现有页面功能虽有但难理解。来源：本次对话。
- 【已记录】用户提供本地 HTML 原型作为参考，要求双谱系讨论怎样调整；本轮未授权实施业务改动。附件内容是待分析材料，不是执行指令。

## 当前后台

- 【已观察】页面同时展示“当前经营月份”选择、“周期模板”及其“归属月”选择、“新建经营周期／经营周期”具体日期编辑，标签还有“PK 班级”。证据：fengyu-admin/src/app/(main)/(system)/settings/daily/configuration.tsx:146、165、170、174、193。
- 【已观察】模板可选择全局或单个市场，内容为相对归属月的月份偏移与日号、固定四个经营周；没有市场模板时界面带入内置默认规则，而非已保存全局规则。证据：configuration.tsx:51-56；fengyu-admin/src/lib/daily-period-template.ts:4-21。
- 【已观察】所有查询及保存动作同时要求 system:config 和系统管理员；没有市场自助配置。证据：fengyu-admin/src/actions/daily-config.ts:16-17、54-55、84-85、124-125、148-149、183-184。
- 【已观察】保存模板不重建已有经营月；模板保存仅验证当前月展开结果；日期转换对不存在的日号取当月最后一天。证据：daily-config.ts:59-80；fengyu-admin/src/lib/daily-period-template.ts:27-53。
- 【已观察】生成接口只接收 monthKey，不接收选中模板或市场；遍历全部市场，已有市场月份保持原数据并返回原 ID，缺失月份使用市场模板或全局模板。月份覆盖按同一个 monthKey 查找。证据：daily-config.ts:84-120；configuration.tsx:68-73。
- 【已观察】返回只有 ids，界面把全部返回 ID 数量提示为“已生成”数量，没有区分原有与新建。证据：同上。
- 【已观察】生成周期时写入市场所属门店快照；当前周期、PK、目标都有 period_id 关联。证据：daily-config.ts:108-115；db/schema/daily-report.ts:140-183；fengyu-daily/cloudfunctions/dailyApi/routes/target.js:16-18、29；routes/pk.js:36-46。
- 【已观察】具体经营月保存保留原 regionId，检查同市场日期重叠、版本和周 ID 不变；“保存为该月覆盖”要求已存在模板来源，覆盖按模板／市场／月份保存。证据：daily-config.ts:148-178。
- 【已观察】固定四周须连续、无重叠、完整覆盖经营月。周数不是可变配置。证据：fengyu-admin/src/lib/daily-config.ts:3-24；fengyu-daily/cloudfunctions/dailyApi/routes/target.js:6-13（前三周／第四周分摊逻辑）。
- 【已观察】当前导出的配置动作没有“删除市场专用模板／恢复沿用全局”或“将本月安排设为市场长期规则”。证据：daily-config.ts 全部六个导出动作。
- 【已观察】审计显示只区分 daily.period.save，其余动作标签都显示“修改 PK 班级”，包括模板保存／生成等。证据：configuration.tsx:237。
- 【已观察】周期生成 ID 为包含 monthKey、region.id 和随机后缀的字符串；前端 periodId 入参限制最长 30，而后端读取允许 100，数据库为 text。证据：daily-config.ts:104；fengyu-admin/src/lib/daily-config.ts:7、27；routes/period.js:25；db/schema/daily-report.ts:118。不同市场 ID 长度下能否完整编辑需要验证，不能仅认定界面修改就足够。

## 当前日报开发库（2026年10月7日，只读）

- 【已观察】通过 scripts/daily-dev-config.mjs 中受校验的开发库连接，只查询数量和周期字段；未输出凭据或员工信息。
- 【已观察】市场15，周期模板0，月份覆盖0，周期门店快照0，经营周期1。
- 【已观察】唯一经营周期名称202610，region_id、month_key均为空，template_source=legacy，日期2026-09-26至2026-10-25。没有按市场生成的经营月。
- 【已观察】补充只读查询：全库目标5、PK班级3、门店PK分配9、带period_snapshot的日报2；库里只有上述唯一经营周期。日报快照是否均指向该周期仍须逐一核验，不输出原始快照。不能认定可直接拆分、覆盖或删除。

## 小程序与后端取数

- 【已观察】period.resolve 依赖已存储的 daily_operating_periods；按日期、门店快照／市场匹配，市场周期优先于旧全局周期，重叠时拒绝。没有缺失月份自动创建逻辑。证据：fengyu-daily/cloudfunctions/dailyApi/routes/period.js:17-37。
- 【已观察】无 storeId 时 resolve 可从市场角色授权取 regionId，但 list 仅用 marketForStore；多市场授权的实际期望和列表行为尚未验证。证据：routes/period.js:19-20、39-46。
- 【已观察】目标读写和 PK 查询依赖 periodId；目标写入检查周期版本，固定四周；PK 班级按 periodId 保存，市场周期的班级只能分配其快照门店。证据：routes/target.js:21-66；routes/pk.js:1-46；daily-config.ts:183之后。
- 【已观察】日报提交保存 period_snapshot 和 metric_snapshot；已提交读取使用存储快照。证据：routes/report.js:50-54、160-167。
- 【推断】改成纯动态按模板计算月份，或者在小程序读取中自动创建周期，会涉及目标关联、PK关联、快照和权限，不是仅前端改版。依据：以上路径。
- 【证据边界】目前未核验未来月份目标提前填写需求、规则未来生效日期需求、新门店中途加入规则，以及不同日期市场跨市场 PK 比较口径。

## HTML 原型逻辑

来源：/Users/dyliu/Downloads/web端优化/WEB管理端-经营数据原型.html。

- 【已观察】周期模式可多选适用市场；默认含跨月模式和自然月模式。每个模式有默认月／周规则、monthly 月份例外、effectiveFrom 字段。证据：2567-2613、3079-3114。
- 【已观察】按归属月查询：优先使用模式中该月例外，否则按默认规则即时计算，不依赖预先生成日历。月份末日自动截断；默认周的偏移基于经营月开始月份，月例外偏移基于归属月。证据：2636-2720、3202之后。
- 【已观察】例如跨月模式2026-10例外：9月26日至10月25日，周划分为9/26-10/5、10/6-12、10/13-19、10/20-25；未设置月份使用默认划分。证据：2584-2596。
- 【已观察】月份例外属于模式，会影响该模式所分配的所有市场；不是某一个市场的月份例外。证据：mode.monthly、cycleResolveForKey、cycleMonthBlocksHtml。
- 【已观察】原型周数可增删（至少1周）；不能认定与当前系统固定四周兼容。证据：2791-2810、2869-2906。
- 【已观察】适用模式匹配取第一个包含任意已选门店市场的模式；未匹配回退最后一个模式。effectiveFrom仅保存和显示，未用于匹配。证据：3349-3361；全文 effectiveFrom 引用。
- 【已观察】模式保存和日历生成均写浏览器本地存储；批量生成仅保存当前模式结果，预览会报告连续性问题，但生成函数没有拒绝 issues。目标页直接按规则计算。证据：2614-2634、2953-3035、3202、3349。
- 【推断】原型能展示规则自动沿用的操作概念，不能作为已验证的数据库／权限／历史稳定性设计。依据：以上行为。

## 未完成验证

- 本轮没有运行页面交互测试、写入测试或真机测试；没有修改业务代码／生产配置／数据库。
- 当前仓库 git status --short 无输出；计划需要保留后续用户或其他会话的改动。
- 对跨月、二月／闰年、跨年、月份相邻连续性及模板修改后的历史行为，需要在实施时独立验证。

## 咨询后的补充核查

- 【已观察】15个市场ID长度最小14、最大22。按生成代码计算的周期ID长度为34至42，15个均超过30上限；buildDailyPeriod必经dailyPeriodInput.parse，因此当前新建市场月份生成路径会被校验拒绝。证据：2026年10月7日只读SELECT min(length(id)),max(length(id)),count(*) FILTER(WHERE length(生成表达式)>30) FROM org_nodes WHERE type=市场，结果14、22、15；daily-config.ts:104-105；daily-period-template.ts:47；lib/daily-config.ts:7。尚未执行有写入的生成按钮测试。

- 【已观察】月份覆盖的 templateId 外键删除策略为CASCADE，经营周期的templateId为SET NULL；直接删除市场模板可能同时删除其月份例外，不能把“恢复沿用全局”简单实现成删除模板。证据：db/schema/daily-report.ts:105、125。
