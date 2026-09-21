import { describe, expect, it } from 'vitest'

import {
  INVENTORY_BUSINESS_LEVELS,
  LEVEL_DELEGATION_ORDER,
  genericDocBusinessLevel,
  inventoryCreatableGenericDocTypes,
  inventoryDelegatableLevels,
  inventoryDelegatableOperateActions,
  inventoryLevelOperateDeniedMessage,
} from './business-level'
import { INVENTORY_GENERIC_DOC_TYPES } from './types'

const SUPPLY = 'inventory:supply_chain_operate'
const MARKET = 'inventory:market_operate'
const STORE = 'inventory:store_operate'

/** 只持有若干 action 的会话谓词，喂给 inventoryCreatableGenericDocTypes。 */
function holding(...actions: string[]) {
  return (action: string) => actions.includes(action)
}

/**
 * 代建层级表（甲方 2026-09-21 拍板：显式放开向下代建）。
 *
 * 这三个函数是 UI 建单下拉与服务端 createInventoryCoreDoc 层级闸的**同一个**单源，
 * 漂了就是「页面上能选、接口 403」或者反过来「接口放行、页面看不见」。
 *
 * 代建只沿「scope 会向下展开」的方向放开（LEVEL_SCOPE_EXPANDS_DOWNWARD）：
 * access.ts 的 inventoryScopedOrgNodeIds 对总部绑定不展开后代，所以总部代建是死路，
 * 候选集里不给它留位置。
 */
describe('inventoryDelegatableOperateActions', () => {
  it('供应链单只接受供应链 operate', () => {
    expect(inventoryDelegatableOperateActions('supply-chain')).toEqual([SUPPLY])
  })

  it('市场单只接受市场 operate —— 总部 scope 不展开，不给它代建位', () => {
    // 曾经是 [SUPPLY, MARKET]：总部账号选得出市场单，却在 assertOrgNodeVisible 必然被拒。
    expect(inventoryDelegatableOperateActions('market')).toEqual([MARKET])
  })

  it('门店单接受市场与门店 operate，顺序从上级到下级', () => {
    expect(inventoryDelegatableOperateActions('store')).toEqual([MARKET, STORE])
  })

  it('门店单的候选集包含市场（「市场人员替门店建单」是甲方点名的工作流）', () => {
    expect(inventoryDelegatableOperateActions('store')).toContain(MARKET)
  })

  it('总部 operate 不出现在任何下级层级的候选集里', () => {
    // 与 access.ts 的 inventoryScopedOrgNodeIds「总部不展开后代」同一条规则的另一处表述：
    // 放它进来 = 在服务端放行一批注定被 scope 拒的请求，在 UI 挂一串死路选项。
    expect(inventoryDelegatableOperateActions('market')).not.toContain(SUPPLY)
    expect(inventoryDelegatableOperateActions('store')).not.toContain(SUPPLY)
  })

  it('向上不放开：市场/供应链单的候选集里没有下级 operate', () => {
    expect(inventoryDelegatableOperateActions('market')).not.toContain(STORE)
    expect(inventoryDelegatableOperateActions('supply-chain')).not.toContain(MARKET)
    expect(inventoryDelegatableOperateActions('supply-chain')).not.toContain(STORE)
  })

  it('候选层级集：门店 → [市场, 门店]；市场 → [市场]；供应链 → [供应链]', () => {
    // operate 名字是这张层级表的下游；直接把层级集本身钉住，改名不掩盖口径变化。
    expect(inventoryDelegatableLevels('store')).toEqual(['market', 'store'])
    expect(inventoryDelegatableLevels('market')).toEqual(['market'])
    expect(inventoryDelegatableLevels('supply-chain')).toEqual(['supply-chain'])
  })

  it('LEVEL_DELEGATION_ORDER 与 INVENTORY_BUSINESS_LEVELS 是同一组成员', () => {
    // 漏一个层级 → 该层级的单据候选集算错（slice 的下标全体前移），这里立刻红
    expect([...LEVEL_DELEGATION_ORDER].sort()).toEqual([...INVENTORY_BUSINESS_LEVELS].sort())
  })
})

/**
 * 层级闸的拒绝文案（P2-b）。
 *
 * 旧文案一律是「缺少X或其上级层级的库存操作权限」—— 对供应链单不成立（它没有上级），
 * 对市场单也不成立（上级不展开 scope，指望不上）。文案现在由候选层级集生成。
 */
describe('inventoryLevelOperateDeniedMessage', () => {
  it('供应链单不提「上级层级」：它就是最顶层', () => {
    expect(inventoryLevelOperateDeniedMessage('supply-chain')).toBe('缺少供应链库存操作权限')
  })

  it('市场单只提市场：总部代建已不在候选集里', () => {
    expect(inventoryLevelOperateDeniedMessage('market')).toBe('缺少市场库存操作权限')
  })

  it('门店单点名门店与市场两个可行层级', () => {
    expect(inventoryLevelOperateDeniedMessage('store')).toBe('缺少门店或市场库存操作权限')
  })

  it('文案与候选集不漂：提到的层级 ⇔ 候选集里的 operate', () => {
    // 手写文案漂到候选集之外（比如又写回「或其上级层级」）时这条红。
    const LABEL: Record<string, string> = { 'supply-chain': '供应链', market: '市场', store: '门店' }
    for (const level of INVENTORY_BUSINESS_LEVELS) {
      const message = inventoryLevelOperateDeniedMessage(level)
      const delegatable = inventoryDelegatableOperateActions(level)
      for (const candidate of INVENTORY_BUSINESS_LEVELS) {
        expect(
          message.includes(LABEL[candidate]),
          `${level} 单的文案与候选集对 ${candidate} 的口径不一致：${message}`,
        ).toBe(delegatable.includes(`inventory:${candidate.replace('-', '_')}_operate`))
      }
    }
  })
})

