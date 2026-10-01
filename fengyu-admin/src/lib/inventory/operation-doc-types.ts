import { INVENTORY_GENERIC_DOC_TYPES } from './types'
import type { InventoryCoreDocStatus, InventoryDocType, InventoryLocationType } from './types'

/**
 * 办理台业务卡片 id（#190）。
 *
 * 原先定义在 `inventory-operations-page.tsx` 内部，移到这里是为了让映射表能用
 * `Record<InventoryOperationId, …>` 把「新增业务卡片必须补单据映射」变成编译期约束 ——
 * 漏一条 TS 直接报错，不靠人记。
 */
export const INVENTORY_OPERATION_IDS = [
  'store-request',
  'market-report',
  'item-company-request',
  'purchase-order',
  'market-report-summary',
  'company-shipment',
  'market-receipt',
  'supply-chain-receipt',
  'supply-chain-purchase-cancel',
  'store-allocation',
  'store-receipt',
  'store-return',
  'market-return',
  'store-return-approval',
  'market-return-approval',
  'staff-purchase',
  'supply-chain-staff-purchase',
  'self-purchase',
  'external-outbound',
  // 库存转换仅供应链可做（#343）：市场 / 门店两张转换卡已下线
  'supply-chain-conversion',
  'shipment-cancel',
  'shipment-cancel-approval',
] as const
export type InventoryOperationId = (typeof INVENTORY_OPERATION_IDS)[number]

/**
 * 单据 Tab 一段（produced / inbox）的过滤条件。
 *
 * 两段走的是 engine 里**同一个** `listInventoryCoreDocs`，字段含义完全一致，
 * 区别只在语义：produced = 本业务产出的单，inbox = 本业务要处理的上游待办单。
 */
export interface InventoryOperationDocFilter {
  /** 本段要查的单据类型。多个时合并展示（转换类一次产出出库 + 入库两张）。 */
  docTypes: readonly InventoryDocType[]
  /**
   * 状态收窄。produced 侧给「本身不产出新单、只改目标单状态」的业务用（关闭采购、审批撤回），
   * 以及可存草稿的报货类（市场报货 / 门店报货，#348：produced 只列已完成，草稿在 inbox）；
   * 其余业务不限状态。inbox 侧则**必须**带（见 `InventoryOperationDocQuery.inbox` 的不变量 1）。
   */
  statuses?: readonly InventoryCoreDocStatus[]
  /**
   * 层级收窄。`库存转换出库` / `库存转换入库` 不按层级分单据类型；#343 起新建只在总部，
   * 但市场 / 门店的存量转换单仍在（只禁新建），只按 docType 查会让供应链办理台看到它们。
   */
  locationType?: InventoryLocationType
  /**
   * 方向收窄。**inbox 段必填**（见 `InventoryOperationDocQuery.inbox` 的不变量 4），
   * produced 段不填。
   *
   * engine 的单据可见性是「source **或** target 在 scope」—— 发货方和收货方都看得见
   * 自己经手的单，这对 produced 是对的。但待办区问的是另一件事：这张单轮不轮得到我动手。
   * 服务端的动作一律拿**单边**校验（见各条 inbox 注释里的行号），所以不带方向维时，
   * **对端**会在「待我处理」里拿到一张带行内按钮的单：点一次 PERMISSION_DENIED，
   * 刷新后还在，同时把待办角标一起算多。
   *
   * 值就是「服务端那句 assert 拿哪一端」，别按卡片标题猜：
   * 收货类全是 target，唯独撤回审批是 source（审批人动的是总部发货方的库存）。
   */
  scopeRole?: 'source' | 'target'
  /**
   * 仅保留发起过撤回申请的单据（`cancellation_request_reason` 非空）。
   * 撤回类业务不产出新单，靠这个标记把「被本业务经手过的发货单」跟普通发货单区分开。
   *
   * 类型是 `true` 而非 `boolean`：这个条件只有收窄一个方向，写 `false` 在 engine 里
   * 会退化成不过滤（放宽），与字面意思相反 —— 从类型上堵掉这个三态陷阱。
   */
  cancellationRequested?: true
  /**
   * 仅保留**还有未入库明细**的采购订单：存在 `COALESCE(fulfilled_quantity,0) < quantity` 的明细。
   *
   * #194 时它按 market_id 分流，因为那时市场行不经供应链入库、混合单会长期停在「待收货」。
   * #335 起所有行都经供应链采购入库、完结只由入库推动，正常数据下这条不再收窄结果集，
   * 保留作防御（见 engine 同名字段注释）。
   *
   * 类型是字面量而不是 `boolean` / 开放字符串：与 `cancellationRequested` 同理，
   * 这个条件只有收窄一个方向，别留出能写进去却退化成不过滤的值。
   */
  pendingItemScope?: 'supply-chain' | 'company-shipment'
}

