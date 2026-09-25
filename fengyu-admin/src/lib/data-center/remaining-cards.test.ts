import { describe, expect, it } from 'vitest'
import { buildMatrixHeaderLayout } from './matrix'
import { toWorkerExportColumns } from './matrix-export'
import {
  buildRemainingCardsModel,
  columnKey,
  displaySearchTerm,
  filterRemainingCardsRows,
  parseRemainingCardsParams,
  remainingCardsColumnSpecs,
  remainingCardsTotals,
  remainingCellExportValue,
  remainingCellHint,
  resolveCellState,
  sortRemainingCardsRows,
  summarizeRemainingCards,
  toPublicRow,
  UNCATEGORIZED_KEY,
  type RemainingCardsCategory,
  type RemainingCardsSqlRow,
  type RemainingCellAggregate,
} from './remaining-cards'

/**
 * 顾客剩余卡项清单（#371）纯逻辑：格态、三层勾稽、四态合计、搜索收紧、排序兜底、导出格。
 */

const DICT: RemainingCardsCategory[] = [
  { categoryId: 'C-mx1', categoryName: '美艺美肤', kind: '明星', kindSort: 3, sort: 1 },
  { categoryId: 'C-zp2', categoryName: '绝对招牌', kind: '招牌', kindSort: 1, sort: 2 },
  { categoryId: 'C-zp1', categoryName: '招牌', kind: '招牌', kindSort: 1, sort: 1 },
  { categoryId: 'C-unused', categoryName: '没人持卡', kind: '王牌', kindSort: 2, sort: 1 },
]

function cell(categoryId: string | null, patch: Partial<RemainingCellAggregate> = {}): RemainingCellAggregate {
  return {
    categoryId,
    remaining: 0,
    unpaid: 0,
    activeRows: 1,
    expiredRows: 0,
    served: 0,
    convertedOut: 0,
    deposit: false,
    frozen: false,
    ...patch,
  }
}

function sqlRow(patch: Partial<RemainingCardsSqlRow> & Pick<RemainingCardsSqlRow, 'clientUserId' | 'storeId'>): RemainingCardsSqlRow {
  return {
    storeName: `店${patch.storeId}`,
    customerName: `顾客${patch.clientUserId}`,
    phone: '13800001111',
    memberLevel: null,
    customerType: '流量客',
    cells: [],
    ...patch,
  }
}

const SQL_ROWS: RemainingCardsSqlRow[] = [
  // 多店持卡：同一顾客两行
  sqlRow({
    clientUserId: 'U1', storeId: 'S1', customerName: '张三', phone: '13811112222', memberLevel: '金卡',
    cells: [cell('C-zp1', { remaining: 5, served: 3, deposit: true }), cell('C-mx1', { unpaid: 2 })],
  }),
  sqlRow({ clientUserId: 'U1', storeId: 'S2', customerName: '张三', phone: '13811112222', cells: [cell('C-zp2', { remaining: 1 })] }),
  // 已服务完（整格被折抵转走）、只剩过期卡
  sqlRow({
    clientUserId: 'U2', storeId: 'S1', customerName: '李四', customerType: '会员客',
    cells: [cell('C-zp1', { served: 4, convertedOut: 6 }), cell('C-zp2', { activeRows: 0, expiredRows: 1, remaining: 0 })],
  }),
  // 无分类卡
  sqlRow({ clientUserId: 'U3', storeId: 'S2', customerName: '王五', cells: [cell(null, { remaining: 2, frozen: true })] }),
  // 没有卡的顾客（按绑定门店出行）
  sqlRow({ clientUserId: 'U4', storeId: 'S1', customerName: '赵六', phone: null, cells: [] }),
]

const model = buildRemainingCardsModel(SQL_ROWS, DICT)
const rowOf = (key: string) => model.rows.find((row) => row.key === key)!

describe('格态判定', () => {
  it('按 有剩余 → 待付清 → 已服务完 顺序；只剩过期卡为已过期；没有卡行不产生格', () => {
    expect(resolveCellState({ remaining: 3, unpaid: 2, activeRows: 1, expiredRows: 1 })).toBe('remaining')
    expect(resolveCellState({ remaining: 0, unpaid: 2, activeRows: 1, expiredRows: 0 })).toBe('unpaid')
    expect(resolveCellState({ remaining: 0, unpaid: 0, activeRows: 2, expiredRows: 0 })).toBe('done')
    expect(resolveCellState({ remaining: 0, unpaid: 0, activeRows: 0, expiredRows: 1 })).toBe('expired')
    expect(resolveCellState({ remaining: 0, unpaid: 0, activeRows: 0, expiredRows: 0 })).toBeNull()
  })

  it('欠款卡是「待付清」而不是「已服务完」；整格被折抵转走归「已服务完」', () => {
    expect(rowOf('U1:S1').cells['C-mx1'].state).toBe('unpaid')
    expect(rowOf('U2:S1').cells['C-zp1'].state).toBe('done')
  })
})

