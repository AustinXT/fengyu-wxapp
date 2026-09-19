import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import InventorySubjectSelect from './inventory-subject-select'

const HQ = [{ value: 'ORG-HQ', label: '品牌总部' }]
const MARKETS = [
  { value: 'M1', label: '南昌凤御' },
  { value: 'M2', label: '自贡凤御' },
]

describe('InventorySubjectSelect（#189 候选唯一即自动选中）', () => {
  it('候选唯一时自动上报该值，并渲染成只读文本而非下拉', () => {
    const onChange = vi.fn()
    render(
      <InventorySubjectSelect options={HQ} value="" onChange={onChange} placeholder="请选择总部" />,
    )

    expect(onChange).toHaveBeenCalledExactlyOnceWith('ORG-HQ')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByText('品牌总部')).toHaveAttribute('data-fixed-subject', 'ORG-HQ')
  })

  it('自动选中经调用方的 onChange 走，不绕过表单联动', () => {
    // 报货门店要带出所属市场、员工购要按主体拉员工列表、换主体要清空已选批次 ——
    // 这些都挂在调用方的 onChange 上。组件自己存 state 会把联动整个吞掉。
    const sideEffect = vi.fn()
    render(
      <InventorySubjectSelect
        options={HQ}
        value=""
        onChange={(next) => sideEffect(`联动:${next}`)}
        placeholder="请选择总部"
      />,
    )

    expect(sideEffect).toHaveBeenCalledWith('联动:ORG-HQ')
  })

  it('值已回填后不再重复上报，即使父组件换了新的 onChange 引用', () => {
    // 调用方传的都是内联箭头函数，每次渲染都是新引用；若把它放进 effect 依赖，
    // 父组件每重渲染一次就会重报一次，配合带副作用的 onChange（异步拉员工）会刷请求。
    const onChange = vi.fn()
    const { rerender } = render(
      <InventorySubjectSelect options={HQ} value="" onChange={() => onChange('first')} placeholder="请选择总部" />,
    )
    expect(onChange).toHaveBeenCalledTimes(1)

    rerender(
      <InventorySubjectSelect options={HQ} value="ORG-HQ" onChange={() => onChange('second')} placeholder="请选择总部" />,
    )
    rerender(
      <InventorySubjectSelect options={HQ} value="ORG-HQ" onChange={() => onChange('third')} placeholder="请选择总部" />,
    )

    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('候选多于一个时仍是可选下拉，带空占位项', () => {
    const onChange = vi.fn()
    render(
      <InventorySubjectSelect options={MARKETS} value="" onChange={onChange} placeholder="请选择市场" />,
    )

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('option', { name: '请选择市场' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'M2' } })
    expect(onChange).toHaveBeenLastCalledWith('M2')
  })

  it('候选唯一但值是候选之外的（随单回填了看不到的主体）时不覆盖、不撒谎', () => {
    // 采购订单 / 发货 / 入库 / 配货共 5 处会在选定来源单据后把主体回填成单据自己的
    // 主体。若那个主体不在当前用户的候选里，只读文本显示唯一候选就是撒谎，
    // 自动改值更是把随单锁定的主体悄悄换掉。
    const onChange = vi.fn()
    render(
      <InventorySubjectSelect
        options={HQ}
        value="ORG-OTHER-HQ"
        onChange={onChange}
        placeholder="请选择总部"
      />,
    )

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByText('品牌总部')).not.toHaveAttribute('data-fixed-subject')
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('无候选时渲染空下拉，不上报任何值', () => {
    const onChange = vi.fn()
    render(
      <InventorySubjectSelect options={[]} value="" onChange={onChange} placeholder="请选择总部" />,
    )

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox')).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(1)
  })

  it('disabled 只作用于可选下拉，只读态不受影响', () => {
    // 供应链采购入库的主体在选定单据后 disabled={Boolean(doc)}：随单锁定。
    const { rerender } = render(
      <InventorySubjectSelect options={MARKETS} value="M1" onChange={vi.fn()} placeholder="请选择市场" disabled />,
    )
    expect(screen.getByRole('combobox')).toBeDisabled()

    rerender(
      <InventorySubjectSelect options={HQ} value="ORG-HQ" onChange={vi.fn()} placeholder="请选择总部" disabled />,
    )
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByText('品牌总部')).toHaveAttribute('data-fixed-subject', 'ORG-HQ')
  })
})
