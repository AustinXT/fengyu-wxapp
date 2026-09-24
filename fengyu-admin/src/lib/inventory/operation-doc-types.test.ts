import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  INVENTORY_GENERIC_OPERATION_INBOX,
  INVENTORY_GENERIC_OPERATION_INBOX_ACTIONS,
  INVENTORY_INBOX_ACTION_KINDS,
  INVENTORY_INBOX_ACTION_STATUS,
  INVENTORY_OPERATION_DOC_QUERY,
  INVENTORY_OPERATION_IDS,
  INVENTORY_OPERATION_INBOX_ACTIONS,
  genericOperationId,
  parseGenericOperationId,
  resolveOperationDocQuery,
  resolveOperationInboxActions,
  type InventoryInboxActionKind,
  type InventoryOperationId,
} from './operation-doc-types'
import { INVENTORY_DOC_STATUSES, INVENTORY_DOC_TYPES, INVENTORY_GENERIC_DOC_TYPES } from './types'

const businessSource = readFileSync(resolve(__dirname, 'business.ts'), 'utf8')
const engineSource = readFileSync(resolve(__dirname, 'engine.ts'), 'utf8')

/**
 * 截取 business.ts 里某个导出函数的函数体（到下一个顶层 `export` 为止）。
 *
 * 前提：business.ts 的顶层函数之间没有夹非 export 的 helper。真夹了的话
 * 那个 helper 会被并进上一个函数体，里面的 docType 字面量会被错误归属。
 * 当前文件结构满足这个前提；哪天不满足了，这里要换成真解析。
 */
function exportedFnBody(name: string): string {
  const start = businessSource.indexOf(`export async function ${name}(`)
  expect(start, `business.ts 里找不到 ${name}`).toBeGreaterThan(-1)
  const next = businessSource.indexOf('\nexport ', start + 1)
  return businessSource.slice(start, next === -1 ? undefined : next)
}

/**
 * 办理台「单据」Tab 的业务 → 产出单据类型映射（#190）。
 *
 * 这张表是从 `business.ts` 各业务 `insertDocHeader` 的 docType 逐条抄来的，抄错了
 * 编译器不会吭声（都是合法字面量），只会让用户在 Tab 里看到别的业务的单。
 * 所以这里的断言分两类：**表自身的完整性**，以及**与业务实现的对账**。
 */
