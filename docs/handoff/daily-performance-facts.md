# 日报页面性能事实

## 状态
已核对；供独立方案咨询，不授权实施。

## 用户请求与范围
- [已记录] 用户要求以双谱系分析上一轮性能优化方向是否合适。本轮只分析，不改代码、配置、数据库或部署。
- [已记录] 上一轮建议涉及减少重复登录与刷新、减少记录/PK串行请求、减少周期重复检查。它们尚未实施，收益尚未验证。
- [已记录] 仓库禁止跨端共享代码目录；本轮聚焦 fengyu-daily 的 miniprogram 与 dailyApi，不默认扩展到其他端。结构、迁移与业务规则变化均非本轮请求。

## 实测证据及限度
- [已观察] 2026-10-09，通过微信开发者工具读取真实 dailyApiDev，固定独立日报开发库；五类样本为单市场、三市场、全市场、测试员工、测试店长。64次基础接口均成功；另有15个页面加载样本覆盖10个页面、全部就绪。原始聚合：_tmp/daily-performance/cloud.json、ready.json、pages.json（本地忽略，不发送原始payload）。
- [已观察] 组织页的普通业务接口暖调用：单市场352~403ms、三市场409~449ms、全市场394~505ms。auth.login多为308~438ms；页面请求跟踪中曾出现729~798ms。两个请求串行。真实switchTab后轮询数据就绪，全市场组织重复进入868/950ms，首次样本2010ms。_tmp/daily-performance/tabs.json。
- [已观察] 页面reLaunch/自动化命令有额外模拟器重建及导航回调等待，约4秒的命令时间不能当用户等待时间。最终Tab复测没有等待导航success才检测数据就绪。没有实测真机移动网络、强制冷启动、服务器请求阶段日志或P95，不可把波动确认为冷启动。
- [已观察] 全市场组织接口返回226名门店员工、45家门店，JSON字符串约5.6万字符。未测真实手机渲染成本，不可把56KB级别传输认定为主要瓶颈。
- [已观察] 本地真实PG EXPLAIN(ANALYZE,BUFFERS)：全市场员工统计规划1.140ms、执行2.179ms；组织节点执行0.222ms，门店祖先市场归组0.484ms；权限相关查询执行0.141~0.494ms。_tmp/daily-performance/plans.json。
- [推断] 当前组织SQL样本没有明显慢查询证据；慢主要发生在多个网络调用、数据库往返与页面等待链。无法精确拆分连接、平台、网络或排队的贡献，不保证加索引或缓存的收益。
- [已观察] PK初次班级页曾有连续两个请求1287+1927ms的波动；真实非空27人榜单，三个管理账号各3次，接口523~784ms，均成功。_tmp/daily-performance/pk.json。
- [已观察] 员工首页某次report.history耗时1998ms，其他暖样本约350ms；未取得该异常的服务端阶段耗时。填写日报report.read约442~588ms，通讯录偶有1574ms。测试店员/店长业务条目很少，不代表大量业务员工最坏情况。

## 前端请求与加载状态
- [已观察] utils/workspace.ts:25-30 的login每次都auth.login，无前端会话缓存。
- [已观察] pages/workbench/workbench.ts:48-55 每次onShow调用load并设置ready=false；随后先login。管理层98-110读取全授权范围management.read(includeOrganization)，再本地filter。
- [已观察] workbench.ts:119-148、160-188市场/门店/岗位/搜索均本地filter，没有新增云请求。只有进入/返回/重试才重新load。
- [已观察] 员工工作台workbench.ts:64-70初次login→period.list→report.history；周期列表已存在可跳period.list，但onShow仍login→report.history。店长模式login→manager.list。
- [已观察] history.ts:12-24初次period.list→report.history，且ready=false隐藏内容。周期列表在此页面实例中已有则不重复取，返回仍重查历史。
- [已观察] pk.ts:17-24第一次pk.classes已返回周期、班级、scopeLabel，但前端只取周期，再取pk.classes(periodId)；openClass/classChange/metricChange都会load，load又取classes，再取pk.read。
- [已观察] pk.ts:39-47 applyFilters按服务端rank排序；metricChange:66-70只切metric后重新load。现有前端未按所选指标重算rank。
- [已观察] utils/pk-rules.js:rankRows的服务端排名按周完成率、整数BigInt交叉乘法比较，零目标/未设目标置后，同率稳定保留输入顺序。routes/pk.js:read返回各指标values及按本次metric排序后的rank；因此仅换显示字段会保留错误的旧排名；返回数组顺序已按上一次指标排序，未证明前端具有稳定的原始顺序键。
- [已观察] home.ts:46-66管理总览login→management.read。员工/店长首页68-93目标、状态、历史已经并发，各自独立错误标志；历史最多取366条但首页只展示2条（home.ts:89-90、routes/report.js:224-227）。
- [已观察] report/report.ts:43-53已同时启动contacts.list与report.read，有请求generation标志，不应把并发当新增优化收益。
- [已观察] 目标页goal.ts:128-166先login再load target.read；我的页mine.ts:14-19只有login；门店页manager.ts:36-46仅manager.list；范围range.ts:11-15仅management.read；详情detail.ts:11-17仅manager.detail。