/**
 * 业务 → 单据 Tab 的两段式查询（#192）。
 *
 * #190 只有 produced 一段（「本业务产出的单」），结果是待审批 / 待收货这些
 * **真正需要人动手**的单一张也不在办理台里 —— 它们的产出方是上游业务。
 * 甲方 2026-09-21 拍板改成两段：produced 语义不变，inbox 放「动作归属在本办理台、
 * 但单据由上游产出」的待办。
 */
export interface InventoryOperationDocQuery {
  produced: InventoryOperationDocFilter
  /**
   * 「待我处理」段。四条不变量，写新条目前逐条对：
   *
   * 1. **必须带 `statuses`，且只能是可操作态**（`待审批` / `待收货`）。不限状态会把
   *    已完成 / 已驳回 / 已取消的终态单倒进待办区 —— 用户点进去每一张都报
   *    `INVALID_STATE`，待办区反而成了噪音源。
   *    唯一例外是 `company-shipment` 的「待发货」段（#336）：市场报货单的「已完成」
   *    是**可发货态**（createItemCompanyShipment 只认已完成的报货单），可操作性由
   *    `pendingItemScope: 'company-shipment'`（仍有正常未发量）收窄，二者必须同时出现。
   *    另一类是报货草稿（#348）：`草稿` 本身就是可操作态（继续编辑 / 提交 / 删除）。
   * 2. inbox 与 produced **允许同 docType，但 statuses 必须互斥**。
   *    命中两条，都是「本身不产出新单、只改目标单状态」的业务（两段自然同 docType）：
   *    `shipment-cancel-approval`（品项公司发货：已取消 vs 待审批）与
   *    `supply-chain-purchase-cancel`（采购订单：已取消 vs 待收货）。
   *    同一张单在两段里表达的是两件事（本业务处理过 vs 待我处理），
   *    状态一旦有交集，同一张单会在两个区块同时出现。
   * 3. **只给「动作归属在本办理台、单据由上游产出」的业务写。** 建单类业务
   *    （purchase-order / store-allocation / market-report…）的
   *    上游来源单**不进** inbox：它们在建单表单的候选单选择器（#338 服务端检索）里已经可选，
   *    而待办区没有任何行内动作可对它们做，列出来只是重复。
   *    例外同样只有 `company-shipment`（#336 会议 §2.8 与验收要求「待发货」待办段）：
   *    它配「去发货」跳转动作，把报货单带回发货表单预选。
   *    报货草稿（#348）不算上游来源单：它是本业务自己没提交的单，待办区配「继续编辑」「删除草稿」。
   * 4. **必须带 `scopeRole`**，值 = 对应动作在服务端拿哪一端做 scope 断言。
   *    engine 的可见性是双端 OR，而动作校验是单边，两者不一致就会把**对端**的单
   *    列成「待我处理」并渲染出行内按钮 —— 点了必 PERMISSION_DENIED，刷新后还在，
   *    待办角标也跟着算多。写之前去 `business.ts` / `engine.ts` 读那句 assert，别猜。
   *
   * 每条 inbox 的 docTypes + statuses + scopeRole 都对齐服务端事务内的断言（见下方逐条注释），
   * 不是按卡片标题猜的 —— 猜错的代价是「列出服务端必拒的单，点一次报一次错」。
   */
  inbox?: InventoryOperationDocFilter
}

/**
 * 业务 → 单据 Tab 两段查询（#190 定 produced，#192 补 inbox）。
 *
 * produced 每条都对齐 `src/lib/inventory/business.ts` 里该业务 `insertDocHeader` 实际写入的
 * `docType`，不是按卡片标题猜的。改业务的产出单据类型时必须同步这里。
 * inbox 每条都对齐该业务动作在事务内的 docType/status 断言（行号见各条注释）。
 */
