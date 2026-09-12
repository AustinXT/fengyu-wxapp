import { describe, it, expect } from 'vitest'
import {
  DATE_BASIS_FILTER_OPTIONS,
  dateBasisShortLabel,
  parseAllocationOrderFilters,
  parseAllocationServiceFilters,
  parseEmployeeFilters,
  parseOrderFilters,
  parseOrderStatusFilters,
  parseOrderTypeFilters,
  parseServiceOrderFilters,
  parseServiceOrderStatusFilters,
  filterValidSkillValues,
} from './list-filters'

/**
 * parseEmployeeFilters 回归测试 — URL searchParams → EmployeeFilters 单值真源。
 * 覆盖 admin 员工管理列表的 skills 多选（逗号分隔）与 page/size 数字转换。
 */
describe('parseEmployeeFilters', () => {
  it('空 params → 全部 undefined', () => {
    expect(parseEmployeeFilters({})).toEqual({
      marketId: undefined,
      storeId: undefined,
      status: undefined,
      search: undefined,
      skills: undefined,
      page: undefined,
      pageSize: undefined,
    })
  })

  it('skill=美容师 → skills: ["美容师"]', () => {
    expect(parseEmployeeFilters({ skill: '美容师' }).skills).toEqual(['美容师'])
  })

  it('skill=美容师,养生师 → skills: ["美容师","养生师"]', () => {
    expect(parseEmployeeFilters({ skill: '美容师,养生师' }).skills).toEqual([
      '美容师',
      '养生师',
    ])
  })

  it('skill=,,美容师,, → 过滤空段（仅余 "美容师"）', () => {
    expect(parseEmployeeFilters({ skill: ',,美容师,,' }).skills).toEqual([
      '美容师',
    ])
  })

  it('skill=" "（仅空白） → skills: undefined（不返回空数组）', () => {
    // 防御:全空字符串 split 后过滤为空,应归一为 undefined,避免下游产生空数组条件
    expect(parseEmployeeFilters({ skill: '  , , ' }).skills).toBeUndefined()
  })

  it('status=active → "active"', () => {
    expect(parseEmployeeFilters({ status: 'active' }).status).toBe('active')
  })

  it('status=resigned → "resigned"', () => {
    expect(parseEmployeeFilters({ status: 'resigned' }).status).toBe('resigned')
  })

  it('page/size 转 number', () => {
    expect(
      parseEmployeeFilters({ page: '3', size: '50' }),
    ).toMatchObject({ page: 3, pageSize: 50 })
  })

  it('page 空串 → undefined（不返回 NaN）', () => {
    expect(parseEmployeeFilters({ page: '' }).page).toBeUndefined()
  })

  it('market/store/search 透传', () => {
    expect(
      parseEmployeeFilters({
        market: 'market-1',
        store: 'store-1',
        q: '张三',
      }),
    ).toMatchObject({
      marketId: 'market-1',
      storeId: 'store-1',
      search: '张三',
    })
  })
})

