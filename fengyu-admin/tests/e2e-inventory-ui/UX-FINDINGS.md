# 库存管理 —— 交互合理性审计报告

> 目标：http://101.34.242.103:3000（dev 环境 fengyu-admin）
> 生成时间：2026/9/24 11:59:24
> 生成方式：`bun run test:e2e:inventory-ui` 中的 `inv-10-ux-audit.spec.ts` 自动扫描 + 链路测试中的实测发现

**共 5 条：P0 0 · P1 3 · P2 2**

严重度口径：

| 级别 | 含义 |
|---|---|
| P0 | 功能不可用 / 数据错误，必须修 |
| P1 | 影响正确性或可理解性，用户会被误导或卡住 |
| P2 | 体验与一致性问题，不阻断使用 |

## 发现清单

| 严重度 | 规则 | 位置 | 说明 | 证据 |
|---|---|---|---|---|
| P1 | 外键类字段应提供选择器 | `/inventory/suppliers → 新建供应商` | 字段「供应商名称」引用的是已有档案（命中关键词「供应商」），却渲染为 <input> 自由输入 | `label="供应商名称 *" control=<input>` |
| P1 | 外键类字段应提供选择器 | `/inventory/promotions → 报货福利方案` | 字段「方案名称」引用的是已有档案（命中关键词「方案」），却渲染为 <input> 自由输入 | `label="方案名称 *" control=<input>` |
| P1 | 业务错误提示被生产构建脱敏 | `全局（Server Action 错误路径）` | Server Action 抛出的 ApiError 在生产构建下被 Next.js 统一脱敏，用户看到的是「An error occurred in the Server Components render...」或一串 error digest 数字（如 1956068727），业务文案（「库存期初尚未导入并核验完成」等）完全丢失，用户无从判断该做什么 | `INV-02 期初门禁拦截、INV-07 员工加载失败均复现` |
| P2 | 必填项无标记 | `/inventory/docs → 新建库存单据` | 表单共 4 个字段，既无 * 标记也无 required/aria-required —— 用户只能靠提交报错试出必填项 | `单据类型 / 单据日期 / 出库/发起主体 / 入库/接收主体` |
| P2 | 提交按钮未在提交期间禁用 | `/inventory/operations/store → 门店报货（防重复提交）` | 按钮在提交过程中未见 disabled/aria-busy，快速双击存在重复建单风险（各表单内部有 saving 标志，但未反映到可访问性属性上） | — |

## 复核说明

本报告由启发式规则自动生成，**每条都需人工复核定性**为「真问题 / 设计如此 / 误报」。
规则只负责摆出可核对的事实（字段名、控件类型、页面路径、源码位置），不替人下结论。

下列条目**若出现在上表中**，其证据来自实测复现，不是静态推测：

- 批次下拉卡死 → `inv-05-transfers.spec.ts` 写入上下文的 `lotLoadingOk`（#129 已修；需细看采样过程时用 `inv-90-probe-lot-loading.spec.ts`）
- 员工下拉恒空 → `inv-07-staff-purchase-and-self-purchase.spec.ts` 写入上下文的 `employeeOptionsOk` + 两个候选数（#130 已修）
- 原生 alert / prompt → 本 spec 全程挂着的 dialog 监听计数（#134 已修）
- 盘点不记账面数 → `inv-06-stocktake-and-loss.spec.ts`
- 供货商无外键 → `inv-01-master-data.spec.ts`（#132 已修）
- 错误提示脱敏 → `inv-02-supply-chain-stock.spec.ts`

（以上条目一律**实测再报**：本轮实测通过就不会出现在上表里。
这几行只说明**万一出现**时证据来自哪支 spec，不代表它已复现。
反过来，**上表里带「未覆盖」「证据过期」字样的 P2 也不是缺陷** —— 它们的含义是
「本轮没有可转述的实测判定，该 issue 是否回归无从判断」。看到它们请补跑对应 spec，
别把「没有 P0」读成「P0 已清零」。）