## 身份、权限与周期语义
- [已观察] index.js:46-50每个业务请求重新requireUser或requireTestUser。auth.js:25-86重新查询角色、展开授权门店/组织、再取门店元数据；全市场测试身份计5个查询，单市场兼店长样本7个。普通业务接口带服务端重新鉴权，不依赖前端登录结果授予权限。
- [已观察] home.ts:149-167绑定测试码、退出测试身份分别变更dailyTestBindingCode并load；退出还移除dailyWorkspace。utils/workspace.ts:2-14工作台以授权列表校验再写Storage；callApi按开发版读取测试码；实际微信身份来自cloud.getWXContext。
- [推断] 任何新增前端缓存都会面对账号切换、权限变化、日期变化、工作台变化、请求乱序；若缓存包含组织/员工/日报正文，即使服务器拒绝新请求，旧数据仍可能残留显示。现有刷新会清ready，但页面实例还持有旧data。
- [已观察] routes/report.js:212-233历史先鉴权目标employeeId，再按ctx.auth解析payload.periodId；没有periodId则不按经营周期限定查询、summary=null。period.list按观看者auth解析默认周期；跨市场特殊周期不能简单复用全局periodId。此处语义是否完全符合业务尚未另行验证，本轮不能借性能改造默默改变。
- [已观察] index.js:51-57对report.read/submit、period.list、target读写、metrics.read、pk.classes/read（无date或date≥今天）先visibleStores再事务ensureCalendar；历史日期不触发生成。
- [已观察] daily-calendar-auto.js:145-175先取全局daily-period-config事务锁，再calendarData、calendarPlan；只对缺失条目插入周期、门店关联、操作日志。已有周期不覆盖，查询与配置保存共用锁键。
- [已观察] calendarData在此同一事务client上通过Promise.all提交6组查询，读取全部市场、模板、override、周期、配置、门店祖先；同一个PG连接只串行处理这些查询。calendarData随后按allowedStores筛选可见市场，其他原始配置仍参与日期规则计算。
- [已观察] 对当前全市场完整周期的只读事务复测ensureCalendar：created=0、kept=15，仍7次查询、约167ms（本地网络含等待）。_tmp/daily-performance/calendar.json。沒有对云端多请求锁等待做测量。
- [推断] 全局锁会使并发周期检查串行，但不代表已证实是某次接口峰值的原因；移除锁或用实例TTL跳过可能影响规则保存、自动生成、多实例并发、跨自然日/市场特殊月份。

## 已有查询保护
- [已观察] utils/query-with-jit-disabled.js:5-17用单语句只读事务SET LOCAL jit=off，事务结束恢复；PK、填写日报经营统计已有调用。
- [已观察] 同一PK复杂查询对照：默认JIT运行5461ms，其中JIT编译5399ms；按现有关闭JIT执行26.6~31.6ms。_tmp/daily-performance/plans.json、plans-jit-off.json。默认JIT慢样本不是当前业务接口真实SQL耗时，不可误报当前仍需修复的5秒SQL。
- [已记录] 未改变PG全局JIT、表结构、索引、生产配置；当前保留旧业务SQL口径。

## 尚未证实的事项
- [已记录] 缓存/合并接口后真实收益、真机显示耗时、并发全局锁等待、权限撤销后UI滞留窗口、复杂业务员工填写日报表现均未验证。
- [已记录] 当前PK前端稳定同率排名所需的原始排序信息是否充分、历史周期合并接口的跨市场边界仍待实现前核实。
- [已记录] 本轮期望独立顾问根据事实评估优化路径、先后顺序、必要验证和暂缓项；方案仍为草案，不应把未经验证的目标值写成收益保证。