export const INVENTORY_OPERATION_DOC_QUERY: Record<InventoryOperationId, InventoryOperationDocQuery> = {
  // —— 供应链 ——
  'item-company-request': { produced: { docTypes: ['品项公司报货需求'] } },
  // 供应链跨市场汇总各市场报货需求（#193），是采购订单的来源之一。
  'market-report-summary': { produced: { docTypes: ['市场报货汇总'] } },
  /*
   * `供应链采购订单` 已于 #194 并入 `采购订单`（migration 0043 收敛存量 / 0044 收紧约束），
   * 原先的 supply-chain-purchase-order 业务卡片也一并去掉了。
   * #335 起所有行都走供应链采购入库，`market_id` 只是来源追溯标记。
   */
  'purchase-order': { produced: { docTypes: ['采购订单'] } },
  'company-shipment': {
    produced: { docTypes: ['品项公司发货'] },
    /*
     * 「待发货」：仍有正常未发量的市场报货单（#336）。对齐 `createItemCompanyShipment`：
     * `report.docType !== '市场报货' || report.status !== '已完成'` → INVALID_STATE；
     * 未发量 = 报货数量 − 「市场报货发货」直连血缘（目标单未取消），与 pendingItemScope 同口径。
     * 「已完成」是报货单的可发货态，不是终态待办（不变量 1 的唯一例外，靠 pendingItemScope 收窄）。
     *
     * scopeRole=target：`assertLocationWritable(session, source)` 断的是发货总部，
     * 而服务端要求 `report.targetOrgNodeId === source.orgNodeId` —— 即报货单的 target 端。
     * 不收窄的话报货发起方市场会在自己的待办里看到「去发货」，点进去必 PERMISSION_DENIED。
     */
    inbox: {
      docTypes: ['市场报货'],
      statuses: ['已完成'],
      scopeRole: 'target',
      pendingItemScope: 'company-shipment',
    },
  },
  'supply-chain-receipt': {
    produced: { docTypes: ['供应链采购入库'] },
    /*
     * 待我收的采购订单。对齐 `receiveSupplyChainPurchaseOrder`：
     * `order.docType !== '采购订单' || order.status !== '待收货'` → INVALID_STATE。
     * 「部分入库」是「待收货」的派生标签（#335），同样在此列。
     * pendingItemScope 只收窄到还有未入库行的单（#335 后正常数据下不改变结果集，保留作防御）。
     *
     * scopeRole=target：`assertLocationWritable(session, supplyChain)`，
     * 而 supplyChain 就是 `order.targetOrgNodeId`（同函数上方 `order.targetOrgNodeId
     * !== supplyChainLocationId` 那道一致性检查钉死了这层等价）。
     * ⚠️ 采购订单的 `source_org_node_id` 恒为 NULL（createPurchaseOrder 显式写 null，
     * 归属全下沉到明细行），所以今天这条收窄不改变任何结果集。**照样要写**：
     * 它表达的是「本业务只认 target 端」这个不变量，而不是对当前数据形状的优化；
     * 哪天单头重新挂上 source，漏掉它就是一个静默的越权待办。
     */
    inbox: {
      docTypes: ['采购订单'],
      statuses: ['待收货'],
      scopeRole: 'target',
      pendingItemScope: 'supply-chain',
    },
  },
  // 关闭采购不产出新单，只把采购订单置为已取消（类型随 #194 从「供应链采购订单」并成「采购订单」）。
  'supply-chain-purchase-cancel': {
    produced: { docTypes: ['采购订单'], statuses: ['已取消'] },
    /*
     * 待关闭的采购订单。对齐 `cancelSupplyChainPurchaseOrder`：
     * `order.docType !== '采购订单' || order.status !== '待收货'` → INVALID_STATE。
     *
     * ⚠️ 与上一条不同，这里**刻意不加 pendingItemScope**：关闭作用于整单，
     * 关单的拒绝条件在事务内逐行判定，SQL 表达不划算。而且排掉之后
     * 操作员会找不到那张关不掉的单、也不知道为什么，比点一次拿到明确报错更难排障。
     * （#336 起发货直连市场报货单，「发货量超过已入库量」这条关单障碍已随之删除。）
     *
     * scopeRole=target：`cancelSupplyChainPurchaseOrder` 里
     * `supplyChainLocationId = order.targetOrgNodeId` → `assertLocationWritable(supplyChain)`，
     * 与上一条同源（同为采购订单的 target 端；source 恒 NULL，今天同样是空转）。
     */
    inbox: { docTypes: ['采购订单'], statuses: ['待收货'], scopeRole: 'target' },
  },
  // 审批市场退货 → 货回供应链库，产出供应链退货入库单（business.ts: approveReturnForRestock）。
  'market-return-approval': {
    produced: { docTypes: ['供应链退货入库'] },
    /*
     * 待我审批的市场退货。对齐 `approveReturnForRestock`：
     * `!['院退货','市场退货'].includes(returnDoc.docType) || returnDoc.status !== '待审批'`，
     * 随后 `assertLocationWritable(session, target)` —— 市场退货的 target 是总部，
     * 所以这条归供应链办理台。
     *
     * scopeRole=target 在这条上**实打实在挡人**（不像采购那两条是空转）。
     * 关键在于动作级权限拦不住它：`approveReturnForRestock` /`rejectReturnForRestock` 是
     * `withAnyPermission(['inventory:supply_chain_approve','inventory:market_approve'])`，
     * 所以持 market_approve 的**市场审批人**能过动作闸；而市场退货的 source 就是它自己的市场，
     * 单据也在它 scope 内。不收窄的话，退货发起方会在「待我处理」里看到自己刚提的退货单 +
     * 审批 / 驳回两个按钮 —— 点下去只剩 `assertLocationWritable(总部)` 这一道，
     * 必抛 PERMISSION_DENIED，等于给申请人渲染了一对自批自的假按钮。
     */
    inbox: { docTypes: ['市场退货'], statuses: ['待审批'], scopeRole: 'target' },
  },
  /*
   * 审批通过 → 发货单变「已取消」，这是本业务唯一稳定的产出（甲方 2026-09-19 拍板表
   * 也只写了「仅已取消」）。叠 cancellationRequested 排除其它途径取消的发货单。
   *
   * ⚠️ 驳回**刻意不在此列**，别再"顺手补上"：驳回只是把 status 改回「待收货」
   * （`rejectItemCompanyShipmentCancellation`，不清 reason），而「待收货」会继续演进 ——
   * 市场照常收货后变「已完成」，那张被驳回过的单又会从 Tab 里消失。
   * 用会变的当前状态表达"审批处理过"这件既成事实，口径必然不自洽。
   * 审批人要复核驳回记录，目前去操作日志查；是否要单独做一个稳定入口已回填 issue 等甲方拍板。
   */
  'shipment-cancel-approval': {
    produced: {
      docTypes: ['品项公司发货'],
      statuses: ['已取消'],
      cancellationRequested: true,
    },
    /*
     * 待我审批的撤回申请。对齐 `approveItemCompanyShipmentCancellation`：
     * `shipment.docType !== '品项公司发货' || shipment.status !== '待审批'` → INVALID_STATE，
     * 紧接着 `required(shipment.cancellationRequestReason, '撤回申请原因')`。
     *
     * ⚠️ `cancellationRequested` 不是装饰：marker 为空时服务端必拒，
     * 不加就会把「因别的原因停在待审批」的发货单也列进来。
     * ⚠️ 本条「inbox 与 produced 同 docType」，互斥全靠 statuses（已取消 vs 待审批）。
     * 放宽任一段，同一张单会在两个区块同时出现（另一条同型的是
     * supply-chain-purchase-cancel）。
     *
     * ⚠️ scopeRole=**source**，全表唯一的一条 —— 别照着别条抄成 target。
     * 审批撤回要回滚的是**总部发货方**的库存，所以 approve/reject 两个函数都是
     * `assertType(source, '总部', '发货主体')` + `assertLocationWritable(session, source)`；
     * 而品项公司发货的 target 是收货市场。写成 target 的话，供应链审批人（scope 只有总部）
     * 会一张待审批的单都看不到 —— 本卡片直接失效；反过来不写，申请方市场
     * （target 在 scope）会拿到一对点了必 403 的审批按钮。
     */
    inbox: {
      docTypes: ['品项公司发货'],
      statuses: ['待审批'],
      scopeRole: 'source',
      cancellationRequested: true,
    },
  },
  'supply-chain-conversion': {
    produced: {
      docTypes: ['库存转换出库', '库存转换入库'],
      locationType: '总部',
    },
  },
  'external-outbound': { produced: { docTypes: ['非凤御市场出库'] } },
  'supply-chain-staff-purchase': { produced: { docTypes: ['供应链员工购出库'] } },

  // —— 市场 ——
  'market-report': {
    /*
     * produced 只列「已完成」（#348）：草稿在 inbox 段，删除的草稿（草稿 → 已取消）不再出现在办理台里，
     * 单据中心仍按全状态可查。与 inbox 的「草稿」互斥（不变量 2）。
     */
    produced: { docTypes: ['市场报货'], statuses: ['已完成'] },
    /*
     * 「草稿」（#348）：本市场存了未提交的市场报货单。对齐 `lockMarketReplenishmentDraft`：
     * `draft.docType !== '市场报货' || draft.status !== '草稿'` → INVALID_STATE；
     * 编辑 / 提交 / 删除都断 `assertLocationWritable(session, market)`，market 即单头 source ⇒ scopeRole=source。
     */
    inbox: { docTypes: ['市场报货'], statuses: ['草稿'], scopeRole: 'source' },
  },
  'market-receipt': {
    produced: { docTypes: ['市场采购入库'] },
    /*
     * 待我收的品项公司发货单。对齐 `receivePhysicalShipment`：
     * `shipment.docType !== expectedDocType || shipment.status !== '待收货'` → INVALID_STATE，
     * expectedDocType 由 `receiveItemCompanyShipment` 固定为
     * `receivePhysicalShipment(session, input, '品项公司发货', '市场采购入库')`。
     *
     * scopeRole=target：`receivePhysicalShipment` 只断 `assertLocationWritable(session, target)`
     * （source 仅用来取批次，不参与鉴权）。
     * 单绑定的市场操作员命中不了这个坑（发货方总部不在它 scope 里，单子本来就只看得见发给
     * 自己的那些）；挡的是**混合绑定**会话 —— 同时绑了总部与市场 X 的账号，scope 里有总部，
     * 于是发往市场 Y 的在途单也可见，不收窄就会列出来并渲染收货按钮，点下去
     * `assertLocationWritable(市场 Y)` 必 403。
     * ⚠️ 与上面的 `shipment-cancel-approval` 是同一个 docType 的**反向**：
     * 同一张品项公司发货单，收货归 target、撤回审批归 source，两条不能互抄。
     */
    inbox: { docTypes: ['品项公司发货'], statuses: ['待收货'], scopeRole: 'target' },
  },
  'store-allocation': { produced: { docTypes: ['分院配货'] } },
  // 审批门店退货 → 货回市场库，产出市场退货入库单。
  'store-return-approval': {
    produced: { docTypes: ['市场退货入库'] },
    /*
     * 待我审批的门店退货。与 market-return-approval 同一个
     * `approveReturnForRestock`，靠 docType 分叉：院退货的 target 是市场，归市场办理台。
     *
     * scopeRole=target 同上（approveReturnForRestock / rejectReturnForRestock 都断 target）。
     * 市场审批人的 scope 覆盖下属门店，target 就是它自己，所以**不会因此少看单**。
     * 这一条今天是防御性的：能进这张卡的 `inventory:market_approve` 账号，
     * 其 scope 恰好同时罩住 source（门店）与 target（市场）。
     * 写它是为了让「方向 = 服务端那句 assert」这条规则在表里无例外 ——
     * 有例外就会有人照着例外抄。真正在挡人的是上面（供应链段）那条 market-return-approval。
     */
    inbox: { docTypes: ['院退货'], statuses: ['待审批'], scopeRole: 'target' },
  },
  'market-return': { produced: { docTypes: ['市场退货'] } },
  /*
   * 申请撤回不产出新单，只把发货单打上撤回申请标记（status → 待审批）。
   * 这里**刻意不限状态**，列出的是本 scope 内申请过撤回的全部单据，共四种下场：
   * 待审批（还没批）、已取消（批了）、待收货（驳回了）、**已完成（驳回后照常收了货）**。
   * 最后一种也留着是有意的 —— marker 只在 `requestItemCompanyShipmentCancellation`
   * 写入，`rejectItemCompanyShipmentCancellation` 与后续 `receivePhysicalShipment`
   * 都不会清它，查"这边申请过哪些撤回"时它就该在。
   * 这与审批侧只认「已取消」不矛盾：那边表达的是审批产出，这边表达的是申请足迹。
   *
   * ⚠️ 是**团队视角**不是个人视角：没有按 `cancellation_requested_by` 过滤，
   * 同市场其他操作员提的撤回申请也会出现（都在 scope 内，不是越权）。
   * 要不要收窄到"只看自己提的"已回填 issue 等甲方拍板。
   *
   * 无 inbox：审批动作在供应链侧（`assertLocationWritable(session, source)`，source 是总部），
   * 申请方这边没有任何行内动作可做。
   */
  'shipment-cancel': { produced: { docTypes: ['品项公司发货'], cancellationRequested: true } },
  'staff-purchase': { produced: { docTypes: ['员工购出库'] } },
  'self-purchase': { produced: { docTypes: ['自采产品入库'] } },

  // —— 门店 ——
  'store-request': {
    // 同 market-report（#348）：produced 只列已完成，草稿在 inbox，删除的草稿（已取消）不回到办理台
    produced: { docTypes: ['门店报货'], statuses: ['已完成'] },
    /*
     * 「草稿」（#348）：本门店存了未提交的门店报货单。对齐 `lockStoreReplenishmentDraft`：
     * 非门店报货 NOT_FOUND、`draft.status !== '草稿'` → INVALID_STATE；
     * 编辑 / 提交 / 删除都断 `assertLocationWritable(session, store)`，store 即单头 source ⇒ scopeRole=source。
     */
    inbox: { docTypes: ['门店报货'], statuses: ['草稿'], scopeRole: 'source' },
  },
  'store-receipt': {
    produced: { docTypes: ['院入库'] },
    /*
     * 待我收的分院配货单。对齐 `receiveStoreAllocation` →
     * `receivePhysicalShipment(session, input, '分院配货', '院入库')`。
     *
     * ⚠️ 门店层另一批更大的待办是「分院调货出库 · 待收货」，它**不在这条**：
     * 调货收货产出的是「分院调货入库」而不是「院入库」，塞进来 produced/inbox 会语义错配。
     * 它挂在通用业务卡「门店调拨」（`generic:分院调货出库`）上，见
     * `INVENTORY_GENERIC_OPERATION_INBOX`。
     *
     * scopeRole=target：同一个 `receivePhysicalShipment`，断的是收货门店。
     * 配货方市场的 scope 覆盖下属门店，双端都在它的 scope 里，所以这条挡不住市场账号
     * （它本来就能替门店收货，`receiveStoreAllocation` 也确实放行）——
     * 挡的是**跨市场**的场景：A 市场给自己门店的配货单，source 在 A 的 scope，
     * 若某账号只绑到 A 而收货门店已划到 B，不收窄就会列出一张它收不了的单。
     */
    inbox: { docTypes: ['分院配货'], statuses: ['待收货'], scopeRole: 'target' },
  },
  'store-return': { produced: { docTypes: ['院退货'] } },
}

