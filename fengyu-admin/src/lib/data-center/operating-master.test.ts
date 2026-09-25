import { describe, expect, it } from 'vitest'
import { buildMatrixHeaderLayout, computeFrozenPositions } from './matrix'
import {
  OPERATING_MASTER_COLUMNS,
  OPERATING_MASTER_METRIC_KEYS,
  buildOperatingMasterTable,
  isOperatingMasterSubtotal,
  operatingMasterEmptyText,
  operatingMasterExportParams,
  operatingMasterTotalsLabel,
  ytdRange,
  type OperatingMasterStore,
} from './operating-master'

const letters = (predicate: (column: (typeof OPERATING_MASTER_COLUMNS)[number]) => boolean) =>
  OPERATING_MASTER_COLUMNS.filter(predicate).map((column) => column.letter).join('')

describe('经营数据主表列结构（对照《经营数据主表.xlsx》凤御·经营 B~Y）', () => {
  it('B~Y 24 列按模板顺序，列名照抄模板第 3 行（V 按批注写「生美项目数」）', () => {
    expect(letters(() => true)).toBe('BCDEFGHIJKLMNOPQRSTUVWXY')
    expect(OPERATING_MASTER_COLUMNS.map((column) => column.header)).toEqual([
      '市场', '门店', '美容师\n人数',
      '保有会员\n前三月有回店1次人头数', '回店1次\n当月人头', '回店1次\n达成率', '回店≥2次\n当月人头', '回店≥2次\n达成率',
      '被经营顾客\n年度目标', '被经营顾客\n年度消费人数', '被经营顾客\n当月消费人数', '被经营率\n年度标准60%',
      '年度销售\n业绩目标', '当月业绩\n目标', '当月\n完成', '当月\n完成率', '年度\n累计达成',
      '当月\n客流', '当月\n售前客流', '当月\n售后客流', '当月\n生美项目数', '当月\n总实耗', '当月\n生美实耗', '单次\n生美客耗',
    ])
  })

  it('列键唯一：市场 / 门店不与被经营率、当月客流等数值列共用键（原型 §5.3 易错点）', () => {
    const keys = OPERATING_MASTER_COLUMNS.map((column) => column.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.slice(0, 2)).toEqual(['marketName', 'storeName'])
  })

  it('分组跨度 E–I / J–M / N–R / S–Y，标题照抄模板 E2/J2/N2/S2 全文，四组各一种底色；B–D 上方留空', () => {
    const layout = buildMatrixHeaderLayout(OPERATING_MASTER_COLUMNS)
    const groups = layout.rows[0].map((cell) => ({
      header: OPERATING_MASTER_COLUMNS[cell.firstLeafIndex].group?.header,
      from: OPERATING_MASTER_COLUMNS[cell.firstLeafIndex].letter,
      span: cell.colSpan,
    }))
    expect(groups.map(({ from, span }) => `${from}+${span}`)).toEqual(['B+2', 'D+1', 'E+5', 'J+4', 'N+5', 'S+7'])
    expect(groups.slice(0, 2).map((group) => group.header)).toEqual(['', ''])
    expect(groups[2].header).toBe('保有会员（售前不算）\n会员标准：单笔订单≥1990元(购买疗程有余卡顾客)\n当月回店1次的人头目标：80%\n当月回店人头到店2次的目标：60%')
    expect(groups[3].header).toBe('被经营顾客目标(拆分季度/月度)\n核算标准：消费≥1990算人数\n一季度目标:20%-30%，二季度目标:50%-60%\n三季度目标:70%-80%，四季度目标:100%完成')
    expect(groups[4].header).toBe('销售业绩目标')
    expect(groups[5].header).toBe('客流及客耗\n美容师:3人/250客流 4人/300客量 5人/400客流\n美容师消耗：每天1000元\n客流目标：售前20%  售后80%')

    const colors = ['E', 'J', 'N', 'S'].map((letter) => OPERATING_MASTER_COLUMNS.find((c) => c.letter === letter)!.group?.color)
    expect(new Set(colors).size).toBe(4)
    expect(colors.every(Boolean)).toBe(true)
  })

  it('导出列宽容得下列名最长一行（中文按 2 宽），Excel 不会再折行裁字', () => {
    const e = OPERATING_MASTER_COLUMNS.find((column) => column.letter === 'E')!
    expect(e.exportWidth).toBeGreaterThanOrEqual('前三月有回店1次人头数'.length * 2)
    for (const column of OPERATING_MASTER_COLUMNS.filter((c) => c.letter >= 'D')) {
      const longest = Math.max(...column.header.split('\n').map((line) => [...line].length))
      expect(column.exportWidth, column.letter).toBeGreaterThanOrEqual(longest * 2 - 2)
    }
  })

  it('冻结市场、门店两列（其余横向滚动）', () => {
    const frozen = computeFrozenPositions(OPERATING_MASTER_COLUMNS)
    expect([...frozen.keys()]).toEqual(['marketName', 'storeName'])
  })

  it('展示格式：G/I/M/Q 百分比；D/E/F/H/K/L/S/T/U/V 整数；P/R/W/X/Y 金额', () => {
    expect(letters((column) => column.unit === 'percent')).toBe('GIMQ')
    expect(letters((column) => column.unit === 'count')).toBe('DEFHJKLSTUV')
    expect(letters((column) => column.unit === 'amount')).toBe('NOPRWXY')
  })

  it('首版取数列 D/P/R/V/W/X；占位 16 列：#373 口径 E–I、K–M、S–U、Y，#374 目标 J/N/O/Q', () => {
    expect(letters((column) => !!column.value)).toBe('DPRVWX')
    expect(letters((column) => column.pending === '#373')).toBe('EFGHIKLMSTUY')
    expect(letters((column) => column.pending === '#374')).toBe('JNOQ')
    for (const column of OPERATING_MASTER_COLUMNS.filter((c) => c.pending)) {
      // 占位列不取数、不参与合计，导出写「—」
      expect(column.value, column.letter).toBeUndefined()
      expect(column.aggregate, column.letter).toBeUndefined()
      expect(column.exportValue?.({} as never), column.letter).toBe('—')
    }
    expect(OPERATING_MASTER_COLUMNS.filter((c) => c.value).map((c) => c.key)).toEqual([
      'beauticianCount', 'monthRevenue', 'ytdRevenue', 'shengmeiProjectCount', 'monthConsume', 'shengmeiConsume',
    ])
    expect([...OPERATING_MASTER_METRIC_KEYS].sort()).toEqual(
      OPERATING_MASTER_COLUMNS.filter((c) => c.value).map((c) => c.key).sort(),
    )
  })
})

