import { describe, expect, it } from 'vitest'
import {
  expandGroupServiceSessions,
  groupTreatmentCards,
  selectGroupSourceIds,
  sumGroupValue,
} from '../../pagesOrder/utils/treatment-card-group'
import {
  expandGroupServiceSessions as expandAppointmentGroupServiceSessions,
  groupTreatmentCards as groupAppointmentTreatmentCards,
  selectGroupSourceIds as selectAppointmentGroupSourceIds,
  sumGroupValue as sumAppointmentGroupValue,
} from '../../pagesAppointment/utils/treatment-card-group'

interface Card {
  saleItemId: string
  status: string
  paidSessions: number | null
  quantity: number
  amount: string | null
  availableSessions: number
}

interface TreatmentCardGroupApi {
  expandGroupServiceSessions: typeof expandGroupServiceSessions
  groupTreatmentCards: typeof groupTreatmentCards
  selectGroupSourceIds: typeof selectGroupSourceIds
  sumGroupValue: typeof sumGroupValue
}

const implementations: Array<{ name: string; api: TreatmentCardGroupApi }> = [
  {
    name: '订单分包',
    api: {
      expandGroupServiceSessions,
      groupTreatmentCards,
      selectGroupSourceIds,
      sumGroupValue,
    },
  },
  {
    name: '预约分包',
    api: {
      expandGroupServiceSessions: expandAppointmentGroupServiceSessions,
      groupTreatmentCards: groupAppointmentTreatmentCards,
      selectGroupSourceIds: selectAppointmentGroupSourceIds,
      sumGroupValue: sumAppointmentGroupValue,
    },
  },
]

function group(api: TreatmentCardGroupApi, cards: Card[], preserveNonUnitQuantity = true) {
  return api.groupTreatmentCards(cards, {
    getId: (card) => card.saleItemId,
    getQuantity: (card) => card.quantity,
    preserveNonUnitQuantity,
    getIdentity: (card) => ({
      status: card.status,
      paidSessions: card.paidSessions,
      quantity: card.quantity,
    }),
  })
}

describe.each(implementations)('$name treatment-card-group', ({ api }) => {
  it('仅合并业务属性完全相同的卡，并累计数值字符串', () => {
    const groups = group(api, [
      { saleItemId: 'A', status: '已支付', paidSessions: 3, quantity: 1, amount: '12.50', availableSessions: 2 },
      { saleItemId: 'B', status: '已支付', paidSessions: 3, quantity: 1, amount: '12.50', availableSessions: 2 },
      { saleItemId: 'C', status: '部分支付', paidSessions: 3, quantity: 1, amount: '12.50', availableSessions: 2 },
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0].cardCount).toBe(2)
    expect(groups[0].sourceItems.map((card) => card.saleItemId)).toEqual(['A', 'B'])
    expect(api.sumGroupValue(groups[0], (card) => card.amount)).toBe(25)
  })

  it('将 paidSessions 为 null 视为与 0 不同的业务状态', () => {
    const groups = group(api, [
      { saleItemId: 'A', status: '已支付', paidSessions: null, quantity: 1, amount: null, availableSessions: 1 },
      { saleItemId: 'B', status: '已支付', paidSessions: null, quantity: 1, amount: null, availableSessions: 1 },
      { saleItemId: 'C', status: '已支付', paidSessions: 0, quantity: 1, amount: null, availableSessions: 1 },
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0].sourceItems).toHaveLength(2)
    expect(api.sumGroupValue(groups[0], (card) => card.amount)).toBe(0)
  })

  it('操作列表不拆分历史 quantity 大于 1 的单行', () => {
    const cards = [
      { saleItemId: 'legacy', status: '已支付', paidSessions: 3, quantity: 2, amount: '20', availableSessions: 3 },
      { saleItemId: 'current', status: '已支付', paidSessions: 3, quantity: 2, amount: '20', availableSessions: 3 },
    ]

    const operationGroups = group(api, cards)
    expect(operationGroups).toHaveLength(2)
    expect(operationGroups[0].cardCount).toBe(2)
    expect(operationGroups[0].sourceItems).toHaveLength(1)

    const displayGroups = group(api, cards, false)
    expect(displayGroups).toHaveLength(1)
    expect(displayGroups[0].cardCount).toBe(4)
  })

  it('服务单和转换单始终展开回原始 saleItemId', () => {
    const groups = group(api, [
      { saleItemId: 'A', status: '已支付', paidSessions: 3, quantity: 1, amount: '20', availableSessions: 2 },
      { saleItemId: 'B', status: '已支付', paidSessions: 3, quantity: 1, amount: '20', availableSessions: 3 },
    ])
    const [cardGroup] = groups

    expect(api.expandGroupServiceSessions(cardGroup, 4, (card) => card.saleItemId, (card) => card.availableSessions))
      .toEqual([
        { saleItemId: 'A', sessionUsed: 2 },
        { saleItemId: 'B', sessionUsed: 2 },
      ])
    expect(api.selectGroupSourceIds(cardGroup, 1, (card) => card.saleItemId)).toEqual(['A'])
  })
})