/*
 * ────────── 通用建单业务（#191） ──────────
 *
 * 10 张「通用业务」卡片（内部领用 / 报损 / 盘点 / 调货 / 顾客产品出入库）与上面 22 个
 * 内置业务的区别：它们没有专属的业务函数，就是**直接建一张某类型的单**。
 * 所以 id 直接由 docType 派生、映射天然为「查这一种单据」，零维护。
 *
 * ⚠️ 这批卡片在 #191 之前借用了三个转换业务的 id 当 React key，一旦哪天被改成内嵌表单，
 * 「市场产品报损」的单据 Tab 会直接列出库存转换单 —— 页面完全正常，数据完全不对。
 * 独立 id 就是为了堵死这条路。
 */
export const GENERIC_OPERATION_PREFIX = 'generic:'

/** 通用建单类型（`INVENTORY_GENERIC_DOC_TYPES` 的成员），供卡片定义做编译期约束。 */
export type InventoryGenericDocType = (typeof INVENTORY_GENERIC_DOC_TYPES)[number]

export type InventoryGenericOperationId = `${typeof GENERIC_OPERATION_PREFIX}${string}`

export function genericOperationId(docType: InventoryDocType): InventoryGenericOperationId {
  return `${GENERIC_OPERATION_PREFIX}${docType}`
}