describe('年度累计区间', () => {
  it('当年 1 月 1 日 ~ 所选月末；1 月与当月区间相同（R = P）', () => {
    expect(ytdRange('2026-01')).toEqual({ start: '2026-01-01', end: '2026-01-31' })
    expect(ytdRange('2026-08')).toEqual({ start: '2026-01-01', end: '2026-08-31' })
    expect(ytdRange('2028-02')).toEqual({ start: '2028-01-01', end: '2028-02-29' })
  })
})

describe('buildOperatingMasterTable', () => {
  const zg: OperatingMasterStore[] = [
    { storeId: 'S1', storeName: '汇东店', marketId: 'M1', marketName: '自贡' },
    { storeId: 'S2', storeName: '南湖店', marketId: 'M1', marketName: '自贡' },
  ]
  const nc: OperatingMasterStore = { storeId: 'S3', storeName: '蓝莱店', marketId: 'M2', marketName: '南昌凤御' }
  const metrics = new Map([
    ['S1', { beauticianCount: 4, monthRevenue: 91182, ytdRevenue: 156152, shengmeiProjectCount: 298, monthConsume: 0.1, shengmeiConsume: 0.2 }],
    ['S2', { beauticianCount: 3, monthRevenue: -182, ytdRevenue: 0, shengmeiProjectCount: 0, monthConsume: 0.2, shengmeiConsume: 0.1 }],
    ['S3', { beauticianCount: 5, monthRevenue: 100 }],
  ])

  it('单市场：只有门店行，表尾「合计」= 各门店之和（负数照加，不过滤 0 / 负值）', () => {
    const table = buildOperatingMasterTable(zg, metrics)
    expect(table.multiMarket).toBe(false)
    expect(table.rows.map((row) => row.rowKey)).toEqual(['S1', 'S2'])
    expect(table.totals).toMatchObject({ beauticianCount: 7, monthRevenue: 91000, ytdRevenue: 156152, shengmeiProjectCount: 298 })
    expect(table.totals.monthConsume).toBeCloseTo(0.3)
    expect(operatingMasterTotalsLabel(table.multiMarket)).toBe('合计')
    // 合计只含取数列，占位列不在内
    expect(Object.keys(table.totals).sort()).toEqual([...OPERATING_MASTER_METRIC_KEYS].sort())
  })

  it('跨市场：每个市场一行小计，表尾「总计」只由门店行算（小计不重复计入）', () => {
    const table = buildOperatingMasterTable([...zg, nc], metrics)
    expect(table.multiMarket).toBe(true)
    expect(table.rows.map((row) => row.rowKey)).toEqual(['S1', 'S2', 'subtotal:M1', 'S3', 'subtotal:M2'])
    const [, , zgSubtotal, , ncSubtotal] = table.rows
    expect(isOperatingMasterSubtotal(zgSubtotal)).toBe(true)
    expect(zgSubtotal).toMatchObject({ marketName: '自贡', storeName: '小计', storeId: null })
    expect(zgSubtotal.values).toMatchObject({ beauticianCount: 7, monthRevenue: 91000 })
    expect(ncSubtotal.values).toMatchObject({ beauticianCount: 5, monthRevenue: 100, ytdRevenue: 0 })
    expect(table.totals).toMatchObject({ beauticianCount: 12, monthRevenue: 91100 })
    expect(table.storeCount).toBe(3)
    expect(operatingMasterTotalsLabel(table.multiMarket)).toBe('总计')
  })

  it('没有任何数据的在营门店照常出行、各列为 0（与「门店已停用」的空态区分）', () => {
    const table = buildOperatingMasterTable([nc], new Map())
    expect(table.rows[0].values).toEqual({
      beauticianCount: 0, monthRevenue: 0, ytdRevenue: 0, shengmeiProjectCount: 0, monthConsume: 0, shengmeiConsume: 0,
    })
    expect(operatingMasterEmptyText(table)).toBeNull()
  })

  it('范围内没有在营门店 → 空态文案', () => {
    const table = buildOperatingMasterTable([], metrics)
    expect(table.rows).toEqual([])
    expect(operatingMasterEmptyText(table)).toMatch(/没有在营门店/)
  })
})

describe('operatingMasterExportParams', () => {
  it('取生效的范围与月份', () => {
    expect(operatingMasterExportParams({ type: 'all' }, '2026-08')).toEqual({ month: '2026-08' })
    expect(operatingMasterExportParams({ type: 'authorized' }, '2026-08')).toEqual({ month: '2026-08', scope: 'authorized' })
    expect(operatingMasterExportParams({ type: 'market', id: 'M1' }, '2026-08')).toEqual({ month: '2026-08', scope: 'market', scopeId: 'M1' })
    expect(operatingMasterExportParams({ type: 'store', id: 'S1' }, '2026-07')).toEqual({ month: '2026-07', scope: 'store', scopeId: 'S1' })
  })
})