describe('行模型与列', () => {
  it('只列有人持卡的二级，按（一级 sort，二级 sort）排，无分类列排最后', () => {
    expect(model.columns.map((column) => column.categoryId)).toEqual(['C-zp1', 'C-zp2', 'C-mx1', UNCATEGORIZED_KEY])
    expect(model.columns.at(-1)).toMatchObject({ categoryName: '未分类', kind: '未分类' })
  })

  it('行剩余合计 = 该行各格之和（只加有剩余的格）', () => {
    for (const row of model.rows) {
      const sum = Object.values(row.cells).reduce((total, item) => total + (item.state === 'remaining' ? item.remaining : 0), 0)
      expect(row.remaining, row.key).toBe(sum)
    }
    expect(rowOf('U1:S1').remaining).toBe(5)
    expect(rowOf('U4:S1').remaining).toBe(0)
  })

  it('会员等级为空时显示 customer_type；电话服务端脱敏，返回值不带原始号码', () => {
    expect(rowOf('U1:S1').level).toBe('金卡')
    expect(rowOf('U2:S1').level).toBe('会员客')
    const publicRow = toPublicRow(rowOf('U1:S1'))
    expect(publicRow.phoneMasked).toBe('138****2222')
    expect(JSON.stringify(publicRow)).not.toContain('13811112222')
    expect(Object.keys(publicRow)).not.toContain('rawPhone')
  })
})

describe('指标卡与四态合计', () => {
  const summary = summarizeRemainingCards(model)

  it('多店持卡的顾客只算 1 位；有剩余顾客按行剩余 > 0', () => {
    expect(summary.rowCount).toBe(5)
    expect(summary.customerCount).toBe(4)
    expect(summary.remainingCustomerCount).toBe(2) // U1、U3
    expect(summary.remainingCustomerRate).toBe(0.5)
  })

  it('有余额 + 待付清 + 已服务完 + 未买过（含已过期）= 行数 × 列数', () => {
    expect(summary.categoryCount).toBe(4)
    expect(summary.kindCount).toBe(3)
    expect(summary.remainingCells + summary.unpaidCells + summary.doneCells + summary.neverCells)
      .toBe(summary.rowCount * summary.categoryCount)
    expect(summary).toMatchObject({ remainingCells: 3, unpaidCells: 1, doneCells: 1, expiredCells: 1, neverCells: 15 })
  })

  it('待服务剩余次数 = 全部行剩余之和，涉及品项按有剩余的列去重', () => {
    expect(summary.remainingSessions).toBe(8)
    expect(summary.remainingCategoryCount).toBe(3)
  })
})

describe('表尾合计（三层勾稽）', () => {
  it('表尾每列 = 传入的全部行该列之和；没有搜索时表尾总计 = 指标卡「待服务剩余次数」', () => {
    const totals = remainingCardsTotals(model.rows, model.columns)
    expect(totals).toEqual({
      remaining: 8,
      [columnKey({ categoryId: 'C-zp1' })]: 5,
      [columnKey({ categoryId: 'C-zp2' })]: 1,
      [columnKey({ categoryId: 'C-mx1' })]: 0,
      [columnKey({ categoryId: UNCATEGORIZED_KEY })]: 2,
    })
    expect(totals.remaining).toBe(summarizeRemainingCards(model).remainingSessions)
  })

  it('「只看有剩余」隐藏的行剩余都是 0，表尾总计不变', () => {
    const shown = filterRemainingCardsRows(model.rows, { q: '', show: 'remaining' })
    expect(shown.map((row) => row.key).sort()).toEqual(['U1:S1', 'U1:S2', 'U3:S2'])
    expect(remainingCardsTotals(shown, model.columns).remaining).toBe(8)
  })
})