describe('GENERIC_DOC_BUSINESS_LEVEL 覆盖度', () => {
  it('全部 10 种通用单据都有归属业务层级', () => {
    // engine.ts 层级闸里 `if (!docLevel) throw` 那条分支是死代码，靠这条钉住它一直死着；
    // 将来往 INVENTORY_GENERIC_DOC_TYPES 加类型忘了配层级，这里先红。
    expect(INVENTORY_GENERIC_DOC_TYPES).toHaveLength(10)
    for (const docType of INVENTORY_GENERIC_DOC_TYPES) {
      const level = genericDocBusinessLevel(docType)
      expect(level, docType).not.toBeNull()
      expect(INVENTORY_BUSINESS_LEVELS, docType).toContain(level)
    }
  })
})

describe('inventoryCreatableGenericDocTypes', () => {
  const SUPPLY_CHAIN_DOC_TYPES = INVENTORY_GENERIC_DOC_TYPES.filter(
    (docType) => genericDocBusinessLevel(docType) === 'supply-chain',
  )
  const MARKET_DOC_TYPES = INVENTORY_GENERIC_DOC_TYPES.filter(
    (docType) => genericDocBusinessLevel(docType) === 'market',
  )
  const STORE_DOC_TYPES = INVENTORY_GENERIC_DOC_TYPES.filter(
    (docType) => genericDocBusinessLevel(docType) === 'store',
  )

  it('仅门店 operate → 只有门店 5 种', () => {
    expect(STORE_DOC_TYPES).toHaveLength(5)
    expect(inventoryCreatableGenericDocTypes(holding(STORE))).toEqual(STORE_DOC_TYPES)
    expect(inventoryCreatableGenericDocTypes(holding(STORE))).not.toContain('内部领用')
    expect(inventoryCreatableGenericDocTypes(holding(STORE))).not.toContain('市场产品报损')
  })

  it('仅市场 operate → 市场 4 种 + 门店 5 种，不含内部领用（市场替门店建单）', () => {
    // ⚠️ 市场层级是 4 种不是 5 种（分院调货出库归门店）；数量写死在这里，改层级表立刻红
    expect(MARKET_DOC_TYPES).toHaveLength(4)
    const creatable = inventoryCreatableGenericDocTypes(holding(MARKET))
    expect(creatable).toHaveLength(9)
    expect(creatable).not.toContain('内部领用')
    // 保持 INVENTORY_GENERIC_DOC_TYPES 的原序，而不是「市场段 + 门店段」的分组序
    expect(creatable).toEqual(INVENTORY_GENERIC_DOC_TYPES.filter((docType) => docType !== '内部领用'))
    for (const docType of [...MARKET_DOC_TYPES, ...STORE_DOC_TYPES]) {
      expect(creatable, docType).toContain(docType)
    }
  })

  it('仅供应链 operate → 只有供应链那 1 种，不堆 9 条死路', () => {
    /*
     * 曾经返回全部 10 种：总部账号在下拉里能选「市场产品报损」「院产品报损」等 9 种，
     * 但 access.ts 的 inventoryScopedOrgNodeIds 对总部绑定不展开后代 —— 主体下拉里
     * 根本没有市场/门店节点，选了也只能在 assertOrgNodeVisible 撞 403。
     * 这条钉住「UI 只给能走通的选项」。
     */
    expect(SUPPLY_CHAIN_DOC_TYPES).toEqual(['内部领用'])
    expect(inventoryCreatableGenericDocTypes(holding(SUPPLY))).toEqual(['内部领用'])
  })

  it('供应链 + 市场双持 → 10 种全开（各自层级叠加，不是代建）', () => {
    // 双持会话是真能建全部 10 种的：内部领用来自 supply_chain_operate，
    // 其余 9 种来自 market_operate（市场自身 4 + 替门店 5）。
    expect(inventoryCreatableGenericDocTypes(holding(SUPPLY, MARKET)))
      .toEqual([...INVENTORY_GENERIC_DOC_TYPES])
  })

  it('空权限 → 空数组（fail-closed）', () => {
    expect(inventoryCreatableGenericDocTypes(() => false)).toEqual([])
    expect(inventoryCreatableGenericDocTypes(holding('inventory:list'))).toEqual([])
  })

  it('返回顺序与 INVENTORY_GENERIC_DOC_TYPES 原序一致', () => {
    // 下拉选项顺序是产品口径的一部分，别被 filter 之外的重排偷偷改掉
    const all = inventoryCreatableGenericDocTypes(holding(SUPPLY, MARKET, STORE))
    expect(all).toEqual([...INVENTORY_GENERIC_DOC_TYPES])
  })
})
