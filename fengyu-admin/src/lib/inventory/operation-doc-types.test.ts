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
      docTypes: ['供应链采购订单'],
      statuses: ['已取消'],
    })
    expect(INVENTORY_OPERATION_DOC_QUERY['shipment-cancel-approval']).toEqual({
      docTypes: ['品项公司发货'],
      statuses: ['已取消'],
      cancellationRequested: true,
    })
    // 申请方刻意不限状态：驳回只把 status 改回「待收货」而不清 reason，
    // 申请人该看到自己申请的全部结果（待审批 / 已取消 / 被驳回）。
    expect(INVENTORY_OPERATION_DOC_QUERY['shipment-cancel']).toEqual({
      docTypes: ['品项公司发货'],
      cancellationRequested: true,
    })
  })

  it('收货类业务映射到入库单，与 business.ts 的 receivePhysicalShipment 实参一致', () => {
    // 对账点：`receiveStoreAllocation` / `receiveItemCompanyShipment` 的第二个实参
    // 就是产出的入库单类型，改了那边这里必须跟着改。
    expect(businessSource).toContain(`receivePhysicalShipment(session, input, '分院配货', '院入库')`)
    expect(INVENTORY_OPERATION_DOC_QUERY['store-receipt'].docTypes).toEqual(['院入库'])
    expect(INVENTORY_OPERATION_DOC_QUERY['market-receipt'].docTypes).toEqual(['市场采购入库'])
  })

  it('退货审批映射到回库单：门店退货回市场库、市场退货回供应链库', () => {
    // business.ts approveReturnForRestock：院退货 → 市场退货入库，否则 → 供应链退货入库。
    expect(businessSource).toContain(`returnDoc.docType === '院退货' ? '市场退货入库' : '供应链退货入库'`)
    expect(INVENTORY_OPERATION_DOC_QUERY['store-return-approval'].docTypes).toEqual(['市场退货入库'])
    expect(INVENTORY_OPERATION_DOC_QUERY['market-return-approval'].docTypes).toEqual(['供应链退货入库'])
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