describe('订单/服务单列表筛选解析', () => {
  it('订单类型支持逗号分隔多选，并过滤无效/重复值', () => {
    expect(parseOrderTypeFilters('销售单, 转换单,销售单,已废弃单据')).toEqual([
      '销售单',
      '转换单',
    ])
  })

  it('订单类型全为无效值时不添加类型筛选', () => {
    expect(parseOrderTypeFilters('已废弃单据,')).toBeUndefined()
  })

  it('订单状态支持逗号分隔多选，并过滤无效/重复值', () => {
    expect(parseOrderStatusFilters('待支付, 已支付,待支付,未知')).toEqual(['待支付', '已支付'])
  })

  it('服务单状态支持逗号分隔多选，并过滤无效/重复值', () => {
    expect(parseServiceOrderStatusFilters('待服务,已完成,待服务,未知')).toEqual(['待服务', '已完成'])
  })

  it('订单列表透传 market/store URL 参数', () => {
    expect(parseOrderFilters({ market: 'market-1', store: 'store-1' })).toMatchObject({
      marketId: 'market-1',
      storeId: 'store-1',
    })
  })

  it('订单列表将 type URL 参数解析为多选类型', () => {
    expect(parseOrderFilters({ type: '销售单,充值单' }).types).toEqual(['销售单', '充值单'])
  })

  it('订单列表将 status URL 参数解析为多选状态', () => {
    expect(parseOrderFilters({ status: '待支付,待审批' }).statuses).toEqual(['待支付', '待审批'])
  })

  it('订单日期口径缺省为款项归属日期，order/payment 需显式指定', () => {
    expect(parseOrderFilters({ dateBasis: 'payment' }).dateBasis).toBe('payment')
    expect(parseOrderFilters({ dateBasis: 'order' }).dateBasis).toBe('order')
    expect(parseOrderFilters({ dateBasis: 'attribution' }).dateBasis).toBe('attribution')
    expect(parseOrderFilters({ dateBasis: 'invalid' }).dateBasis).toBe('attribution')
    expect(parseOrderFilters({}).dateBasis).toBe('attribution')
  })

  it('日期口径下拉以款项归属日期打头，short 标签供 DatePicker aria-label 复用', () => {
    expect(DATE_BASIS_FILTER_OPTIONS.map((option) => option.value)).toEqual([
      'attribution',
      'payment',
      'order',
    ])
    expect(dateBasisShortLabel('attribution')).toBe('款项归属')
    expect(dateBasisShortLabel('payment')).toBe('款项发生')
    expect(dateBasisShortLabel('order')).toBe('下单')
  })

  it('服务单列表透传 market/store URL 参数', () => {
    expect(parseServiceOrderFilters({ market: 'market-1', store: 'store-1' })).toMatchObject({
      marketId: 'market-1',
      storeId: 'store-1',
    })
  })

  it('服务单列表将 status URL 参数解析为多选状态', () => {
    expect(parseServiceOrderFilters({ status: '待服务,服务中' }).statuses).toEqual(['待服务', '服务中'])
  })

  it('营业额分配销售提成透传筛选并锁定已支付订单', () => {
    expect(
      parseAllocationOrderFilters({
        market: 'market-1',
        store: 'store-1',
        allocStatus: 'pending',
        dateBasis: 'payment',
      }),
    ).toMatchObject({
      status: '已支付',
      marketId: 'market-1',
      storeId: 'store-1',
      allocationStatus: 'pending',
      allocationEligibleOnly: true,
      dateBasis: 'payment',
    })
    expect(parseAllocationOrderFilters({ dateBasis: 'invalid' }).dateBasis).toBe('attribution')
    expect(parseAllocationOrderFilters({}).dateBasis).toBe('attribution')
  })

  it('营业额分配服务提成透传 market/store 并锁定已完成服务单', () => {
    expect(
      parseAllocationServiceFilters({
        market: 'market-1',
        store: 'store-1',
        allocStatus: 'pending',
      }),
    ).toMatchObject({
      status: '已完成',
      marketId: 'market-1',
      storeId: 'store-1',
      commissionStatus: 'pending',
    })
  })
})

/**
 * filterValidSkillValues 回归测试 — 剔除 URL 残留的已停用技能标签，防幽灵筛选。
 * 双端调用方（page.tsx 后端查询前 + employees-page.tsx 前端 selectedSkills）依赖：
 * 空输入/清洗后空 → undefined（与 parseEmployeeFilters 的 skills 契约一致）。
 */
describe('filterValidSkillValues', () => {
  const valid = new Set(['护理', '家居'])

  it('undefined → undefined', () => {
    expect(filterValidSkillValues(undefined, valid)).toBeUndefined()
  })

  it('空数组 → undefined', () => {
    expect(filterValidSkillValues([], valid)).toBeUndefined()
  })

  it('全有效 → 原样返回', () => {
    expect(filterValidSkillValues(['护理', '家居'], valid)).toEqual(['护理', '家居'])
  })

  it('含失效 → 只保留有效（剔除已停用标签）', () => {
    expect(filterValidSkillValues(['护理', '已停用标签', '家居'], valid)).toEqual(['护理', '家居'])
  })

  it('全失效 → undefined（防幽灵筛选：后端不再按失效标签过滤）', () => {
    expect(filterValidSkillValues(['旧标签1', '旧标签2'], valid)).toBeUndefined()
  })

  it('validNames 为空集 → 任意输入都 undefined（无有效标签时筛选 no-op）', () => {
    expect(filterValidSkillValues(['护理'], new Set())).toBeUndefined()
  })

  it('保留有效项的原始顺序', () => {
    expect(filterValidSkillValues(['家居', '护理', '失效'], valid)).toEqual(['家居', '护理'])
  })
})