/**
 * 解析通用业务 id → docType。**白名单校验在这里**：
 * 只认 `INVENTORY_GENERIC_DOC_TYPES`（那 9 种无需上游血缘的类型，#350 移出院顾客产品出库），
 * 拼一个 `generic:品项公司发货` 进来会被拒 —— 否则就能从通用入口绕过
 * 专用服务的数量、价格、批次校验去建业务单。
 */
export function asGenericDocType(value: string | undefined | null): InventoryDocType | null {
  if (!value) return null
  return (INVENTORY_GENERIC_DOC_TYPES as readonly string[]).includes(value)
    ? (value as InventoryDocType)
    : null
}

export function parseGenericOperationId(operationId: string): InventoryDocType | null {
  if (!operationId.startsWith(GENERIC_OPERATION_PREFIX)) return null
  return asGenericDocType(operationId.slice(GENERIC_OPERATION_PREFIX.length))
}

/** 任一业务卡片 id（内置表单业务 ∪ 通用建单业务）。 */
export type InventoryAnyOperationId = InventoryOperationId | InventoryGenericOperationId

/**
 * 通用业务的「待我处理」段（#192）。
 *
 * 通用业务的 produced 是从 docType 派生的（零维护），inbox 却**不能**派生 ——
 * 它要回答的是「这个类型的单在哪个状态下轮到本层级动手」，那是业务语义不是类型语义。
 * 所以这里是一张显式的小表，键必须是 `INVENTORY_GENERIC_DOC_TYPES` 的成员。
 *
 * 当前两条：门店调拨（下）与市场间调货（#340，见下文）。
 * `分院调货出库` 在门店层有 6 条「待收货」（dev 库统计），是门店层最大的一批
 * 待办，收货走通用的 `confirmInventoryCoreReceive`（`分院调货出库` 在
 * `INVENTORY_GENERIC_DOC_TYPES` 里，是少数能用 generic 三件套的场景）。
 *
 * ⚠️ 与内置表的不变量 2 不同，这条 inbox **与 produced 刻意重叠**：
 * 门店调拨这张卡既建单又收货，同一张待收货的调货出库单既是「本业务产出」
 * 也是「本业务待办」，两段都该看得到。所以 produced 不做状态排除 ——
 * 排掉「待收货」等于让操作员看不见自己刚建的单。
 *
 * ⚠️ 不变量 4（`scopeRole: 'target'`）在这条上**最要命**，因为调货的两端是同层级的
 * 两个门店，而动作级权限对两端一视同仁：`confirmInventoryCoreReceive` 是
 * `withAnyPermission(['inventory:market_operate','inventory:store_operate'])`，
 * 发货门店照样过闸，唯一拦它的是事务里那句
 * `assertOrgNodeVisible(session, head.target_org_node_id)` —— 只认收货端。
 * 而 engine 的可见性是双端 OR，于是不带方向维时，**发货门店**（scope 只有自己）
 * 会把自己刚发出去的待收货调货单也列进「待我处理」，还渲染出「确认收货」按钮：
 * 点一次 PERMISSION_DENIED、刷新后那行照旧在，操作员无路可走，待办角标也跟着虚高。
 * 上级市场账号不受影响（两端都在它 scope 里，它本来就能替门店收货）。
 * produced 段不加 scopeRole，发货方仍在产出区看得见自己的单，这是对的。
 *
 * `市场间调货出库 · 待收货`（#340，用户 2026-09-24 拍板进待办）与门店调拨同构：
 * 市场办理台「市场间调货」卡既建单又收货，收货同样走 `confirmInventoryCoreReceive`，
 * 同样只断 target —— 所以 scopeRole 同为 `'target'`。缺了它，调出市场会在自己的待办里
 * 看到发出去的单并拿到一个点了必 PERMISSION_DENIED 的「确认收货」。
 *
 * 其余两种带流转状态的通用类型（`市场产品报损` / `院产品报损` 待审批）**仍未登记**：
 * 要不要一并铺开是待拍板项。补的时候连同 `INVENTORY_GENERIC_OPERATION_INBOX_ACTIONS`
 * 一起补，两张表由单测钉住键集合一致；⚠️ 审批类的方向是 `'source'`，别照抄上面两条。
 */