describe('搜索', () => {
  const keys = (q: string) => filterRemainingCardsRows(model.rows, { q, show: 'all' }).map((row) => row.key).sort()

  it('姓名 / 门店 / 会员等级（member_level 与 customer_type 都匹配）模糊', () => {
    expect(keys('张')).toEqual(['U1:S1', 'U1:S2'])
    expect(keys('店S2')).toEqual(['U1:S2', 'U3:S2'])
    expect(keys('金卡')).toEqual(['U1:S1'])
    expect(keys('会员客')).toEqual(['U2:S1'])
  })

  it('手机号只按完整号码精确匹配；部分号码 / 脱敏号码都搜不到（防反推）', () => {
    expect(keys('13811112222')).toEqual(['U1:S1', 'U1:S2'])
    expect(keys('1381111')).toEqual([])
    expect(keys('2222')).toEqual([])
    expect(keys('138****2222')).toEqual([])
  })
})

describe('排序', () => {
  it('默认剩余从多到少，并列依次按姓名、顾客 id、门店 id 兜底', () => {
    const rows = [
      { ...toPublicRow(rowOf('U4:S1')), key: 'b', customerName: '甲', clientUserId: 'U9', storeId: 'S1', remaining: 0 },
      { ...toPublicRow(rowOf('U4:S1')), key: 'a', customerName: '甲', clientUserId: 'U8', storeId: 'S2', remaining: 0 },
      { ...toPublicRow(rowOf('U4:S1')), key: 'c', customerName: '甲', clientUserId: 'U8', storeId: 'S1', remaining: 0 },
      { ...toPublicRow(rowOf('U4:S1')), key: 'd', customerName: '乙', clientUserId: 'U1', storeId: 'S1', remaining: 0 },
      { ...toPublicRow(rowOf('U4:S1')), key: 'e', customerName: '丙', clientUserId: 'U1', storeId: 'S1', remaining: 9 },
    ]
    const sorted = sortRemainingCardsRows(rows, 'desc')
    expect(sorted[0].key).toBe('e')
    // 同名按顾客 id、再按门店 id；不同名按姓名排序（排序规则以 zh-CN collator 为准，页面与导出同源）
    expect(sorted.filter((row) => row.customerName === '甲').map((row) => row.key)).toEqual(['c', 'a', 'b'])
    const names = sorted.slice(1).map((row) => row.customerName)
    expect(names.indexOf('乙') === 0 || names.indexOf('乙') === 3).toBe(true)
    // 升序只翻转剩余次数，兜底键方向不变
    expect(sortRemainingCardsRows(rows, 'asc').at(-1)!.key).toBe('e')
    expect(sortRemainingCardsRows([...rows].reverse(), 'desc').map((row) => row.key)).toEqual(sorted.map((row) => row.key))
  })
})

describe('悬停与导出格', () => {
  it('悬停：有剩余带已服务次数，已服务完带折抵转出，未买过；寄存 / 在途退款附注', () => {
    expect(remainingCellHint(rowOf('U1:S1').cells['C-zp1'])).toBe('剩余 5 次未服务（已服务 3 次）；含迁移寄存')
    expect(remainingCellHint(rowOf('U1:S1').cells['C-mx1'])).toBe('未付 2 次')
    expect(remainingCellHint(rowOf('U2:S1').cells['C-zp1'])).toBe('已服务完（已服务 4 次；已折抵转出 6 次）')
    expect(remainingCellHint(rowOf('U2:S1').cells['C-zp2'])).toBe('已过期')
    expect(remainingCellHint(rowOf('U3:S2').cells[UNCATEGORIZED_KEY])).toBe('剩余 2 次未服务（已服务 0 次）；有在途退款，次数暂未扣减')
    expect(remainingCellHint(undefined)).toBe('未买过')
  })

  it('导出：有剩余写次数；待付清 / 已服务完 / 已过期写文字；未买过留空；带两行表头与合计', () => {
    expect(remainingCellExportValue(rowOf('U1:S1').cells['C-zp1'])).toBe(5)
    expect(remainingCellExportValue(rowOf('U1:S1').cells['C-mx1'])).toBe('待付清')
    expect(remainingCellExportValue(rowOf('U2:S1').cells['C-zp1'])).toBe('已服务完')
    expect(remainingCellExportValue(rowOf('U2:S1').cells['C-zp2'])).toBe('已过期')
    expect(remainingCellExportValue(undefined)).toBe('')

    const specs = remainingCardsColumnSpecs(model.columns)
    const exported = toWorkerExportColumns(specs, remainingCardsTotals(model.rows, model.columns))
    expect(exported.map((column) => column.header)).toEqual(['门店', '顾客', '会员等级', '招牌', '绝对招牌', '美艺美肤', '未分类', '剩余次数'])
    expect(exported.map((column) => column.group?.header ?? null)).toEqual([null, null, null, '招牌', '招牌', '明星', '未分类', null])
    expect(exported.map((column) => column.total ?? null)).toEqual([null, null, null, 5, 1, 0, 2, 8])
    const row = toPublicRow(rowOf('U1:S1'))
    expect(exported.map((column) => column.value(row))).toEqual(['店S1', '张三 138****2222', '金卡', 5, '', '待付清', '', 5])
  })
})

