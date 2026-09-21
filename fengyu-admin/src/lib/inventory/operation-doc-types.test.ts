import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  INVENTORY_OPERATION_DOC_QUERY,
  INVENTORY_OPERATION_IDS,
  type InventoryOperationId,
} from './operation-doc-types'
import { INVENTORY_DOC_STATUSES, INVENTORY_DOC_TYPES } from './types'

/**
 * 办理台「单据」Tab 的业务 → 产出单据类型映射（#190）。
 *
 * 这张表是从 `business.ts` 各业务 `insertDocHeader` 的 docType 逐条抄来的，抄错了
 * 编译器不会吭声（都是合法字面量），只会让用户在 Tab 里看到别的业务的单。
 * 所以这里的断言分两类：**表自身的完整性**，以及**与业务实现的对账**。
 */
describe('业务 → 产出单据类型映射（#190）', () => {
  const businessSource = readFileSync(resolve(__dirname, 'business.ts'), 'utf8')

  it('每个业务卡片都登记了映射，且没有多余条目', () => {
    expect(Object.keys(INVENTORY_OPERATION_DOC_QUERY).sort()).toEqual([...INVENTORY_OPERATION_IDS].sort())
  })

  it('docTypes 非空且都是合法单据类型', () => {
    // 空数组在 engine 里是 fail-closed（查不出任何单），放进映射表等于把某个业务的
    // Tab 永久变成空白页——只可能是写漏了，不可能是本意。
    for (const [operation, query] of Object.entries(INVENTORY_OPERATION_DOC_QUERY)) {
      expect(query.docTypes.length, operation).toBeGreaterThan(0)
      for (const docType of query.docTypes) {
        expect(INVENTORY_DOC_TYPES, `${operation} → ${docType}`).toContain(docType)
      }
    }
  })

  it('statuses 都是合法状态', () => {
    for (const [operation, query] of Object.entries(INVENTORY_OPERATION_DOC_QUERY)) {
      for (const status of query.statuses ?? []) {
        expect(INVENTORY_DOC_STATUSES, `${operation} → ${status}`).toContain(status)
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
      expect(query.docTypes).toEqual(['库存转换出库', '库存转换入库'])
      expect(query.locationType, operation).toBe(locationType)
    }
  })

  it('只有共用 docType 的转换业务需要 locationType，其余业务不画蛇添足', () => {
    // 多余的 locationType 会把本来该看到的单据筛掉（比如给「分院配货」加上
    // locationType=市场，source 是市场能过、但语义已经跑偏），属于静默丢数据。
    const withLocationType = Object.entries(INVENTORY_OPERATION_DOC_QUERY)
      .filter(([, query]) => query.locationType !== undefined)
      .map(([operation]) => operation)
      .sort()
    expect(withLocationType).toEqual(['market-conversion', 'store-conversion', 'supply-chain-conversion'])
  })

  it('不产出新单的三个业务靠 statuses / cancellationRequested 收窄，不会把全部同类单据倒出来', () => {
    // 关闭采购、撤回申请、撤回审批都只改目标单状态。不收窄的话，
    // 「关闭供应链采购」的 Tab 会列出全部采购订单，与「供应链采购订单」业务完全重合。
    expect(INVENTORY_OPERATION_DOC_QUERY['supply-chain-purchase-cancel']).toEqual({
      docTypes: ['采购订单'],
      statuses: ['已取消'],
    })
    /*
     * 审批侧只认「已取消」= 甲方拍板表原文。别顺手把驳回态补进来：
     * 驳回只是把 status 改回「待收货」，而它会继续演进到「已完成」，
     * 用会变的当前状态表达"审批处理过"必然不自洽（同一张单过阵子自己就消失了）。
     */
    expect(INVENTORY_OPERATION_DOC_QUERY['shipment-cancel-approval']).toEqual({
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
      docTypes: ['品项公司发货'],
      cancellationRequested: true,
    })
  })

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
      expect(INVENTORY_OPERATION_DOC_QUERY[operation].docTypes, operation).toEqual([docType])
      expect(exportedFnBody(fnName), `${fnName} 应写入 ${docType}`).toContain(`docType: '${docType}'`)
    }
  })

  it('两个退货业务按发起方分叉，门店发起 → 院退货、市场发起 → 市场退货', () => {
    // 这两条共用 createReturnForRestock，靠 source.locationType 分叉，
    // 分叉写反了两个业务的 Tab 会互相串。
    const body = exportedFnBody('createReturnForRestock')
    expect(body).toMatch(/source\.locationType === '门店'[\s\S]*?docType = '院退货'/)
    expect(body).toMatch(/source\.locationType === '市场'[\s\S]*?docType = '市场退货'/)
    expect(INVENTORY_OPERATION_DOC_QUERY['store-return'].docTypes).toEqual(['院退货'])
    expect(INVENTORY_OPERATION_DOC_QUERY['market-return'].docTypes).toEqual(['市场退货'])
  })

  it('收货类业务映射到入库单，与 business.ts 的 receivePhysicalShipment 实参一致', () => {
    // 对账点：`receiveStoreAllocation` / `receiveItemCompanyShipment` 传给
    // receivePhysicalShipment 的**第 4 个实参**就是产出的入库单类型。
    // ⚠️ 两个调用点都要钉：只钉一个的话，另一个改成别的入库类型时，
    // 那个字面量仍散落在 business.ts 别处（前缀表、注释），存在性对账照样绿。
    expect(businessSource).toContain(`receivePhysicalShipment(session, input, '分院配货', '院入库')`)
    expect(businessSource).toContain(`receivePhysicalShipment(session, input, '品项公司发货', '市场采购入库')`)
    expect(INVENTORY_OPERATION_DOC_QUERY['store-receipt'].docTypes).toEqual(['院入库'])
    expect(INVENTORY_OPERATION_DOC_QUERY['market-receipt'].docTypes).toEqual(['市场采购入库'])
  })

  it('退货审批映射到回库单：门店退货回市场库、市场退货回供应链库', () => {
    // business.ts approveReturnForRestock：院退货 → 市场退货入库，否则 → 供应链退货入库。
    expect(businessSource).toContain(`returnDoc.docType === '院退货' ? '市场退货入库' : '供应链退货入库'`)
    expect(INVENTORY_OPERATION_DOC_QUERY['store-return-approval'].docTypes).toEqual(['市场退货入库'])
    expect(INVENTORY_OPERATION_DOC_QUERY['market-return-approval'].docTypes).toEqual(['供应链退货入库'])
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
      expect(INVENTORY_OPERATION_DOC_QUERY[operation].docTypes, operation).toEqual([docType])
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
      for (const docType of query.docTypes) {
        expect(businessSource, `${operation} → ${docType}`).toContain(`'${docType}'`)
      }
    }
  })
})