export const INVENTORY_GENERIC_OPERATION_INBOX = {
  分院调货出库: { docTypes: ['分院调货出库'], statuses: ['待收货'], scopeRole: 'target' },
  市场间调货出库: { docTypes: ['市场间调货出库'], statuses: ['待收货'], scopeRole: 'target' },
} as const satisfies Partial<Record<InventoryGenericDocType, InventoryOperationDocFilter>>

/**
 * 业务 id → 单据 Tab 的查询条件。内置业务查表，通用业务按 docType 直接派生。
 * 返回 `null` = 不认识这个 id，调用方必须 fail-closed（别退化成「不加过滤」）。
 */
export function resolveOperationDocQuery(operationId: string): InventoryOperationDocQuery | null {
  const genericDocType = parseGenericOperationId(operationId)
  if (genericDocType) {
    const inbox: InventoryOperationDocFilter | undefined = (
      INVENTORY_GENERIC_OPERATION_INBOX as Partial<Record<string, InventoryOperationDocFilter>>
    )[genericDocType]
    // `parseGenericOperationId` 已经把 docType 夹过 INVENTORY_GENERIC_DOC_TYPES 白名单，
    // 这里的索引不会被 `__proto__` 之类的键命中；但仍显式判 undefined，
    // 别让「表里没这条」退化成一个 docTypes 为 undefined 的 inbox 段（那在 engine 里是放宽）。
    return inbox ? { produced: { docTypes: [genericDocType] }, inbox } : { produced: { docTypes: [genericDocType] } }
  }
  return (INVENTORY_OPERATION_IDS as readonly string[]).includes(operationId)
    ? INVENTORY_OPERATION_DOC_QUERY[operationId as InventoryOperationId]
    : null
}

