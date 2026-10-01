# 工作流迁移与积压整理（2026-09-29）

来源：`gh issue list --state all --limit 300`（返回 190 条）、
`gh pr list --state merged --base dev --limit 1000`（返回 141 条），仓库默认分支为 `main`。
当前 135 条 open，0 条 open PR。此报告只读 GitHub，没有批量关闭或修改已有 issue。

## 首要发现

96 条 open 单被已合入 dev 的 PR 正文显式声明 `Closes/Fixes/Resolves`。
这强烈提示积压的大头是关单生命周期，而非全部未开发；**PR 声明不等于验收证据**，
需逐项看差量、回归与 dev 当前实现再关。GitHub 默认分支是 main，合并到 dev 不会触发
默认分支上的自动 closing 行为（[GitHub 官方说明](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)）。新流程改用 `Refs` 并明确合并后核验关单。

其次是重复、review 建议派生和技术步骤拆单：#327 与已关闭 #328 同现象；
#230–#233 是图片链路同族，当前其中三条已有关联 merged PR，不能直接重新打包开发；
#237 / #311 来自范围外维护项。#367–#375 的报表系列把骨架/组件拆成单，后续通常应放
功能单正文，独立可验收页面仍可分单。

## 新流程

- Codex 开发、四维自审；GLM + OpenCode 和 DeepSeek + Claude Code CLI 独立评审。
- 评审固定快照与结构化结论，禁止工具操作；范围内 P0/P1/P2 必须闭环。
- 未定需求和范围外建议留本地 backlog；一项业务交付一个 issue，跨端步骤放 checklist。
- sweep 先筛已完成/在途/待决，再按影响与依赖开发；同根因旧单可归并一个 PR。
- 不自动制造 umbrella/子 issues，不自动 merge、关单或部署。

## 调用与本机验证

