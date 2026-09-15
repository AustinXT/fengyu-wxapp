# 库存管理 —— 交互合理性审计报告

> 目标：http://101.34.242.103:3000（dev 环境 fengyu-admin）
> 生成时间：2026/9/13 23:32:32
> 生成方式：`bun run test:e2e:inventory-ui` 中的 `inv-10-ux-audit.spec.ts` 自动扫描 + 链路测试中的实测发现

**共 25 条：P0 2 · P1 5 · P2 18**

严重度口径：

| 级别 | 含义 |
|---|---|
| P0 | 功能不可用 / 数据错误，必须修 |
| P1 | 影响正确性或可理解性，用户会被误导或卡住 |
| P2 | 体验与一致性问题，不阻断使用 |

## 发现清单

| 严重度 | 规则 | 位置 | 说明 | 证据 |
|---|---|---|---|---|
| P0 | 批次下拉永久卡在加载中 | `/inventory/docs → 新建库存单据` | 选定主体与 SKU 后，来源批次下拉永远停留在「加载库存批次...」且始终 disabled（实测 60s+）。根因是 inventory-docs-page.tsx:351-375 的 useEffect 自循环：依赖数组含它自己 set 的 loadingLotKeys/lotOptionsByKey，effect 重跑触发 cleanup 把 cancelled 置 true，首次请求的 then/catch/finally 全被跳过。后果：单据中心里所有需要选来源批次的单据类型（分院调货出库、市场间调货出库、内部领用、院顾客产品出库、市场产品报损、院产品报损）全部无法创建 | `接口已返回 200，是前端把结果丢了；详见 INV-05 / inv-90-probe-lot-loading` |
| P0 | 员工下拉恒为空（SQL 别名错误） | `/inventory/operations/{market,supply-chain} → 员工购` | business.ts 有 5 处递归 CTE 写错别名引用：CTE 在 JOIN 时起了别名（JOIN descendants parent / JOIN ancestors ancestor），SELECT/WHERE 却仍用原名（descendants.path / ancestors.path），PostgreSQL 直接报 invalid reference to FROM-clause entry。后果：市场员工购与供应链员工购的员工下拉恒为空，功能完全不可用；即使绕过下拉，提交时的 employeeForMarket / employeeForSupplyChain 校验同样会炸 | `business.ts:1234 / 1263 / 1273 / 1329 / 1371；dev 库按正确 SQL 能查出 85 / 115 个候选` |
| P1 | 外键类字段应提供选择器 | `/inventory/skus → 新建库存商品` | 字段「供货商」引用的是已有档案（命中关键词「供货商」），却渲染为 <input> 自由输入 | `label="供货商" control=<input>` |
| P1 | 使用原生 alert / prompt | `/inventory/docs` | 建单失败用 alert() 弹原生框（inventory-docs-page.tsx:402）；审批/驳回/收货的备注用 prompt() 收集（:135-151）。原生弹窗无法样式化、无法做必填校验（驳回原因是必填的）、移动端体验差，且会阻塞页面 | `本轮未触发，证据见 INV-02 / INV-05` |
| P1 | 盘点单不记录账面数量 | `/inventory/docs → 市场库存盘点 / 分院库存盘点` | engine.ts:2777 的 stockSnapshot 只在选中批次时才写（lot ? ... : null），而盘点单不属于 SOURCE_LOT_DOC_TYPES、UI 不提供批次选择器，于是 stock_snapshot 恒为 NULL。盘点单既不动库存也不记账面数，退化成只有「数量」的白条，无法用于任何盈亏对账 | `INV-06 实测 stock_snapshot = NULL` |
| P1 | SKU 供货商与供应商档案无关联 | `/inventory/skus → 新建库存商品` | 「供货商」是裸 <input> 文本框，且 inventory_skus 表只有 supplier(text) 列、没有 supplier_id 外键 —— 与 inventory_suppliers 档案表（以及 /inventory/suppliers 整个页面）完全不关联。同一供应商会产生多种写法，供应商档案形同虚设，也无法按供应商统计采购 | `inventory-skus-page.tsx:388；information_schema 查无 supplier_id 列` |
| P1 | 业务错误提示被生产构建脱敏 | `全局（Server Action 错误路径）` | Server Action 抛出的 ApiError 在生产构建下被 Next.js 统一脱敏，用户看到的是「An error occurred in the Server Components render...」或一串 error digest 数字（如 1956068727），业务文案（「库存期初尚未导入并核验完成」等）完全丢失，用户无从判断该做什么 | `INV-02 期初门禁拦截、INV-07 员工加载失败均复现` |
| P2 | 列表缺少分页与总数 | `/inventory/suppliers` | 列表有 6 行数据，但页面没有总数或分页控件，用户不知道数据有没有被截断 | — |
| P2 | 列表缺少分页与总数 | `/inventory/sku-mappings` | 列表有 101 行数据，但页面没有总数或分页控件，用户不知道数据有没有被截断 | — |
| P2 | 列表缺少分页与总数 | `/inventory/promotions` | 列表有 1 行数据，但页面没有总数或分页控件，用户不知道数据有没有被截断 | — |
| P2 | label 未与控件关联 | `/inventory/skus → 新建库存商品` | 1 个 <label> 既未包裹控件也没有 for 属性，辅助技术无法把字段名念给用户 | `产品编号` |
| P2 | 数值输入无浏览器级边界约束 | `/inventory/skus → 新建库存商品` | 6/8 个数值输入既不是 type=number 也没有 min 属性，负数与超大值只能等服务端拒绝 | `第1个数值框 / 第2个数值框 / 第3个数值框 / 第4个数值框` |
| P2 | label 未与控件关联 | `/inventory/suppliers → 新建供应商` | 5 个 <label> 既未包裹控件也没有 for 属性，辅助技术无法把字段名念给用户 | `供应商名称 * / 联系人 / 联系电话 / 地址 / 备注` |
| P2 | 数值输入无浏览器级边界约束 | `/inventory/docs → 新建库存单据` | 1/1 个数值输入既不是 type=number 也没有 min 属性，负数与超大值只能等服务端拒绝 | `数量` |
| P2 | label 未与控件关联 | `/inventory/promotions → 报货福利方案` | 13 个 <label> 既未包裹控件也没有 for 属性，辅助技术无法把字段名念给用户 | `方案编号 / 方案名称 * / 规则类型 / 适用市场 / 开始日期 *` |
| P2 | 必填项无标记 | `/inventory/operations/supply-chain → 品项公司报货需求` | 表单共 6 个字段，既无 * 标记也无 required/aria-required —— 用户只能靠提交报错试出必填项 | `供应链库存主体 / 报货日期 / 供应链商品 / 数量 / 明细备注 / 备注` |
| P2 | 数值输入无浏览器级边界约束 | `/inventory/operations/supply-chain → 品项公司报货需求` | 1/1 个数值输入既不是 type=number 也没有 min 属性，负数与超大值只能等服务端拒绝 | `第1个数值框` |
| P2 | 必填项无标记 | `/inventory/operations/supply-chain → 品项公司发货` | 表单共 6 个字段，既无 * 标记也无 required/aria-required —— 用户只能靠提交报错试出必填项 | `采购订单 / 发货总部 / 发货日期 / 物流公司 / 物流单号 / 备注` |
| P2 | 必填项无标记 | `/inventory/operations/market → 市场退货申请` | 表单共 9 个字段，既无 * 标记也无 required/aria-required —— 用户只能靠提交报错试出必填项 | `退货主体 / 回库主体 / 退货日期 / 商品 / 来源批次 / 数量` |
| P2 | 数值输入无浏览器级边界约束 | `/inventory/operations/market → 市场退货申请` | 1/1 个数值输入既不是 type=number 也没有 min 属性，负数与超大值只能等服务端拒绝 | `第1个数值框` |
| P2 | 必填项无标记 | `/inventory/operations/market → 自采产品入库` | 表单共 13 个字段，既无 * 标记也无 required/aria-required —— 用户只能靠提交报错试出必填项 | `入库市场 / 供应商 / 入库日期 / 收据附件地址 / 自采商品 / 数量` |
| P2 | 数值输入无浏览器级边界约束 | `/inventory/operations/market → 自采产品入库` | 3/3 个数值输入既不是 type=number 也没有 min 属性，负数与超大值只能等服务端拒绝 | `第1个数值框 / 资料价或本次价格 / 第3个数值框` |
| P2 | 必填项无标记 | `/inventory/operations/store → 门店报货` | 表单共 7 个字段，既无 * 标记也无 required/aria-required —— 用户只能靠提交报错试出必填项 | `报货门店 / 所属市场 / 报货日期 / 商品 / 数量 / 明细备注` |
| P2 | 数值输入无浏览器级边界约束 | `/inventory/operations/store → 门店报货` | 1/1 个数值输入既不是 type=number 也没有 min 属性，负数与超大值只能等服务端拒绝 | `第1个数值框` |
| P2 | 提交按钮未在提交期间禁用 | `/inventory/operations/store → 门店报货（防重复提交）` | 按钮在提交过程中未见 disabled/aria-busy，快速双击存在重复建单风险（各表单内部有 saving 标志，但未反映到可访问性属性上） | — |

## 复核说明

本报告由启发式规则自动生成，**每条都需人工复核定性**为「真问题 / 设计如此 / 误报」。
规则只负责摆出可核对的事实（字段名、控件类型、页面路径、源码位置），不替人下结论。

其中 P0 两条与 P1 三条已在链路测试中实测复现，不是静态推测：

- 批次下拉卡死 → `inv-05-transfers.spec.ts` / `inv-90-probe-lot-loading.spec.ts`
- 员工下拉恒空 → `inv-07-staff-purchase-and-self-purchase.spec.ts`（并已在 dev 库直接执行原 SQL 复现报错）
- 盘点不记账面数 → `inv-06-stocktake-and-loss.spec.ts`
- 供货商无外键 → `inv-01-master-data.spec.ts`
- 错误提示脱敏 → `inv-02-supply-chain-stock.spec.ts`