/*
 * ────────── 待办行内动作（#192） ──────────
 *
 * 纯数据、零 server import —— 本文件当前只 `import type … from './types'` 与
 * `INVENTORY_GENERIC_DOC_TYPES`，客户端组件可以直接 import。别往这里加
 * `engine.ts` / `business.ts` 的引用（它们带 `import 'server-only'`）。
 */

/**
 * 待办区一行上可能出现的动作种类。
 *
 * 草稿（#348）：市场报货与门店报货可存草稿，配「继续编辑」（跳回表单回填）与「删除草稿」（草稿 → 已取消）。
 * 两个动作按业务分派到各自的 Server Action（办理台 `DRAFT_DELETE_ACTIONS`），不能跨业务复用同一个 action。
 * 草稿只由专用服务产出（`saveMarketReplenishmentDraft` / `createStoreReplenishmentRequest(asDraft)`），通用建单（engine `defaultStatusForDoc`）
 * 仍然只产出 待审批 / 待收货 / 已完成，单测钉住。
 */
export const INVENTORY_INBOX_ACTION_KINDS = [
  'return-approve',
  'return-reject',
  'cancellation-approve',
  'cancellation-reject',
  'shipment-receive-full',
  'shipment-receive-goto',
  'purchase-receive-goto',
  'purchase-close',
  'generic-receive',
  'report-ship-goto',
  'draft-edit-goto',
  'draft-delete',
] as const
export type InventoryInboxActionKind = (typeof INVENTORY_INBOX_ACTION_KINDS)[number]