describe('业务 → 产出单据类型映射（#190）', () => {
  it('每个业务卡片都登记了映射，且没有多余条目', () => {
    expect(Object.keys(INVENTORY_OPERATION_DOC_QUERY).sort()).toEqual([...INVENTORY_OPERATION_IDS].sort())
  })

  it('24 条全部有 produced 段 —— 少一条就是「那个业务的 Tab 查不加过滤」', () => {
    // #192 把映射改成两段式，produced 是必填。TS 会挡住漏写，但**不会**挡住
    // `produced: undefined as never` 之类的绕过，所以运行时再钉一遍。
    for (const operation of INVENTORY_OPERATION_IDS) {
      expect(INVENTORY_OPERATION_DOC_QUERY[operation].produced, operation).toBeDefined()
    }
  })

  it('docTypes 非空且都是合法单据类型', () => {
    // 空数组在 engine 里是 fail-closed（查不出任何单），放进映射表等于把某个业务的
    // Tab 永久变成空白页——只可能是写漏了，不可能是本意。
    // 两段都扫：inbox 的空 docTypes 会让待办区永远空白，同样只可能是写漏了。
    for (const [operation, query] of Object.entries(INVENTORY_OPERATION_DOC_QUERY)) {
      for (const [segment, filter] of [['produced', query.produced], ['inbox', query.inbox]] as const) {
        if (!filter) continue
        expect(filter.docTypes.length, `${operation}.${segment}`).toBeGreaterThan(0)
        for (const docType of filter.docTypes) {
          expect(INVENTORY_DOC_TYPES, `${operation}.${segment} → ${docType}`).toContain(docType)
        }
      }
    }
  })

  it('statuses 都是合法状态', () => {
    for (const [operation, query] of Object.entries(INVENTORY_OPERATION_DOC_QUERY)) {
      for (const [segment, filter] of [['produced', query.produced], ['inbox', query.inbox]] as const) {
        for (const status of filter?.statuses ?? []) {
          expect(INVENTORY_DOC_STATUSES, `${operation}.${segment} → ${status}`).toContain(status)
        }
      }
    }
  })

  it('三个层级的库存转换各自带 locationType，否则会串看别层的转换单', () => {
    // `库存转换出库` / `库存转换入库` 是三层共用的 docType（business.ts 的
    // createInventoryConversion 不按层级分类型），只按 docType 查，
    // 市场办理台会看到门店的转换单。locationType 是唯一的分层依据。
    const conversions: Array<[InventoryOperationId, string]> = [
      ['supply-chain-conversion', '总部'],
      ['market-conversion', '市场'],
      ['store-conversion', '门店'],
    ]
    for (const [operation, locationType] of conversions) {
      const query = INVENTORY_OPERATION_DOC_QUERY[operation]
      expect(query.produced.docTypes).toEqual(['库存转换出库', '库存转换入库'])
      expect(query.produced.locationType, operation).toBe(locationType)
    }
  })

  it('只有共用 docType 的转换业务需要 locationType，其余业务不画蛇添足', () => {
    // 多余的 locationType 会把本来该看到的单据筛掉（比如给「分院配货」加上
    // locationType=市场，source 是市场能过、但语义已经跑偏），属于静默丢数据。
    // 两段一起扫：inbox 侧同样不该出现 locationType（7 条 inbox 的 docType 都不跨层级共用）。
    const withLocationType = Object.entries(INVENTORY_OPERATION_DOC_QUERY)
      .filter(([, query]) => query.produced.locationType !== undefined || query.inbox?.locationType !== undefined)
      .map(([operation]) => operation)
      .sort()
    expect(withLocationType).toEqual(['market-conversion', 'store-conversion', 'supply-chain-conversion'])
  })

  it('不产出新单的三个业务靠 statuses / cancellationRequested 收窄，不会把全部同类单据倒出来', () => {
    // 关闭采购、撤回申请、撤回审批都只改目标单状态。不收窄的话，
    // 「关闭供应链采购」的 Tab 会列出全部采购订单，与「供应链采购订单」业务完全重合。
    expect(INVENTORY_OPERATION_DOC_QUERY['supply-chain-purchase-cancel'].produced).toEqual({
      docTypes: ['采购订单'],
      statuses: ['已取消'],
    })
    /*
     * 审批侧只认「已取消」= 甲方拍板表原文。别顺手把驳回态补进来：
     * 驳回只是把 status 改回「待收货」，而它会继续演进到「已完成」，
     * 用会变的当前状态表达"审批处理过"必然不自洽（同一张单过阵子自己就消失了）。
     */
    expect(INVENTORY_OPERATION_DOC_QUERY['shipment-cancel-approval'].produced).toEqual({
      docTypes: ['品项公司发货'],
      statuses: ['已取消'],
      cancellationRequested: true,
    })
    // 钉住上面那句「驳回态会继续演进」的前提：驳回写回待收货。
    expect(businessSource).toContain(`SET status = '待收货', rejected_by = `)
  })

  it('撤回 marker 永不被清 —— 两个撤回 Tab 的存在性全靠它', () => {
    /*
     * `cancellation_request_reason` 只在申请时写入，此后无论审批通过、驳回、还是
     * 驳回后照常收货，都不会被清空。这不是可有可无的细节：两个撤回类业务的 Tab
     * 全靠 `IS NOT NULL` 认单，哪天有人在某条 UPDATE 里顺手把它清了（看起来像是
     * "清理过期字段"的无害改动），两个 Tab 会**静默变空**，没有任何报错。
     */
    // 原生 SQL 写法（business.ts 全是这种）
    expect(businessSource).not.toMatch(/cancellation_request_reason\s*=\s*NULL/i)
    expect(businessSource).not.toMatch(/cancellation_request_reason\s*=\s*\$?\{?\s*null/i)
    // Drizzle 写法（`.set({ cancellationRequestReason: null })`）—— 换成驼峰就绕过上面两条，
    // 所以整个 inventory lib 都扫一遍，不只 business.ts。
    for (const file of ['business.ts', 'engine.ts']) {
      const source = readFileSync(resolve(__dirname, file), 'utf8')
      expect(source, `${file} 不得把撤回 marker 置空`).not.toMatch(/cancellationRequestReason:\s*null/i)
    }
    // 审批通过写的是**另一列** cancellation_reason —— 两列名字只差一个词，
    // 断言限定在审批函数体内，否则关闭采购那条 UPDATE 会替它蒙混过关。
    expect(exportedFnBody('approveItemCompanyShipmentCancellation')).toMatch(/cancellation_reason\s*=/)
    // 申请方刻意不限状态：marker 打上后无人清，四种下场（待审批 / 已取消 /
    // 待收货=被驳回 / 已完成=驳回后照常收货）都算申请足迹，都该看得到。
    // ⚠️ 是**当前 scope 内团队**的全部撤回申请，没有按 cancellation_requested_by
    // 收窄到"只看自己提的" —— 是否收窄已回填 issue 等甲方拍板。
    expect(INVENTORY_OPERATION_DOC_QUERY['shipment-cancel']).toEqual({
      produced: { docTypes: ['品项公司发货'], cancellationRequested: true },
    })
  })

  it('四组易混业务钉「函数 → docType」，互换映射必须转红', () => {
    // 存在性断言挡不住互换：把两个业务的 docType 对调，两个字面量都还在 business.ts 里，
    // 测试照样全绿，而用户在 Tab 里看到的是另一个业务的单。
    // 这几组名字只差「供应链」三个字，最容易抄反。
    // 注：原先的 supply-chain-purchase-order 已随 #194 并入 purchase-order
    //（两个 createPurchaseOrderFrom* 入口也合并成了 createPurchaseOrder）。
    const pairs: Array<[InventoryOperationId, string, string]> = [
      ['purchase-order', 'createPurchaseOrder', '采购订单'],
      ['market-report-summary', 'createMarketReportSummary', '市场报货汇总'],
      ['staff-purchase', 'createMarketStaffPurchase', '员工购出库'],
      ['supply-chain-staff-purchase', 'createSupplyChainStaffPurchase', '供应链员工购出库'],
    ]
    for (const [operation, fnName, docType] of pairs) {
      expect(INVENTORY_OPERATION_DOC_QUERY[operation].produced.docTypes, operation).toEqual([docType])
      expect(exportedFnBody(fnName), `${fnName} 应写入 ${docType}`).toContain(`docType: '${docType}'`)
    }
  })

  it('两个退货业务按发起方分叉，门店发起 → 院退货、市场发起 → 市场退货', () => {
    // 这两条共用 createReturnForRestock，靠 source.locationType 分叉，
    // 分叉写反了两个业务的 Tab 会互相串。
    const body = exportedFnBody('createReturnForRestock')
    expect(body).toMatch(/source\.locationType === '门店'[\s\S]*?docType = '院退货'/)
    expect(body).toMatch(/source\.locationType === '市场'[\s\S]*?docType = '市场退货'/)
    expect(INVENTORY_OPERATION_DOC_QUERY['store-return'].produced.docTypes).toEqual(['院退货'])
    expect(INVENTORY_OPERATION_DOC_QUERY['market-return'].produced.docTypes).toEqual(['市场退货'])
  })

  it('收货类业务映射到入库单，与 business.ts 的 receivePhysicalShipment 实参一致', () => {
    // 对账点：`receiveStoreAllocation` / `receiveItemCompanyShipment` 传给
    // receivePhysicalShipment 的**第 4 个实参**就是产出的入库单类型。
    // ⚠️ 两个调用点都要钉：只钉一个的话，另一个改成别的入库类型时，
    // 那个字面量仍散落在 business.ts 别处（前缀表、注释），存在性对账照样绿。
    expect(businessSource).toContain(`receivePhysicalShipment(session, input, '分院配货', '院入库')`)
    expect(businessSource).toContain(`receivePhysicalShipment(session, input, '品项公司发货', '市场采购入库')`)
    expect(INVENTORY_OPERATION_DOC_QUERY['store-receipt'].produced.docTypes).toEqual(['院入库'])
    expect(INVENTORY_OPERATION_DOC_QUERY['market-receipt'].produced.docTypes).toEqual(['市场采购入库'])
  })

  it('退货审批映射到回库单：门店退货回市场库、市场退货回供应链库', () => {
    // business.ts approveReturnForRestock：院退货 → 市场退货入库，否则 → 供应链退货入库。
    expect(businessSource).toContain(`returnDoc.docType === '院退货' ? '市场退货入库' : '供应链退货入库'`)
    expect(INVENTORY_OPERATION_DOC_QUERY['store-return-approval'].produced.docTypes).toEqual(['市场退货入库'])
    expect(INVENTORY_OPERATION_DOC_QUERY['market-return-approval'].produced.docTypes).toEqual(['供应链退货入库'])
  })

  it('12 个自建单业务 + 3 个转换业务逐条钉「哪个函数写哪个 docType」，互换任意两条都会转红', () => {
    /*
     * 存在性断言（下面那条用例）挡不住互换：把两个业务的 docType 对调，两个字面量
     * 都还在 business.ts 里，测试照样全绿，而用户在 Tab 里看到的是另一个业务的单。
     * 这里对**每个自己调 insertDocHeader 的业务**钉死「函数 → 类型」：
     * 12 条各有专属函数 + 3 个转换业务共用 createInventoryConversion（一次写两张单）。
     * 剩下 9 条各有专门断言：收货 ×2（receivePhysicalShipment 实参）、
     * 退货 ×2（按 source.locationType 分叉）、退货审批 ×2（三元）、撤回/关闭 ×3（不建单）。
     */
    const owned: Array<[InventoryOperationId, string, string]> = [
      ['store-request', 'createStoreReplenishmentRequest', '门店报货'],
      ['item-company-request', 'createItemCompanyReplenishment', '品项公司报货需求'],
      ['market-report', 'createMarketReplenishment', '市场报货'],
      ['purchase-order', 'createPurchaseOrder', '采购订单'],
      ['market-report-summary', 'createMarketReportSummary', '市场报货汇总'],
      ['company-shipment', 'createItemCompanyShipment', '品项公司发货'],
      ['supply-chain-receipt', 'receiveSupplyChainPurchaseOrder', '供应链采购入库'],
      ['store-allocation', 'createStoreAllocation', '分院配货'],
      ['staff-purchase', 'createMarketStaffPurchase', '员工购出库'],
      ['supply-chain-staff-purchase', 'createSupplyChainStaffPurchase', '供应链员工购出库'],
      ['self-purchase', 'createSelfPurchasedReceipt', '自采产品入库'],
      ['external-outbound', 'createExternalMarketOutbound', '非凤御市场出库'],
    ]
    for (const [operation, fnName, docType] of owned) {
      expect(INVENTORY_OPERATION_DOC_QUERY[operation].produced.docTypes, operation).toEqual([docType])
      expect(exportedFnBody(fnName), `${fnName} 应写入 ${docType}`).toContain(`docType: '${docType}'`)
    }

    // 三个转换业务共用同一个函数，一次产出出库 + 入库两张。
    const conversion = exportedFnBody('createInventoryConversion')
    expect(conversion).toContain(`docType: '库存转换出库'`)
    expect(conversion).toContain(`docType: '库存转换入库'`)
  })

  it('每个非撤回类业务的产出单据类型都在 business.ts 里真实存在', () => {
    // 存在性对账：防映射表凭空捏造一个「看起来对」的类型（比如把「院入库」写成
    // 「分院入库」——两个都是合法中文，TS 只认 INVENTORY_DOC_TYPES 里有没有，
    // 而它有一整排相近的名字）。哪条业务产出哪张单的**强对账**靠上面几条专项断言。
    // 撤回/关闭类不建单，这里排除。
    const noOutputDoc = new Set<string>(['supply-chain-purchase-cancel', 'shipment-cancel', 'shipment-cancel-approval'])
    for (const [operation, query] of Object.entries(INVENTORY_OPERATION_DOC_QUERY)) {
      if (noOutputDoc.has(operation)) continue
      for (const docType of query.produced.docTypes) {
        expect(businessSource, `${operation} → ${docType}`).toContain(`'${docType}'`)
      }
    }
  })
})

/**
 * 「待我处理」段（#192）。
 *
 * produced 抄错的代价是「看到别的业务的单」；inbox 抄错的代价更直接：
 * **待办区列出服务端必拒的单，用户点一次报一次错**。所以这里除了表自身的完整性，
 * 还逐条与 `business.ts` 事务内的 docType/status 断言对账 —— 服务端口径一漂移立刻红。
 */
describe('待我处理段（#192）', () => {
  /** 有 inbox 的内置业务。多一个少一个都红，防止有人顺手给建单类业务加 inbox。 */
  const OPERATIONS_WITH_INBOX = [
    'market-receipt',
    'market-return-approval',
    'shipment-cancel-approval',
    'store-receipt',
    'store-return-approval',
    'supply-chain-purchase-cancel',
    'supply-chain-receipt',
  ] as const

  /** 待办区只能出现「还轮得到人动手」的状态。终态单进来 = 把已办的单倒进待办区。 */
  const ACTIONABLE_STATUSES = ['待审批', '待收货']

  it('带 inbox 的业务集合被精确钉死', () => {
    /*
     * 不变量 3：inbox 只给「动作归属在本办理台、但单据由上游产出」的业务写。
     * 建单类业务（purchase-order / company-shipment / store-allocation /
     * market-report-summary / market-report）的来源单**不该**进来 ——
     * 它们在建单表单的 DocPicker 里已可选，待办区对它们没有任何行内动作可做。
     */
    const withInbox = Object.entries(INVENTORY_OPERATION_DOC_QUERY)
      .filter(([, query]) => query.inbox !== undefined)
      .map(([operation]) => operation)
      .sort()
    expect(withInbox).toEqual([...OPERATIONS_WITH_INBOX])
  })

  it('不变量 1：inbox 必须带 statuses，且只能是可操作态', () => {
    // 不限状态（statuses 缺失）在 engine 里是**放宽**：那个 if 分支不进，
    // 终态单会全部涌进待办区，每一张点下去都是 INVALID_STATE。
    for (const operation of OPERATIONS_WITH_INBOX) {
      const inbox = INVENTORY_OPERATION_DOC_QUERY[operation].inbox!
      expect(inbox.statuses, operation).toBeDefined()
      expect(inbox.statuses!.length, operation).toBeGreaterThan(0)
      for (const status of inbox.statuses!) {
        expect(ACTIONABLE_STATUSES, `${operation} → ${status}`).toContain(status)
      }
    }
  })

  it('不变量 2：inbox 与 produced 同 docType 时 statuses 必须互斥', () => {
    /*
     * 命中两条（都是「本身不产出新单、只改目标单状态」的业务，两段自然同 docType）：
     *   shipment-cancel-approval：品项公司发货，produced 已取消 vs inbox 待审批
     *   supply-chain-purchase-cancel：采购订单，  produced 已取消 vs inbox 待收货
     * 哪天有人放宽其中一段，同一张单会在「待我处理」和「本业务产出」两个区块同时出现。
     * produced 缺 statuses 视为「全状态」，一定与 inbox 相交 —— 也要红。
     */
    const overlapping: string[] = []
    for (const [operation, query] of Object.entries(INVENTORY_OPERATION_DOC_QUERY)) {
      if (!query.inbox) continue
      const sharedDocTypes = query.inbox.docTypes.filter((t) => query.produced.docTypes.includes(t))
      if (sharedDocTypes.length === 0) continue
      overlapping.push(operation)
      const producedStatuses = query.produced.statuses
      expect(producedStatuses, `${operation} 的 produced 与 inbox 同 docType，produced 必须限状态`).toBeDefined()
      const intersection = (query.inbox.statuses ?? []).filter((s) => producedStatuses!.includes(s))
      expect(intersection, `${operation} 的两段状态不得相交`).toEqual([])
    }
    // 命中集合本身也钉死：多出一条就该重新想清楚「同一张单出现在两个区块」是不是本意。
    expect(overlapping.sort()).toEqual(['shipment-cancel-approval', 'supply-chain-purchase-cancel'])
  })

  it('7 条 inbox 逐条钉死精确值', () => {
    // 上面几条是表驱动的自反断言（表改了断言跟着改），这里把**具体值**写死，
    // 防止映射与断言一起被改错还全绿。
    const expected: Record<(typeof OPERATIONS_WITH_INBOX)[number], unknown> = {
      // approveReturnForRestock：院退货 / 市场退货 + 待审批，target 分别是市场 / 总部，
      // 而它 `assertLocationWritable(session, target)` —— 所以两条都是 scopeRole=target
      'store-return-approval': { docTypes: ['院退货'], statuses: ['待审批'], scopeRole: 'target' },
      'market-return-approval': { docTypes: ['市场退货'], statuses: ['待审批'], scopeRole: 'target' },
      // approveItemCompanyShipmentCancellation：marker 为空时服务端必拒，
      // 所以 cancellationRequested 是硬条件不是装饰。
      // scopeRole='source' 是全表唯一 —— 审批要回滚的是总部**发货方**的库存。
      'shipment-cancel-approval': {
        docTypes: ['品项公司发货'],
        statuses: ['待审批'],
        scopeRole: 'source',
        cancellationRequested: true,
      },
      // 同一个 docType、方向与上一条相反：收货断 target，撤回审批断 source
      'market-receipt': { docTypes: ['品项公司发货'], statuses: ['待收货'], scopeRole: 'target' },
      'store-receipt': { docTypes: ['分院配货'], statuses: ['待收货'], scopeRole: 'target' },
      // pendingItemScope 只留还有未入库明细的采购订单（#335 起不按 market_id 分流）
      'supply-chain-receipt': {
        docTypes: ['采购订单'],
        statuses: ['待收货'],
        scopeRole: 'target',
        pendingItemScope: 'supply-chain',
      },
      // 关闭作用于整单，刻意**不**加 pendingItemScope —— 排掉反而让操作员找不到那张单；
      // scopeRole 照加（cancelSupplyChainPurchaseOrder 断的是 order.targetOrgNodeId）
      'supply-chain-purchase-cancel': { docTypes: ['采购订单'], statuses: ['待收货'], scopeRole: 'target' },
    }
    for (const operation of OPERATIONS_WITH_INBOX) {
      expect(INVENTORY_OPERATION_DOC_QUERY[operation].inbox, operation).toEqual(expected[operation])
    }
  })

  it('不变量 4：每条 inbox 都带 scopeRole，produced 一条都不带', () => {
    /*
     * 缺 scopeRole 在 engine 里是**放宽**：那个 if 分支不进，可见性退回双端 OR，
     * 于是**对端**（发货方 / 申请方）会在「待我处理」里拿到一张带行内按钮的单 ——
     * 点一次 PERMISSION_DENIED、刷新后还在，待办角标也跟着虚高。
     * 反过来，produced 段加上 scopeRole 会把发货方自己开的单从产出区吞掉，
     * 同样是静默丢数据。所以两段各钉一个方向。
     */
    for (const operation of OPERATIONS_WITH_INBOX) {
      const query = INVENTORY_OPERATION_DOC_QUERY[operation]
      expect(query.inbox!.scopeRole, `${operation}.inbox 缺方向维`).toBeDefined()
      expect(['source', 'target'], `${operation}.inbox`).toContain(query.inbox!.scopeRole)
    }
    const producedWithScopeRole = Object.entries(INVENTORY_OPERATION_DOC_QUERY)
      .filter(([, query]) => query.produced.scopeRole !== undefined)
      .map(([operation]) => operation)
    expect(producedWithScopeRole, 'produced 段不该带方向维').toEqual([])
  })

  it('scopeRole 逐条与服务端那句 assert 对账 —— 抄反方向立刻红', () => {
    /*
     * 这是 scopeRole 唯一的判断依据：**对应动作在服务端拿哪一端做 scope 断言**，
     * 不是卡片标题、不是「收货当然是 target」这种直觉。抄反的两种后果都很难从页面上看出来：
     *   写成对端 → 待办区列出服务端必拒的单，点一次报一次 403；
     *   写成对端（且本端不在 scope）→ 本该处理的人一张单都看不到，卡片直接失效。
     *
     * 同一个 docType「品项公司发货」上两条 inbox 方向相反（收货 target / 撤回审批 source），
     * 正好把「按 docType 猜方向」这条捷径堵死。
     */
    const expectedRole: Record<(typeof OPERATIONS_WITH_INBOX)[number], 'source' | 'target'> = {
      'store-return-approval': 'target',
      'market-return-approval': 'target',
      'shipment-cancel-approval': 'source',
      'market-receipt': 'target',
      'store-receipt': 'target',
      'supply-chain-receipt': 'target',
      'supply-chain-purchase-cancel': 'target',
    }
    for (const operation of OPERATIONS_WITH_INBOX) {
      expect(INVENTORY_OPERATION_DOC_QUERY[operation].inbox!.scopeRole, operation)
        .toBe(expectedRole[operation])
    }

    // —— 上面那张表本身的依据，逐条钉回服务端源码 ——
    // 退货审批 / 驳回：都断 target（回库主体）
    expect(exportedFnBody('approveReturnForRestock')).toContain('assertLocationWritable(session, target)')
    expect(exportedFnBody('rejectReturnForRestock')).toContain('assertLocationWritable(session, target)')
    // 撤回审批 / 驳回：都断 source（总部发货方），这是唯一一对 source
    expect(exportedFnBody('approveItemCompanyShipmentCancellation')).toContain('assertLocationWritable(session, source)')
    expect(exportedFnBody('rejectItemCompanyShipmentCancellation')).toContain('assertLocationWritable(session, source)')
    // 实物收货（receivePhysicalShipment 是非 export 私有函数，在全文里钉）：断 target
    expect(businessSource).toContain(`const target = await locationForUpdate(tx, targetOrgNodeId)
    assertLocationWritable(session, target)`)
    // 供应链采购入库 / 关闭采购：断的都是 order.targetOrgNodeId 解出来的 supplyChain
    for (const fnName of ['receiveSupplyChainPurchaseOrder', 'cancelSupplyChainPurchaseOrder']) {
      expect(exportedFnBody(fnName), fnName).toContain('assertLocationWritable(session, supplyChain)')
    }
    expect(exportedFnBody('cancelSupplyChainPurchaseOrder'))
      .toContain(`required(order.targetOrgNodeId, '供应链库存主体')`)
    // 采购订单的 source 恒为 NULL（归属全下沉到明细行），所以上面两条 target 收窄今天是空转；
    // 这句钉住「空转」的前提 —— 哪天单头重新挂上 source，这条会红并提醒去复核那两条 inbox。
    expect(exportedFnBody('createPurchaseOrder')).toContain('sourceOrgNodeId: null')
  })

  it('与 business.ts 的事务内状态断言对账 —— 服务端口径一漂移立刻红', () => {
    // 退货审批（两条 inbox 共用同一个函数，靠 docType 分叉）
    const approveReturn = exportedFnBody('approveReturnForRestock')
    expect(approveReturn).toContain(`['院退货', '市场退货'].includes(returnDoc.docType)`)
    expect(approveReturn).toContain(`returnDoc.status !== '待审批'`)
    // 撤回审批：docType/status 断言 + 「撤回原因必须非空」
    const approveCancel = exportedFnBody('approveItemCompanyShipmentCancellation')
    expect(approveCancel).toContain(`shipment.docType !== '品项公司发货' || shipment.status !== '待审批'`)
    expect(approveCancel).toContain(`required(shipment.cancellationRequestReason`)
    // 供应链采购入库：整单状态；#335 起不再按行拒市场行（所有行都能入库），
    // 所以 inbox 不能再按 market_id 收窄 —— 服务端一旦恢复这道拦截，这里立刻红
    const receivePurchase = exportedFnBody('receiveSupplyChainPurchaseOrder')
    expect(receivePurchase).toContain(`order.docType !== '采购订单' || order.status !== '待收货'`)
    expect(receivePurchase).not.toContain('orderItem.marketId')
    // 关闭采购：同样的 docType/status 判定（所以两条 inbox 的 statuses 一致）
    expect(exportedFnBody('cancelSupplyChainPurchaseOrder'))
      .toContain(`order.docType !== '采购订单' || order.status !== '待收货'`)
    /*
     * 实物收货：`receivePhysicalShipment` 是**非 export** 的私有函数，exportedFnBody
     * 取不到，直接在全文里钉那句断言 + 两个调用点的第 3 个实参（= inbox 的 docType）。
     */
    expect(businessSource).toContain(`shipment.docType !== expectedDocType || shipment.status !== '待收货'`)
    expect(businessSource).toContain(`receivePhysicalShipment(session, input, '品项公司发货', '市场采购入库')`)
    expect(businessSource).toContain(`receivePhysicalShipment(session, input, '分院配货', '院入库')`)
  })

  it('pendingItemScope 在 engine 里落成「未入库明细」的 EXISTS，且不按 market_id 分流（#335）', () => {
    /*
     * 这条是跨文件对账：#335 起采购订单所有行都经供应链采购入库，engine 若仍按
     * `market_id IS NULL` 收窄，映射表的断言照样全绿，而市场行待入库的单会从
     * 供应链收货待办里消失。
     *
     * 分工：编译后 SQL 的断言在 `engine.test.ts` 的
     * `describe('#190 单据列表的多类型 / 多状态 / 撤回标记过滤')` 里；
     * 这里守的是**映射表这一侧**看到的 engine 源码：未入库条件在、market_id 分流不在。
     */
    const branch = engineSource.slice(
      engineSource.indexOf('if (filters.pendingItemScope) {'),
      engineSource.indexOf('if (filters.startDate)'),
    )
    expect(branch, 'engine.ts 里找不到 pendingItemScope 分支').not.toEqual('')
    expect(branch).not.toContain('pending_item.market_id')
    expect(branch).toContain('pending_item.doc_id = ${inventoryDocs.id}')
    expect(branch).toContain('COALESCE(pending_item.fulfilled_quantity, 0) < pending_item.quantity')
  })

  it('scopeRole 在 engine 里落成单端收窄，且对 admin 跳过', () => {
    /*
     * 跨文件对账的另一半：映射表把方向写对了，engine 这边把两个分支接反（source 走
     * target 列）同样不会报错 —— 待办区会精确地只剩点了必 403 的那批单。
     * 编译后 SQL 的断言在 engine.test.ts 的 `describe('#192 待办区按 scopeRole 收窄到单个端点')`。
     *
     * `scoped !== null` 是 admin 豁免：admin 的「可见节点集合」是 null（不受限），
     * 拿它去收窄会把待办区整个清空。漏掉这半个条件会在 admin 账号上直接炸，
     * 但那正是最不容易被日常自测覆盖到的账号（开发常用 admin 反而看不出差别 ——
     * 差别恰恰是「什么都没了」）。
     */
    const branch = engineSource.slice(
      engineSource.indexOf('if (filters.scopeRole && scoped !== null) {'),
      engineSource.indexOf('if (filters.orgNodeId) {'),
    )
    expect(branch, 'engine.ts 里找不到 scopeRole 分支（含 admin 豁免）').not.toEqual('')
    expect(branch).toContain(`filters.scopeRole === 'source'`)
    expect(branch).toContain('inventoryDocs.sourceOrgNodeId')
    expect(branch).toContain('inventoryDocs.targetOrgNodeId')
    // 空 scope fail-closed，与上方 scope 分支同构
    expect(branch).toContain('sql`FALSE`')
  })

  it('动作表自洽：键集合 === 有 inbox 的业务集合', () => {
    expect(Object.keys(INVENTORY_OPERATION_INBOX_ACTIONS).sort()).toEqual([...OPERATIONS_WITH_INBOX])
    expect(Object.keys(INVENTORY_GENERIC_OPERATION_INBOX_ACTIONS).sort())
      .toEqual(Object.keys(INVENTORY_GENERIC_OPERATION_INBOX).sort())
  })

  it('每个动作的状态都真的会出现在对应业务的 inbox 里 —— 配不出永不出现的按钮', () => {
    for (const [operation, kinds] of Object.entries(INVENTORY_OPERATION_INBOX_ACTIONS)) {
      const inbox = INVENTORY_OPERATION_DOC_QUERY[operation as InventoryOperationId].inbox!
      for (const kind of kinds) {
        expect(INVENTORY_INBOX_ACTION_KINDS, kind).toContain(kind)
        expect(inbox.statuses, `${operation} → ${kind}`).toContain(INVENTORY_INBOX_ACTION_STATUS[kind])
      }
    }
    for (const [docType, kinds] of Object.entries(INVENTORY_GENERIC_OPERATION_INBOX_ACTIONS)) {
      const inbox = (INVENTORY_GENERIC_OPERATION_INBOX as Record<string, { statuses?: readonly string[] }>)[docType]
      for (const kind of kinds) {
        expect(INVENTORY_INBOX_ACTION_KINDS, kind).toContain(kind)
        expect(inbox.statuses, `${docType} → ${kind}`).toContain(INVENTORY_INBOX_ACTION_STATUS[kind])
      }
    }
  })

  it('每个动作种类都被至少一个业务用上，没有孤儿 kind', () => {
    const used = new Set<InventoryInboxActionKind>([
      ...Object.values(INVENTORY_OPERATION_INBOX_ACTIONS).flat(),
      ...Object.values(INVENTORY_GENERIC_OPERATION_INBOX_ACTIONS).flat(),
    ])
    expect([...used].sort()).toEqual([...INVENTORY_INBOX_ACTION_KINDS].sort())
  })

  it('「草稿 → 取消」不可达守护 —— 哪天真有业务产出草稿单，这条会红', () => {
    /*
     * 不实现草稿取消的两个原因，缺一不可：
     * (a) 没有任何业务产出草稿单 —— insertDocHeader 每次显式传 status，
     *     engine 的 defaultStatusForDoc 只返回 待审批/待收货/已完成，
     *     `草稿` 只是 db/schema/inventory.ts 的列默认值；
     * (b) 全仓没有任何「取消草稿」的 Server Action。
     */
    expect(Object.values(INVENTORY_INBOX_ACTION_STATUS)).not.toContain('草稿')
    expect(businessSource).not.toMatch(/status:\s*'草稿'/)
    const defaultStatus = engineSource.slice(
      engineSource.indexOf('function defaultStatusForDoc('),
      engineSource.indexOf('function defaultStatusForDoc(') + 400,
    )
    const returned = [...defaultStatus.matchAll(/return '([^']+)'/g)].map((m) => m[1])
    // 两边用同一个 .sort()：中文按 code point 排，写死顺序会跟直觉不一致（'已完成' 在最前）
    expect(returned.sort()).toEqual(['待审批', '待收货', '已完成'].sort())
  })

  it('resolveOperationInboxActions 对内置 / 通用 / 垃圾 id 分别给出正确答案', () => {
    expect(resolveOperationInboxActions('store-return-approval')).toEqual(['return-approve', 'return-reject'])
    expect(resolveOperationInboxActions('supply-chain-receipt')).toEqual(['purchase-receive-goto'])
    // 无 inbox 的业务拿到空数组而不是 undefined（UI 直接 .map，undefined 会崩）
    expect(resolveOperationInboxActions('purchase-order')).toEqual([])
    expect(resolveOperationInboxActions(genericOperationId('分院调货出库'))).toEqual(['generic-receive'])
    expect(resolveOperationInboxActions(genericOperationId('内部领用'))).toEqual([])
    // 原型链键 / 未知 id fail-closed 成「没有按钮」
    for (const bad of ['constructor', '__proto__', 'toString', 'generic:constructor', '', 'not-a-business']) {
      expect(resolveOperationInboxActions(bad), bad).toEqual([])
    }
  })
})

/**
 * 通用建单业务的 id 与查询解析（#191）。
 *
 * 通用业务的「映射」是从 docType 派生的，没有手抄的表可抄错 —— 风险转移到了
 * **白名单**上：`generic:` 前缀后面跟什么都能拼出来，拼一个业务单类型进去
 * 就等于从通用入口绕过专用服务的数量/价格/批次校验。
 */
describe('通用建单业务 id（#191）', () => {
  it('10 种通用类型都能往返解析', () => {
    for (const docType of INVENTORY_GENERIC_DOC_TYPES) {
      expect(parseGenericOperationId(genericOperationId(docType))).toBe(docType)
    }
  })

  it('非通用类型拼出来的 id 一律拒绝', () => {
    // 这些都是真实存在的 docType，但必须走各自的专用业务服务建单。
    for (const docType of ['品项公司发货', '市场报货', '采购订单', '院入库', '库存转换出库'] as const) {
      expect(parseGenericOperationId(`generic:${docType}`), docType).toBeNull()
      expect(resolveOperationDocQuery(`generic:${docType}`), docType).toBeNull()
    }
  })

  it('乱拼的 id 与原型链键都解析不出查询条件', () => {
    for (const bad of ['generic:', 'generic:不存在的单据', 'generic', '', 'constructor', '__proto__', 'generic:constructor']) {
      expect(resolveOperationDocQuery(bad), bad).toBeNull()
    }
  })

  it('通用业务的 produced 就是「查这一种单据」，不带任何收窄', () => {
    // 带上 statuses/locationType 反而会漏单：通用单据没有层级共用问题，
    // 也没有「只看某个状态」的业务含义。
    expect(resolveOperationDocQuery(genericOperationId('市场产品报损')))
      .toEqual({ produced: { docTypes: ['市场产品报损'] } })
    expect(resolveOperationDocQuery(genericOperationId('内部领用')))
      .toEqual({ produced: { docTypes: ['内部领用'] } })
  })

  it('内置业务仍走映射表，与通用分支互不串台', () => {
    expect(resolveOperationDocQuery('market-conversion')).toEqual({
      produced: { docTypes: ['库存转换出库', '库存转换入库'], locationType: '市场' },
    })
    // 内置 id 加上 generic: 前缀不应该被当成通用业务
    expect(resolveOperationDocQuery('generic:market-conversion')).toBeNull()
  })

  it('门店调拨（分院调货出库）带 inbox —— 门店层最大的一批待办不在 store-receipt 上', () => {
    /*
     * dev 库统计：门店层可操作态单据里「分院调货出库 · 待收货」6 条是最大的一批。
     * 它**不能**塞进 store-receipt 的 inbox：那条产出「院入库」，而调货收货产出
     * 「分院调货入库」，produced/inbox 会语义错配。收货走通用的
     * confirmInventoryCoreReceive（分院调货出库 在 INVENTORY_GENERIC_DOC_TYPES 里）。
     */
    expect(resolveOperationDocQuery(genericOperationId('分院调货出库'))).toEqual({
      produced: { docTypes: ['分院调货出库'] },
      inbox: { docTypes: ['分院调货出库'], statuses: ['待收货'], scopeRole: 'target' },
    })
    // store-receipt 的 inbox 是分院配货，不是调货出库（错配会让两个区块都不对）
    expect(INVENTORY_OPERATION_DOC_QUERY['store-receipt'].inbox?.docTypes).toEqual(['分院配货'])
  })

  it('通用业务的 produced 与 inbox 刻意重叠 —— 这张卡既建单又收货', () => {
    /*
     * 与内置表的不变量 2（同 docType 必须状态互斥）**刻意不同**：门店调拨这张卡
     * 自己建单、自己收货，一张待收货的调货出库单既是「本业务产出」也是「本业务待办」，
     * 两段都该看得到。所以 produced 不做状态排除 —— 排掉「待收货」等于让操作员
     * 看不见自己刚建的那张单。这条用例存在的意义是：哪天有人「为了消除重复」
     * 去给 produced 加 statuses，会红并读到这段说明。
     */
    const query = resolveOperationDocQuery(genericOperationId('分院调货出库'))!
    expect(query.produced.statuses, '通用 produced 不限状态').toBeUndefined()
    expect(query.inbox?.docTypes).toEqual(query.produced.docTypes)
  })

  it('门店调拨的 inbox 必须按 target 收窄 —— 否则发货门店会看到自己单上的「确认收货」', () => {
    /*
     * 两段刻意重叠（上一条）之后，方向维就是把两段区分开的**唯一**东西：
     * produced 双端可见（发货门店看得见自己开的单，对），
     * inbox 只给收货门店（`confirmInventoryCoreReceive` 只断 target，对）。
     *
     * 缺了它，调货的两端同为门店、`source OR target IN scoped` 两边都命中：
     * 发货门店的「待我处理」里会多出自己刚发出去的单，还带一个「确认收货」按钮 ——
     * 点下去 assertOrgNodeVisible(target) 必抛 PERMISSION_DENIED，刷新后那行照旧在。
     * 这是本卡片 6 条待办（dev 库）里最容易踩的一脚，也是这条用例存在的全部理由。
     */
    expect(INVENTORY_GENERIC_OPERATION_INBOX.分院调货出库.scopeRole).toBe('target')
    /*
     * 依据钉回 engine，而且**限定在 confirmInventoryCoreReceive 函数体内**：
     * 同文件的 `approveInventoryCoreDoc` 断的是 `head.source_org_node_id`（审批扣的是
     * 出库方的库存），全文级的 `not.toContain` 会被它命中。这不是断言写法的细节 ——
     * 它正是下一条用例说的「其余 9 种通用类型将来铺开时方向不一样」：
     * 收货类（市场间调货出库）走 confirm → target，审批类（两个报损）走 approve → source。
     */
    const confirmBody = engineSource.slice(
      engineSource.indexOf('export const confirmInventoryCoreReceive = withAnyPermission('),
      engineSource.indexOf('export const', engineSource.indexOf('export const confirmInventoryCoreReceive = withAnyPermission(') + 1),
    )
    expect(confirmBody, 'engine.ts 里找不到 confirmInventoryCoreReceive').not.toEqual('')
    expect(confirmBody).toContain('await assertOrgNodeVisible(session, head.target_org_node_id)')
    expect(confirmBody).not.toContain('assertOrgNodeVisible(session, head.source_org_node_id)')
  })

  it('登记 inbox 的通用类型都带 scopeRole —— 将来铺开其余 9 种时别漏', () => {
    /*
     * 键集合的断言在「动作表自洽」那条；这条守的是**每条 inbox 的方向维**。
     * 补新条目时（市场间调货出库 / 两个报损）会因为缺 scopeRole 在这里红。
     *
     * ⚠️ 补的时候别照抄 'target'：通用类型的待办分两类动作，方向相反 ——
     *   收货类（市场间调货出库 · 待收货）→ confirmInventoryCoreReceive → **target**
     *   审批类（市场产品报损 / 院产品报损 · 待审批）→ approveInventoryCoreDoc
     *     → `assertOrgNodeVisible(session, head.source_org_node_id)` → **source**
     * （审批扣的是出库方的库存，所以断出库端。上一条用例把这个依据钉在了 engine 源码上。）
     */
    for (const [docType, inbox] of Object.entries(INVENTORY_GENERIC_OPERATION_INBOX)) {
      expect(['source', 'target'], docType).toContain(
        (inbox as { scopeRole?: string }).scopeRole,
      )
    }
  })

  it('市场间调货（市场间调货出库）带 inbox，按 target 收窄、行内动作是通用收货（#340）', () => {
    /*
     * 用户 2026-09-24 拍板：调入市场在办理台待办里直接确认收货（#340 待确认项选 A）。
     * 与门店调拨同构 —— 收货走 confirmInventoryCoreReceive，只断 target（上面那条把依据
     * 钉在了 engine 源码上）。方向写成 source 的话，调出市场的待办里会出现自己发出去的单，
     * 而调入市场反倒看不到。
     */
    expect(resolveOperationDocQuery(genericOperationId('市场间调货出库'))).toEqual({
      produced: { docTypes: ['市场间调货出库'] },
      inbox: { docTypes: ['市场间调货出库'], statuses: ['待收货'], scopeRole: 'target' },
    })
    expect(resolveOperationInboxActions(genericOperationId('市场间调货出库'))).toEqual(['generic-receive'])
  })

  it('其余 8 种通用类型只有 produced，没有 inbox', () => {
    // 两个报损（待审批）同样有待办语义，但仍未登记（是否铺开待拍板）。
    // 补的时候连 INVENTORY_GENERIC_OPERATION_INBOX_ACTIONS 一起补，上面那条键集合断言会盯着；
    // 审批类方向是 source，别照抄调货的 target。
    const withInbox = new Set<string>(['分院调货出库', '市场间调货出库'])
    for (const docType of INVENTORY_GENERIC_DOC_TYPES) {
      if (withInbox.has(docType)) continue
      expect(resolveOperationDocQuery(genericOperationId(docType))?.inbox, docType).toBeUndefined()
    }
    expect(Object.keys(INVENTORY_GENERIC_OPERATION_INBOX).sort()).toEqual([...withInbox].sort())
  })
})