仓库现有 `.agents/skills -> ../.claude/skills`，三个 skill 已原位升级，没有复制出第二份。
Codex 通过该目录发现 skill（[官方 skill 文档](https://learn.chatgpt.com/docs/build-skills)）。

```text
$req-to-issues notes/meetings/meeting-20260914
$issue-dev 453
$issue-sweep bug
$issue-sweep 仅整理积压，不开发
```

独立评审细节在 `.agents/skills/issue-dev/references/review.md`，执行脚本为
`.agents/skills/issue-dev/scripts/dual_review.py`。Codex 负责准备验收、相关文件全文和验证证据，
脚本自动补齐完整提交 diff，两路都禁工具调用；材料不足需补齐复审。
初次迁移探针已通过（历史记录，DeepSeek 当时为 V4 Pro）：GLM `zhipuai-coding-plan/glm-5.3`；Claude Code 模型记录 `deepseek-v4-pro`。
7 项测试覆盖结构化返回、静默错误、超时、DeepSeek 凭证隔离、快照和退出状态；
三个 skill 的 quick_validate 和 shell 语法检查通过，隔离 fixture 从子目录创建 worktree、
5 处 node_modules 软链实测通过。隔离真实评审样例中，故意删除负金额校验，两路均报 P1，脚本返回 2；修复后两路均 complete / 零 finding，返回 0。记录在 `_tmp/workflow-migration/review-fixture/rounds/`。原有业务文件改动保留，未修改全局账号设置。

用户随后指定最终组合：GLM-5.3 + DeepSeek-V4.1-Flash。脚本默认模型已相应更新。V4.1 Flash 的官方 API 名为 `deepseek-flash`，两路新探针均已通过，结果位于 `_tmp/workflow-migration/probe-flash/`；7 项测试再次通过。

用户进一步指定 Claude Code CLI 默认模型为 `deepseek-flash[1m]`，脚本和评审说明已同步。

## 当前单量分类

- 开发候选：29
- 待核验关单：96
- 本轮涉及：1
- 维护候选：3
- 待决：5
- 疑似重复：1

## 全部 open 单初筛

以下分类是初筛，待核验关单需要验收证据；开发候选需要调研，待决需要最新评论。

| issue | 标题 | 动作 | 关联证据 / 下一步 |
|---|---|---|---|
| [#453](https://github.com/AustinXT/fengyu-wxapp/issues/453) | [Bug][库存] 单据日期/有效期只校验位数不校验日历，2026-02-30 进 PG 报 22008 最终 500 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#452](https://github.com/AustinXT/fengyu-wxapp/issues/452) | [Bug][数据中心] 提成日报/明细与日常一览表导出对非法参数静默回落，应与主表/频率表一致报 INVALID_PARAMS | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#439](https://github.com/AustinXT/fengyu-wxapp/issues/439) | [Bug][数据中心] 新客客单价分子按订单店、分母按绑定店，6 家门店偏差最高 13.3%（#287 同型） | 待核验关单 | [PR #448](https://github.com/AustinXT/fengyu-wxapp/pull/448) |
| [#437](https://github.com/AustinXT/fengyu-wxapp/issues/437) | [Bug][UI] staff 提货页按单分组的单号截断失效（#350 引入，#238 守护在 dev 上转红） | 待核验关单 | [PR #441](https://github.com/AustinXT/fengyu-wxapp/pull/441) |
| [#436](https://github.com/AustinXT/fengyu-wxapp/issues/436) | [Chore][经营分析][守护] 页面 / 智能助手 / 导出向取数函数透传 scope 的「最后一跳」没有测试守护（#421 评审范围外项） | 待核验关单 | [PR #444](https://github.com/AustinXT/fengyu-wxapp/pull/444) |
| [#424](https://github.com/AustinXT/fengyu-wxapp/issues/424) | [Bug][staff][数据中心] 只授权无门店市场的账号：管理看板范围标签错显「全部市场」、picker 无可选项（#399 staff 侧） | 待核验关单 | [PR #427](https://github.com/AustinXT/fengyu-wxapp/pull/427) |
| [#423](https://github.com/AustinXT/fengyu-wxapp/issues/423) | [口径][数据中心] 无门店市场（品项公司）范围下人均类 KPI 恒 0 与员工榜矛盾，待定口径 | 待核验关单 | [PR #428](https://github.com/AustinXT/fengyu-wxapp/pull/428) |
| [#422](https://github.com/AustinXT/fengyu-wxapp/issues/422) | [优化][门店口径] #401 遗留：下拉「已关店」标识、默认落关店店、概览门店数不看开业日、closed_at 双写两处缺口 | 待核验关单 | [PR #440](https://github.com/AustinXT/fengyu-wxapp/pull/440) |
| [#421](https://github.com/AustinXT/fengyu-wxapp/issues/421) | [Bug][经营分析][门店口径] analyst 范围下拉用 is_closed、取数无在营过滤，与数据中心 #401 口径不一致 | 待核验关单 | [PR #435](https://github.com/AustinXT/fengyu-wxapp/pull/435) |
| [#414](https://github.com/AustinXT/fengyu-wxapp/issues/414) | [Bug][数据中心] 客活达成率分母三处不同源：两率之和恒等 100%（无信息量），2026-10-06 起将 >100% | 待核验关单 | [PR #430](https://github.com/AustinXT/fengyu-wxapp/pull/430) |
| [#401](https://github.com/AustinXT/fengyu-wxapp/issues/401) | [Bug][权限][门店口径] 「在营门店」两套口径：筛选器看 is_active+is_closed，取数 SQL 只看 is_active | 待核验关单 | [PR #420](https://github.com/AustinXT/fengyu-wxapp/pull/420) |
| [#400](https://github.com/AustinXT/fengyu-wxapp/issues/400) | [Bug][权限][staff看板] 店长绑定门店停用时默认 scope 落到停用门店，整屏 0（#293 的 staff 端同型） | 待核验关单 | [PR #418](https://github.com/AustinXT/fengyu-wxapp/pull/418) |
| [#399](https://github.com/AustinXT/fengyu-wxapp/issues/399) | [Bug][权限][数据中心] 非总部账号的市场下无在营门店时整屏「暂无可查看范围」，挡住锚定市场员工数据 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#384](https://github.com/AustinXT/fengyu-wxapp/issues/384) | [Bug][工具] worktree-setup.sh 缺三处云函数 node_modules 软链，致 admin 假红 + staff 用例静默 skip | 本轮涉及 | 本轮补了三处云函数依赖软链，仍需该单完整验收后再关 |
| [#382](https://github.com/AustinXT/fengyu-wxapp/issues/382) | [Chore][CI] 补齐测试覆盖缺口：admin 215 个测试只跑 6 个，staff miniprogram / analyst / payNotify 零覆盖 | 维护候选 | 按用户影响/复现和优先级排期，不以清数量为目标 |
| [#379](https://github.com/AustinXT/fengyu-wxapp/issues/379) | [需求][提成] 提成矩阵增加划卡单价阈值（低于阈值按阈值计，默认 100，仅自销） | 待核验关单 | [PR #403](https://github.com/AustinXT/fengyu-wxapp/pull/403) |
| [#378](https://github.com/AustinXT/fengyu-wxapp/issues/378) | [Bug][数据中心] 服务明细生美标记 is_shengmei 快照错标（2026-08 生美实耗偏差约 9 万元） | 待核验关单 | [PR #397](https://github.com/AustinXT/fengyu-wxapp/pull/397) |
| [#376](https://github.com/AustinXT/fengyu-wxapp/issues/376) | [需求][数据中心] 数据中心门店筛选支持多选（5 张新页先用单选范围上线） | 待核验关单 | [PR #431](https://github.com/AustinXT/fengyu-wxapp/pull/431) |
| [#375](https://github.com/AustinXT/fengyu-wxapp/issues/375) | [需求][数据中心] 新增「员工提成日报」及「提成明细」下钻 | 待核验关单 | [PR #411](https://github.com/AustinXT/fengyu-wxapp/pull/411) |
| [#374](https://github.com/AustinXT/fengyu-wxapp/issues/374) | [pending][数据中心] 经营数据主表目标列（被经营目标、年度 / 当月业绩目标、完成率）的数据来源 | 待决 | 先读评论确认是否已拍板；不进入自动开发队列 |
| [#373](https://github.com/AustinXT/fengyu-wxapp/issues/373) | [待确认][数据中心] 经营数据主表：保有会员 / 回店 / 被经营 / 售前售后客流 / 单次生美客耗口径 | 待核验关单 | [PR #416](https://github.com/AustinXT/fengyu-wxapp/pull/416) |
| [#372](https://github.com/AustinXT/fengyu-wxapp/issues/372) | [需求][数据中心] 新增「经营数据主表」首版（模板结构 + 已可取数列） | 待核验关单 | [PR #405](https://github.com/AustinXT/fengyu-wxapp/pull/405) |
| [#371](https://github.com/AustinXT/fengyu-wxapp/issues/371) | [需求][数据中心] 新增「顾客剩余卡项清单」（顾客 × 二级品项剩余矩阵） | 待核验关单 | [PR #406](https://github.com/AustinXT/fengyu-wxapp/pull/406) |
| [#370](https://github.com/AustinXT/fengyu-wxapp/issues/370) | [需求][数据中心] 新增「顾客频率表」（顾客 × 当月日历到店与消费） | 待核验关单 | [PR #410](https://github.com/AustinXT/fengyu-wxapp/pull/410) |
| [#369](https://github.com/AustinXT/fengyu-wxapp/issues/369) | [需求][数据中心] 新增「日常数据一览表」（经营类型 / 具体品项 / 二级品项三视角） | 待核验关单 | [PR #407](https://github.com/AustinXT/fengyu-wxapp/pull/407) |
| [#368](https://github.com/AustinXT/fengyu-wxapp/issues/368) | [需求][数据中心] 矩阵报表组件与导出扩展：两行分组表头、冻结列、合计行、合并表头导出 | 待核验关单 | [PR #390](https://github.com/AustinXT/fengyu-wxapp/pull/390) |
| [#367](https://github.com/AustinXT/fengyu-wxapp/issues/367) | [需求][数据中心] 经营明细报表公共骨架：独立路由、菜单分段、专用权限点、三种筛选形态 | 待核验关单 | [PR #394](https://github.com/AustinXT/fengyu-wxapp/pull/394) |
| [#365](https://github.com/AustinXT/fengyu-wxapp/issues/365) | [待确认][库存] 市场自采商品的供应商档案由谁建 | 待决 | 先读评论确认是否已拍板；不进入自动开发队列 |
| [#364](https://github.com/AustinXT/fengyu-wxapp/issues/364) | [待确认][库存] 店长或股东能否查看本店货款结算 | 待决 | 先读评论确认是否已拍板；不进入自动开发队列 |
| [#363](https://github.com/AustinXT/fengyu-wxapp/issues/363) | [需求][库存] 市场汇总报货表单补各门店分量与门店单价参考列 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#362](https://github.com/AustinXT/fengyu-wxapp/issues/362) | [Bug][库存] 采购覆盖的门店与实际配货门店不一致时，门店待配量和建议采购会算错 | 待核验关单 | [PR #429](https://github.com/AustinXT/fengyu-wxapp/pull/429) |
| [#361](https://github.com/AustinXT/fengyu-wxapp/issues/361) | [需求][库存] 跟进查询：分院未入库明细与市场入库情况 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#360](https://github.com/AustinXT/fengyu-wxapp/issues/360) | [需求][库存] 全产品进出明细查询（按主体 + 商品编号或批号查全流水） | 待核验关单 | [PR #451](https://github.com/AustinXT/fengyu-wxapp/pull/451) |
| [#359](https://github.com/AustinXT/fengyu-wxapp/issues/359) | [需求][库存] 配货与调货选批次时显示赠送标记和该批次市场进价（黄色参考字段） | 待核验关单 | [PR #432](https://github.com/AustinXT/fengyu-wxapp/pull/432) |
| [#358](https://github.com/AustinXT/fengyu-wxapp/issues/358) | [需求][库存] 收货默认整单确认，并修复小程序确认收货不扣已收量 | 待核验关单 | [PR #447](https://github.com/AustinXT/fengyu-wxapp/pull/447) |
| [#357](https://github.com/AustinXT/fengyu-wxapp/issues/357) | [需求][库存] 单据列表显示流程进度，支持进度与日期筛选，详情页展示整条血缘链 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#356](https://github.com/AustinXT/fengyu-wxapp/issues/356) | [待确认][库存] 市场报货汇总单的形态：会议要「只看不做动作」，#193 已做成单据 | 待决 | 先读评论确认是否已拍板；不进入自动开发队列 |
| [#355](https://github.com/AustinXT/fengyu-wxapp/issues/355) | [Bug][库存] 只有市场权限的账号新建商品时默认来源是「供应链」，提交被拒 | 待核验关单 | [PR #392](https://github.com/AustinXT/fengyu-wxapp/pull/392) |
| [#354](https://github.com/AustinXT/fengyu-wxapp/issues/354) | [需求][库存] 报货福利方案只允许供应链维护（现在市场可给自己建优惠） | 待核验关单 | [PR #396](https://github.com/AustinXT/fengyu-wxapp/pull/396) |
| [#353](https://github.com/AustinXT/fengyu-wxapp/issues/353) | [需求][库存] 新增门店盘溢单据类型，盘点单显示盈亏金额 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#352](https://github.com/AustinXT/fengyu-wxapp/issues/352) | [需求][库存] staff 小程序新增门店盘点入口 | 待核验关单 | [PR #433](https://github.com/AustinXT/fengyu-wxapp/pull/433) |
| [#351](https://github.com/AustinXT/fengyu-wxapp/issues/351) | [Bug][库存] 盘点单的实盘数不能填 0，最严重的盘亏录不进去 | 待核验关单 | [PR #413](https://github.com/AustinXT/fengyu-wxapp/pull/413) |
| [#350](https://github.com/AustinXT/fengyu-wxapp/issues/350) | [需求][提货] 顾客出库只走提货链路：下线通用「顾客产品出库」，提货页按销售单展示 | 待核验关单 | [PR #389](https://github.com/AustinXT/fengyu-wxapp/pull/389) |
| [#349](https://github.com/AustinXT/fengyu-wxapp/issues/349) | [需求][库存] 市场报货汇总单与货款结算：明细下钻、市场筛选与导出（作收款凭证） | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#348](https://github.com/AustinXT/fengyu-wxapp/issues/348) | [需求][库存] 门店报货与市场汇总报货支持先存草稿再提交 | 待核验关单 | [PR #449](https://github.com/AustinXT/fengyu-wxapp/pull/449) |
| [#347](https://github.com/AustinXT/fengyu-wxapp/issues/347) | [需求][库存] 市场间调货计价：默认标准价、可减价不可加价、可优惠到 0，并加调货结算 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#346](https://github.com/AustinXT/fengyu-wxapp/issues/346) | [需求][库存] 供应链采购入库支持填单价优惠，记录真实入库成本 | 待核验关单 | [PR #419](https://github.com/AustinXT/fengyu-wxapp/pull/419) |
| [#345](https://github.com/AustinXT/fengyu-wxapp/issues/345) | [需求][库存] 批号自动生成（采购入库 / 自采入库 / 转换 / 赠送单独批号） | 待核验关单 | [PR #393](https://github.com/AustinXT/fengyu-wxapp/pull/393) |
| [#344](https://github.com/AustinXT/fengyu-wxapp/issues/344) | [需求][库存] 转换单支持多对多与拆分，目标价格可自填且成本守恒 | 待核验关单 | [PR #415](https://github.com/AustinXT/fengyu-wxapp/pull/415) |
| [#343](https://github.com/AustinXT/fengyu-wxapp/issues/343) | [需求][库存] 库存转换收回为仅供应链可做（含自建商品不能转换） | 待核验关单 | [PR #388](https://github.com/AustinXT/fengyu-wxapp/pull/388) |
| [#342](https://github.com/AustinXT/fengyu-wxapp/issues/342) | [待确认][提成] 店长产品出库提成的规则、数据来源与 prod 提货入口开放时机 | 待决 | 先读评论确认是否已拍板；不进入自动开发队列 |
| [#341](https://github.com/AustinXT/fengyu-wxapp/issues/341) | [需求][提货] 提货时按顾客实际售价冻结出库金额，提货记录加金额列并支持导出 | 待核验关单 | [PR #438](https://github.com/AustinXT/fengyu-wxapp/pull/438) |
| [#340](https://github.com/AustinXT/fengyu-wxapp/issues/340) | [Bug][库存] 市场间调货选不到调入市场，只管一个市场的账号无法发起 | 待核验关单 | [PR #386](https://github.com/AustinXT/fengyu-wxapp/pull/386) |
| [#339](https://github.com/AustinXT/fengyu-wxapp/issues/339) | [需求][库存] 商品选择支持检索并突破前 100 个上限（admin 办理台 + staff 门店报货） | 待核验关单 | [PR #387](https://github.com/AustinXT/fengyu-wxapp/pull/387) |
| [#338](https://github.com/AustinXT/fengyu-wxapp/issues/338) | [Bug][库存] 办理台来源单候选只取「全类型混排最近 100 张」，老单选不到 | 待核验关单 | [PR #395](https://github.com/AustinXT/fengyu-wxapp/pull/395) |
| [#337](https://github.com/AustinXT/fengyu-wxapp/issues/337) | [需求][库存] 分院配货支持不引用门店报货单（市场直接配货） | 待核验关单 | [PR #409](https://github.com/AustinXT/fengyu-wxapp/pull/409) |
| [#336](https://github.com/AustinXT/fengyu-wxapp/issues/336) | [需求][库存] 品项公司发货改为引用市场原始报货单（有现货可直接发，报货到发货可追溯） | 待核验关单 | [PR #417](https://github.com/AustinXT/fengyu-wxapp/pull/417) |
| [#335](https://github.com/AustinXT/fengyu-wxapp/issues/335) | [需求][库存] 采购订单的市场来源行也走供应链采购入库（修精华液入不了库的根因） | 待核验关单 | [PR #385](https://github.com/AustinXT/fengyu-wxapp/pull/385) |
| [#334](https://github.com/AustinXT/fengyu-wxapp/issues/334) | [Bug][数据中心] 无门店市场的直挂技师：admin 非超管总部账号看不到、staff 看得到，两端 all 口径分叉 | 待核验关单 | [PR #446](https://github.com/AustinXT/fengyu-wxapp/pull/446) |
| [#327](https://github.com/AustinXT/fengyu-wxapp/issues/327) | [Bug][dev] data-center 顾客板在 dev 上 tsc 报错 + 1 条单测红（#284 与 #310/#315 两个 PR 合并后互撞） | 疑似重复 | 与已关闭 #328 同现象；先核对修复 PR 与 dev 验收 |
| [#320](https://github.com/AustinXT/fengyu-wxapp/issues/320) | [Bug][数据中心] staff 首页人均分母漏掉 14 名直挂市场/部门的产能技师，全部人均指标虚高 9.33% | 待核验关单 | [PR #333](https://github.com/AustinXT/fengyu-wxapp/pull/333) |
| [#318](https://github.com/AustinXT/fengyu-wxapp/issues/318) | [Bug][组织] updateOrgNode 改挂部门可绕过员工归属自洽（#259 的另一侧） | 待核验关单 | [PR #330](https://github.com/AustinXT/fengyu-wxapp/pull/330) |
| [#317](https://github.com/AustinXT/fengyu-wxapp/issues/317) | [Bug][经营分析] AI 助手回答的 formatSignedRate 未挡非有限值，会输出「NaNpct」（与 #307 同族） | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#316](https://github.com/AustinXT/fengyu-wxapp/issues/316) | [需求][经营分析] analyst 全仓无 error.tsx，server component 抛错整页落 Next 内建兜底页 | 待核验关单 | [PR #331](https://github.com/AustinXT/fengyu-wxapp/pull/331) |
| [#315](https://github.com/AustinXT/fengyu-wxapp/issues/315) | [Bug][工作台] 首页看板 TrendArrow 基期≤0 时把涨跌幅吞成 0%，生产 6.6% 的门店日命中（零测试） | 待核验关单 | [PR #321](https://github.com/AustinXT/fengyu-wxapp/pull/321) |
| [#314](https://github.com/AustinXT/fengyu-wxapp/issues/314) | [Bug][经营分析] analyst 增幅文案两处口径缺陷：rate 零基期只藏涨不藏跌 + 伪持平 ±0.0% | 待核验关单 | [PR #325](https://github.com/AustinXT/fengyu-wxapp/pull/325) |
| [#311](https://github.com/AustinXT/fengyu-wxapp/issues/311) | [需求][数据中心] year 预设重复查询同一区间 + safeDiv 同包重复 | 维护候选 | 按用户影响/复现和优先级排期，不以清数量为目标 |
| [#310](https://github.com/AustinXT/fengyu-wxapp/issues/310) | [需求][数据中心] KPI 徽章露出基期区间 + 负基期「由负转正」展示 | 待核验关单 | [PR #321](https://github.com/AustinXT/fengyu-wxapp/pull/321) |
| [#308](https://github.com/AustinXT/fengyu-wxapp/issues/308) | [Bug][数据中心] parseTimeRange 只校验日期数字位数不校验日历合法性，自定义区间可崩溃或静默查空 | 待核验关单 | [PR #450](https://github.com/AustinXT/fengyu-wxapp/pull/450) |
| [#307](https://github.com/AustinXT/fengyu-wxapp/issues/307) | [Bug][经营分析] fengyu-analyst 新客漏斗环比/同比未挡负基期，符号翻转（颜色对、数字错） | 待核验关单 | [PR #313](https://github.com/AustinXT/fengyu-wxapp/pull/313) |
| [#304](https://github.com/AustinXT/fengyu-wxapp/issues/304) | [需求][权限] 调店后的角色迁移闭环：权限页入口 + 一键迁移 + 滞留绑定告警（#249 的配套） | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#302](https://github.com/AustinXT/fengyu-wxapp/issues/302) | [Bug][组织] 95 名在职员工 store_id 为空，需组织侧补齐归属 + 缺失告警 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#301](https://github.com/AustinXT/fengyu-wxapp/issues/301) | [Bug][绑定] bound_employee_id 覆盖率 8 月起从 63.5% 断崖跌至 20.8%，疑似写入链路批量丢绑定 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#300](https://github.com/AustinXT/fengyu-wxapp/issues/300) | [需求][数据中心] 生美业绩改按款项归属日期口径计入（历史月份数字须冻结） | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#299](https://github.com/AustinXT/fengyu-wxapp/issues/299) | [需求][数据中心] 员工排行榜补列头/表注，说明数值为个人全域产出 | 待核验关单 | [PR #443](https://github.com/AustinXT/fengyu-wxapp/pull/443) |
| [#298](https://github.com/AustinXT/fengyu-wxapp/issues/298) | [Bug][数据中心] 一次/二次客活口径统一为「到店天数」，admin 内两套定义已分叉差 62 人 | 待核验关单 | [PR #398](https://github.com/AustinXT/fengyu-wxapp/pull/398) |
| [#296](https://github.com/AustinXT/fengyu-wxapp/issues/296) | [需求][数据中心] 导出件补口径元信息（时间区间 / scope / 基期） | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#295](https://github.com/AustinXT/fengyu-wxapp/issues/295) | [Bug][数据中心] 销售板按市场明细「门店数」未历史化，与 KPI 不同源 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#294](https://github.com/AustinXT/fengyu-wxapp/issues/294) | [Bug][数据中心] 卡片说明文案与 SQL 口径不符，4 处（纯前端，零数据风险） | 待核验关单 | [PR #326](https://github.com/AustinXT/fengyu-wxapp/pull/326) |
| [#293](https://github.com/AustinXT/fengyu-wxapp/issues/293) | [Bug][数据中心] 停用门店 scope 下整屏渲染 0 而非空态，无法区分「无业绩」与「已停用」 | 待核验关单 | [PR #402](https://github.com/AustinXT/fengyu-wxapp/pull/402) |
| [#292](https://github.com/AustinXT/fengyu-wxapp/issues/292) | [Bug][数据中心] 新会员阈值 1990 在 customer.ts 硬编码三处，与 system_configs 单源冲突 | 待核验关单 | [PR #404](https://github.com/AustinXT/fengyu-wxapp/pull/404) |
| [#291](https://github.com/AustinXT/fengyu-wxapp/issues/291) | [Bug][数据中心] ::date 族依赖未断言的会话时区，换库或换运行环境将导致整族指标跨日 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#290](https://github.com/AustinXT/fengyu-wxapp/issues/290) | [Bug][数据中心] 员工排行榜五处 >0 过滤吞掉负值员工，与同板块门店榜规则不一致 | 待核验关单 | [PR #391](https://github.com/AustinXT/fengyu-wxapp/pull/391) |
| [#289](https://github.com/AustinXT/fengyu-wxapp/issues/289) | [Bug][数据中心] 新客客单价跨 2026-07-03 数据割点低报 41% | 待核验关单 | [PR #454](https://github.com/AustinXT/fengyu-wxapp/pull/454) |
| [#288](https://github.com/AustinXT/fengyu-wxapp/issues/288) | [Bug][数据中心] 品项新增/复购业绩用 HAVING SUM > 0 整组丢弃负净额日，退款冲销被吞虚高 12% | 待核验关单 | [PR #442](https://github.com/AustinXT/fengyu-wxapp/pull/442) |
| [#287](https://github.com/AustinXT/fengyu-wxapp/issues/287) | [Bug][数据中心] 持卡占比分子分母不同源，集团恒 253%、单店最高 2600% | 待核验关单 | [PR #412](https://github.com/AustinXT/fengyu-wxapp/pull/412) |
| [#286](https://github.com/AustinXT/fengyu-wxapp/issues/286) | [Bug][数据中心] 品项板明细「新增人数」用内连接归店，较 KPI 漏 65.7% | 待核验关单 | [PR #332](https://github.com/AustinXT/fengyu-wxapp/pull/332) |
| [#285](https://github.com/AustinXT/fengyu-wxapp/issues/285) | [Bug][数据中心] 人效人均业绩分子按 role_type 重复求和，虚高 30% 且与同页门店榜差 111 万 | 待核验关单 | [PR #323](https://github.com/AustinXT/fengyu-wxapp/pull/323) |
| [#284](https://github.com/AustinXT/fengyu-wxapp/issues/284) | [Bug][数据中心] 成交率分母用 customer_type 当前快照，本期已转化的人被整体抹掉 | 待核验关单 | [PR #322](https://github.com/AustinXT/fengyu-wxapp/pull/322) |
| [#283](https://github.com/AustinXT/fengyu-wxapp/issues/283) | [Bug][数据中心] 本周/本月环比基期与当期不等长，叠加负基期符号翻转，约 20 张 KPI 卡环比失真 | 待核验关单 | [PR #305](https://github.com/AustinXT/fengyu-wxapp/pull/305) |
| [#282](https://github.com/AustinXT/fengyu-wxapp/issues/282) | [Bug][全仓] 28 处分页查询缺唯一键 tie-break，翻页可能重复/漏行（admin 16 + 云函数 12） | 待核验关单 | [PR #312](https://github.com/AustinXT/fengyu-wxapp/pull/312) |
| [#281](https://github.com/AustinXT/fengyu-wxapp/issues/281) | [Bug][admin] 分页入参 page 不取整：URL 可直接构造 ?page=2.5 / 1e21 触发 500（17 处 action + 20 处组件） | 待核验关单 | [PR #306](https://github.com/AustinXT/fengyu-wxapp/pull/306) |
| [#276](https://github.com/AustinXT/fengyu-wxapp/issues/276) | [Bug][clientApi] order.homeProducts 测试与实现漂移，挡住 clientApi 接入 CI | 待核验关单 | [PR #380](https://github.com/AustinXT/fengyu-wxapp/pull/380) |
| [#273](https://github.com/AustinXT/fengyu-wxapp/issues/273) | [需求][客户端] 把 #248 的封面视口窗口复用到体验卡列表与订单列表 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#272](https://github.com/AustinXT/fengyu-wxapp/issues/272) | [Bug][客户端] clientApi 5 个列表接口分页入参零校验：pageSize=null 等于不限行数 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#270](https://github.com/AustinXT/fengyu-wxapp/issues/270) | [Bug][库存] store_id 撞总部/市场 org_node id 时，syncInventoryLocations 会静默顶替主体并使后续同步永久失败 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#260](https://github.com/AustinXT/fengyu-wxapp/issues/260) | [Bug][库存] 院退货审批的预留消费：绝对值覆写 fulfilled_quantity + 容忍少扣 + 只取第一条 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#259](https://github.com/AustinXT/fengyu-wxapp/issues/259) | [Bug][组织] 员工的 storeId 与 orgNodeId 不校验归属关系，可让同一员工同时出现在两个门店名册（需业务拍板） | 待核验关单 | [PR #319](https://github.com/AustinXT/fengyu-wxapp/pull/319) |
| [#257](https://github.com/AustinXT/fengyu-wxapp/issues/257) | [Bug][顾客分类] customer_type 改按实收口径双向同步（放弃只升不降），81 人档位随之下调 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#256](https://github.com/AustinXT/fengyu-wxapp/issues/256) | [需求][顾客分类] WorkFine 同步历史顾客后自动补算 customer_type，避免会员标签长期停在流量客 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#255](https://github.com/AustinXT/fengyu-wxapp/issues/255) | [Bug][运维] prod 发版撞在途备份，杀 pg_dump 留死锁且当天 dump 无法自动补救 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#254](https://github.com/AustinXT/fengyu-wxapp/issues/254) | [Bug][cron] refresh-customer-status 段 3 的 IS NULL 条件致一类会员客状态永不自愈 | 待核验关单 | [PR #274](https://github.com/AustinXT/fengyu-wxapp/pull/274) |
| [#253](https://github.com/AustinXT/fengyu-wxapp/issues/253) | [Bug][积分] 到店积分发放把 Date 绑进 postgres.js 模板，2026-08-14 起 100% 失败（含 cron 重试通道） | 待核验关单 | [PR #269](https://github.com/AustinXT/fengyu-wxapp/pull/269) |
| [#251](https://github.com/AustinXT/fengyu-wxapp/issues/251) | [Bug][库存] ensureInventoryLocation 的 LIMIT 1 缺 ORDER BY，org_node 对多 store 时可「按 A 鉴权、扣 B 库存」 | 待核验关单 | [PR #271](https://github.com/AustinXT/fengyu-wxapp/pull/271) |
| [#250](https://github.com/AustinXT/fengyu-wxapp/issues/250) | [Bug][权限] updateCustomer 写 boundEmployeeId 与 assignRole 的 employeeId 均无 scope 校验 | 待核验关单 | [PR #277](https://github.com/AustinXT/fengyu-wxapp/pull/277) |
| [#249](https://github.com/AustinXT/fengyu-wxapp/issues/249) | [Bug][权限] updateEmployee §AFF-03 角色同步：非事务 + 唯一键冲突 + 两步绕过（需业务拍板） | 待核验关单 | [PR #319](https://github.com/AustinXT/fengyu-wxapp/pull/319) |
| [#248](https://github.com/AustinXT/fengyu-wxapp/issues/248) | [需求][商品] 商品列表加分页，给页面级图片解码量建立硬上限 | 待核验关单 | [PR #279](https://github.com/AustinXT/fengyu-wxapp/pull/279) |
| [#247](https://github.com/AustinXT/fengyu-wxapp/issues/247) | [Bug][凤御馆] 长图链路用单边缩略规则 + 对 77.9MP 原图调 getImageInfo | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#241](https://github.com/AustinXT/fengyu-wxapp/issues/241) | [需求][重构] customer.search 的多态返回形态拆成两个 action（低优先级，可决定不做） | 维护候选 | 按用户影响/复现和优先级排期，不以清数量为目标 |
| [#240](https://github.com/AustinXT/fengyu-wxapp/issues/240) | [Bug][顾客] 两处分页的 pageSize 未取整，小数值会让 PG 抛 bigint 语法错 | 待核验关单 | [PR #252](https://github.com/AustinXT/fengyu-wxapp/pull/252) |
| [#239](https://github.com/AustinXT/fengyu-wxapp/issues/239) | [Bug][绩效] performanceDetail 的服务提成查询缺 tie-break，翻页可能重复/漏行 | 待核验关单 | [PR #261](https://github.com/AustinXT/fengyu-wxapp/pull/261) |
| [#238](https://github.com/AustinXT/fengyu-wxapp/issues/238) | [Bug][UI] 全仓 <text> 的 ellipsis 截断失效（缺 display:block）13 处 + scroll-view content-box 溢出 6 处 | 待核验关单 | [PR #267](https://github.com/AustinXT/fengyu-wxapp/pull/267) |
| [#237](https://github.com/AustinXT/fengyu-wxapp/issues/237) | [需求][库存] 清理 assertGenericDocLocationRules 里「供应链采购入库」的 dead case | 待核验关单 | [PR #268](https://github.com/AustinXT/fengyu-wxapp/pull/268) |
| [#236](https://github.com/AustinXT/fengyu-wxapp/issues/236) | [需求][库存] insertDocHeader 补「同主体单据两端不一致则拒绝」断言，与 engine 副本对齐 | 待核验关单 | [PR #268](https://github.com/AustinXT/fengyu-wxapp/pull/268) |
| [#235](https://github.com/AustinXT/fengyu-wxapp/issues/235) | [Bug][库存] staffApi 审批/驳回用 source // target 取代表值鉴权（当前 fail-safe，结构同 #200） | 待核验关单 | [PR #264](https://github.com/AustinXT/fengyu-wxapp/pull/264) |
| [#234](https://github.com/AustinXT/fengyu-wxapp/issues/234) | [需求][admin] 图片上传自动压缩，不再只是拒绝超大图 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#233](https://github.com/AustinXT/fengyu-wxapp/issues/233) | [Bug][上传] 小程序端上传入口只校验字节数，绕过 admin 分辨率闸门 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#232](https://github.com/AustinXT/fengyu-wxapp/issues/232) | [Bug][staff] staffApi 商品封面未做尺寸约束，需建独立 image 工具副本 | 待核验关单 | [PR #275](https://github.com/AustinXT/fengyu-wxapp/pull/275) |
| [#231](https://github.com/AustinXT/fengyu-wxapp/issues/231) | [Bug][首页] banner 图未做尺寸约束且无 lazy-load（URL 前端拼接，绕过云函数防护） | 待核验关单 | [PR #280](https://github.com/AustinXT/fengyu-wxapp/pull/280) |
| [#230](https://github.com/AustinXT/fengyu-wxapp/issues/230) | [Bug][商品] clientApi 商品与订单封面图未做尺寸约束，与 #213 同根因 | 待核验关单 | [PR #262](https://github.com/AustinXT/fengyu-wxapp/pull/262) |
| [#228](https://github.com/AustinXT/fengyu-wxapp/issues/228) | [Bug][权限] admin updateEmployee 员工调店未校验目标门店 scope，可跨店搬员工并带走权限绑定 | 待核验关单 | [PR #263](https://github.com/AustinXT/fengyu-wxapp/pull/263) |
| [#224](https://github.com/AustinXT/fengyu-wxapp/issues/224) | [需求][服务单] 外援在员工端可见并处理指派给自己的跨店支援单 | 待核验关单 | [PR #246](https://github.com/AustinXT/fengyu-wxapp/pull/246) |
| [#215](https://github.com/AustinXT/fengyu-wxapp/issues/215) | [Bug][支付] 待支付倒计时对员工开单订单显示 10 分钟，实际永不超时关闭 | 待核验关单 | [PR #324](https://github.com/AustinXT/fengyu-wxapp/pull/324) |
| [#214](https://github.com/AustinXT/fengyu-wxapp/issues/214) | [Bug][支付] 顾客中断支付后既无法重新支付也无法取消，支付意图需等约 20 分钟才释放 | 待核验关单 | [PR #278](https://github.com/AustinXT/fengyu-wxapp/pull/278) |
| [#213](https://github.com/AustinXT/fengyu-wxapp/issues/213) | [Bug][门店] client 进入门店选择页即崩溃「小程序意外退出，请稍后重试」（正式版，多次复现） | 待核验关单 | [PR #226](https://github.com/AustinXT/fengyu-wxapp/pull/226) |
| [#212](https://github.com/AustinXT/fengyu-wxapp/issues/212) | [需求][数据中心] 4 个板块 Tab 挪到左侧导航栏作为二级菜单 | 待核验关单 | [PR #218](https://github.com/AustinXT/fengyu-wxapp/pull/218) |
| [#211](https://github.com/AustinXT/fengyu-wxapp/issues/211) | [需求][权限] admin 员工管理「标签管理」收紧为仅系统管理员可用 | 待核验关单 | [PR #217](https://github.com/AustinXT/fengyu-wxapp/pull/217) |
| [#210](https://github.com/AustinXT/fengyu-wxapp/issues/210) | [需求][服务单] 创建服务单可选门店所属市场的出差支援人员（技能白名单扩至四项） | 待核验关单 | [PR #220](https://github.com/AustinXT/fengyu-wxapp/pull/220) |
| [#200](https://github.com/AustinXT/fengyu-wxapp/issues/200) | [Bug][库存] 建单的 scope 校验只看发起主体，入库类可向无权限主体增加库存 | 待核验关单 | [PR #225](https://github.com/AustinXT/fengyu-wxapp/pull/225) |
| [#194](https://github.com/AustinXT/fengyu-wxapp/issues/194) | [需求][库存] 合并「供应链采购订单」与「创建采购订单」：多报货单汇总下单 + 供应商按商品自动绑定 | 待核验关单 | [PR #202](https://github.com/AustinXT/fengyu-wxapp/pull/202) |
| [#187](https://github.com/AustinXT/fengyu-wxapp/issues/187) | [Bug][顾客分类] 顾客类型跃迁按应付额判定，未落地 2026-04-26 Q5.2 实收口径决策 | 待核验关单 | [PR #199](https://github.com/AustinXT/fengyu-wxapp/pull/199) |
| [#184](https://github.com/AustinXT/fengyu-wxapp/issues/184) | [Bug][分配] 提成分配选人弹窗右侧市场/门店名被截断 | 待核验关单 | [PR #216](https://github.com/AustinXT/fengyu-wxapp/pull/216) |
| [#182](https://github.com/AustinXT/fengyu-wxapp/issues/182) | [Bug][转换单] 疗程卡多收余数 / 家居不足一整件的余数无法折抵，顾客已付款沉没 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
| [#181](https://github.com/AustinXT/fengyu-wxapp/issues/181) | [需求][顾客档案] staff 顾客档案列表支持下滑加载更多（当前硬编码 20 条封顶） | 待核验关单 | [PR #221](https://github.com/AustinXT/fengyu-wxapp/pull/221) |
| [#154](https://github.com/AustinXT/fengyu-wxapp/issues/154) | [Bug][数据模型] picked_up_quantity 三语义共用一列，需拆 refunded/converted 独立列 | 开发候选 | 尚未发现显式 closing 关联；需摄入/去重/规则确认，不能据此认定未实现 |