/**
 * 每个动作只在这个状态下出现。
 *
 * `inbox.statuses` 已经在服务端钉过一次（查不出别的状态的单），这里是**按钮矩阵的显式单源**：
 * 待办区的行渲染按 `INVENTORY_INBOX_ACTION_STATUS[kind] === row.status` 过滤，
 * 免得哪天 inbox 放宽了状态，按钮就跟着出现在点了必报错的行上。
 */
export const INVENTORY_INBOX_ACTION_STATUS: Record<InventoryInboxActionKind, InventoryCoreDocStatus> = {
  'return-approve': '待审批',
  'return-reject': '待审批',
  'cancellation-approve': '待审批',
  'cancellation-reject': '待审批',
  'shipment-receive-full': '待收货',
  'shipment-receive-goto': '待收货',
  'purchase-receive-goto': '待收货',
  'purchase-close': '待收货',
  'generic-receive': '待收货',
  // 市场报货单「已完成」即可发货（#336，见 company-shipment 的 inbox 注释）
  'report-ship-goto': '已完成',
  'draft-edit-goto': '草稿',
  'draft-delete': '草稿',
}

/** 内置业务 → 待办行内动作。键集合必须与「有 inbox 的内置业务」完全一致（单测钉住）。 */
export const INVENTORY_OPERATION_INBOX_ACTIONS = {
  'store-return-approval': ['return-approve', 'return-reject'],
  'market-return-approval': ['return-approve', 'return-reject'],
  'shipment-cancel-approval': ['cancellation-approve', 'cancellation-reject'],
  'market-receipt': ['shipment-receive-full', 'shipment-receive-goto'],
  'store-receipt': ['shipment-receive-full', 'shipment-receive-goto'],
  // 供应链采购入库要逐行核对效期（批号留空已自动生成，#345；效期推断不出来），
  // 所以只给「去收货」跳转，没有一键整单收货。
  'supply-chain-receipt': ['purchase-receive-goto'],
  'supply-chain-purchase-cancel': ['purchase-close'],
  // 发货要逐行选批次，只给「去发货」跳转（#336）
  'company-shipment': ['report-ship-goto'],
  // 草稿编辑要回表单重新汇总门店需求、重新取价，只能跳转；删除走确认弹窗（#348）
  'market-report': ['draft-edit-goto', 'draft-delete'],
  'store-request': ['draft-edit-goto', 'draft-delete'],
} as const satisfies Partial<Record<InventoryOperationId, readonly InventoryInboxActionKind[]>>

/** 通用业务 → 待办行内动作。键集合必须与 `INVENTORY_GENERIC_OPERATION_INBOX` 一致（单测钉住）。 */
export const INVENTORY_GENERIC_OPERATION_INBOX_ACTIONS = {
  分院调货出库: ['generic-receive'],
  市场间调货出库: ['generic-receive'],
} as const satisfies Partial<Record<InventoryGenericDocType, readonly InventoryInboxActionKind[]>>

/**
 * 业务 id → 待办行内动作清单。UI 只调这个，不要直接索引上面两张表 ——
 * 它们一张按 operationId 一张按 docType，直接索引就会在通用业务上静默拿到 `undefined`。
 * 不认识的 id 返回空数组（没有按钮），与 `resolveOperationDocQuery` 的 fail-closed 同向。
 */
export function resolveOperationInboxActions(operationId: string): readonly InventoryInboxActionKind[] {
  const genericDocType = parseGenericOperationId(operationId)
  if (genericDocType) {
    return (INVENTORY_GENERIC_OPERATION_INBOX_ACTIONS as Partial<Record<string, readonly InventoryInboxActionKind[]>>)[genericDocType] ?? []
  }
  if (!(INVENTORY_OPERATION_IDS as readonly string[]).includes(operationId)) return []
  return (INVENTORY_OPERATION_INBOX_ACTIONS as Partial<Record<string, readonly InventoryInboxActionKind[]>>)[operationId] ?? []
}