describe('参数解析', () => {
  it('缺省：全部顾客、剩余降序、第 1 页 50 条；非法值回落默认', () => {
    expect(parseRemainingCardsParams({})).toEqual({
      scope: { type: 'all' }, q: '', show: 'all', direction: 'desc', page: 1, pageSize: 50,
    })
    expect(parseRemainingCardsParams({ show: 'x', dir: 'x', page: '-3', size: '7' })).toMatchObject({
      show: 'all', direction: 'desc', page: 1, pageSize: 50,
    })
    expect(parseRemainingCardsParams({ scope: 'store', scopeId: 'S1', q: ' 张 ', show: 'remaining', dir: 'asc', page: '3', size: '100' }))
      .toEqual({ scope: { type: 'store', id: 'S1' }, q: '张', show: 'remaining', direction: 'asc', page: 3, pageSize: 100 })
  })
})

describe('列分组的相邻性（评审 P2：分组被隔开会让表头与导出抛 INVALID_STATE）', () => {
  it('一级分类恰好叫「未分类」且同时有无分类卡：未分类列独立分组，不抛错', () => {
    const dict: RemainingCardsCategory[] = [
      { categoryId: 'K1', categoryName: 'X', kind: '未分类', kindSort: 1, sort: 1 },
      { categoryId: 'K2', categoryName: '招牌', kind: '招牌', kindSort: 2, sort: 1 },
    ]
    const built = buildRemainingCardsModel([
      sqlRow({ clientUserId: 'U1', storeId: 'S1', cells: [cell('K1', { remaining: 1 }), cell('K2', { remaining: 1 }), cell(null, { remaining: 1 })] }),
    ], dict)
    const specs = remainingCardsColumnSpecs(built.columns)
    expect(() => buildMatrixHeaderLayout(specs)).not.toThrow()
    expect(built.columns.map((column) => column.categoryId)).toEqual(['K1', 'K2', UNCATEGORIZED_KEY])
  })

  it('同一级下各二级的排序权重不一致（同名一级行重复）时仍相邻', () => {
    const dict: RemainingCardsCategory[] = [
      { categoryId: 'A1', categoryName: 'a1', kind: '王牌', kindSort: 1, sort: 1 },
      { categoryId: 'B1', categoryName: 'b1', kind: '明星', kindSort: 2, sort: 1 },
      { categoryId: 'A2', categoryName: 'a2', kind: '王牌', kindSort: 3, sort: 2 },
    ]
    const built = buildRemainingCardsModel([
      sqlRow({ clientUserId: 'U1', storeId: 'S1', cells: [cell('A1', { remaining: 1 }), cell('B1', { remaining: 1 }), cell('A2', { remaining: 1 })] }),
    ], dict)
    expect(built.columns.map((column) => column.categoryId)).toEqual(['A1', 'A2', 'B1'])
    expect(() => buildMatrixHeaderLayout(remainingCardsColumnSpecs(built.columns))).not.toThrow()
  })

  it('字典里查不到的分类 id 与无分类卡并入同一个「未分类」格（次数相加，不出重名列）', () => {
    const built = buildRemainingCardsModel([
      sqlRow({ clientUserId: 'U1', storeId: 'S1', cells: [cell('GONE-1', { remaining: 2, deposit: true }), cell('GONE-2', { remaining: 3 }), cell(null, { unpaid: 1 })] }),
    ], DICT)
    expect(built.columns.map((column) => column.categoryId)).toEqual([UNCATEGORIZED_KEY])
    expect(built.rows[0].cells[UNCATEGORIZED_KEY]).toMatchObject({ state: 'remaining', remaining: 5, unpaid: 1, deposit: true })
    expect(built.rows[0].remaining).toBe(5)
  })
})

describe('导出元信息的搜索词', () => {
  it('完整手机号脱敏，其余原样', () => {
    expect(displaySearchTerm(' 13811112222 ')).toBe('138****2222')
    expect(displaySearchTerm('张三')).toBe('张三')
  })

  it('库里带空格的号码也能按完整号码搜到', () => {
    const built = buildRemainingCardsModel([sqlRow({ clientUserId: 'U1', storeId: 'S1', phone: '138 1111 2222' })], DICT)
    expect(filterRemainingCardsRows(built.rows, { q: '13811112222', show: 'all' })).toHaveLength(1)
  })
})
