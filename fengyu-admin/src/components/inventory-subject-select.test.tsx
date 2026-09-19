import { StrictMode } from 'react'
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
    const { rerender } = render(
      <InventorySubjectSelect options={HQ} value="" onChange={onChange} placeholder="请选择总部" />,
    )

    expect(onChange).toHaveBeenCalledExactlyOnceWith('ORG-HQ')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    // 上报落定前不挂 data-fixed-subject：它是「值已进表单 state」的证据，早挂会让
    // 依赖它的 E2E 在上报逻辑被删掉时照样全绿。
    expect(screen.getByText('品牌总部')).not.toHaveAttribute('data-fixed-subject')

    rerender(<InventorySubjectSelect options={HQ} value="ORG-HQ" onChange={onChange} placeholder="请选择总部" />)
    expect(screen.getByText('品牌总部')).toHaveAttribute('data-fixed-subject', 'ORG-HQ')
  })

  it('StrictMode 重放 effect 时也只上报一次', () => {
    // Next 15 默认开启 StrictMode，dev 下每个 effect 会被重放一遍，两次都闭包捕获
    // 同一个 value=""。光靠 `!value` 守卫拦不住第二次 —— 员工购那类带异步副作用的
    // onChange 会因此多打一发请求。
    const onChange = vi.fn()
    render(
      <StrictMode>
        <InventorySubjectSelect options={HQ} value="" onChange={onChange} placeholder="请选择总部" />
      </StrictMode>,
    )

    expect(onChange).toHaveBeenCalledExactlyOnceWith('ORG-HQ')
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

  it('onChange 换引用不会重复上报（值仍为空，只有依赖数组能决定是否重跑）', () => {
    // 调用方传的都是内联箭头函数，每次渲染都是新引用；若把它放进 effect 依赖，
    // 父组件每重渲染一次就会重报一次，配合带副作用的 onChange（异步拉员工）会刷请求。
    // ⚠️ rerender 必须保持 value=""，否则 `!value` 守卫会替依赖数组挡住重复上报，
    // 这条测试就退化成「什么都没钉住」。
    const onChange = vi.fn()
    const { rerender } = render(
      <InventorySubjectSelect options={HQ} value="" onChange={() => onChange('first')} placeholder="请选择总部" />,
    )
    expect(onChange).toHaveBeenCalledTimes(1)

    rerender(
      <InventorySubjectSelect options={HQ} value="" onChange={() => onChange('second')} placeholder="请选择总部" />,
    )
    rerender(
      <InventorySubjectSelect options={HQ} value="" onChange={() => onChange('third')} placeholder="请选择总部" />,
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

  it('候选唯一但值是候选之外的（随单回填了看不到的主体）时不覆盖，且给出可见占位', () => {
    // 采购订单 / 发货 / 入库 / 配货共 5 处会在选定来源单据后把主体回填成单据自己的
    // 主体。若那个主体不在当前用户的候选里，只读文本显示唯一候选就是撒谎，自动改值
    // 更是把随单锁定的主体悄悄换掉；而不给 option 的话 select 会 selectedIndex=-1
    // 渲染成空白框，操作人根本看不出发生了什么。
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
    expect(screen.getByRole('combobox')).toHaveValue('ORG-OTHER-HQ')
    expect(screen.getByRole('option', { name: '当前主体（不在可选范围）' })).toBeInTheDocument()
  })

  it('无候选时是禁用的空态下拉，不上报任何值', () => {
    // 市场角色开「市场退货申请」时 headquarters 为空：给一个能点开却没有任何选项的
    // 必填下拉，用户分不清是没权限还是没加载出来。
    const onChange = vi.fn()
    render(
      <InventorySubjectSelect options={[]} value="" onChange={onChange} placeholder="请选择总部" />,
    )

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByRole('option', { name: '暂无可用主体' })).toBeInTheDocument()
  })

  describe('autoSelect=false（值由同表单上游字段联动派生）', () => {
    it('上游未选时不自动补值，也不显示只读文本', () => {
      // 「回库主体」的候选在未选退货主体前退化成 headquarters —— 自动选中会把唯一总部
      // 固定成只读，而门店退货只能退回父市场，那就是个撒谎的值；它还会盖掉
      // selectSource 在同一次 effect flush 里刚写进去的父市场（后写胜出）。
      const onChange = vi.fn()
      render(
        <InventorySubjectSelect
          options={HQ}
          value=""
          onChange={onChange}
          placeholder="请选择回库主体"
          autoSelect={false}
        />,
      )

      expect(onChange).not.toHaveBeenCalled()
      expect(screen.getByRole('combobox')).toBeInTheDocument()
      expect(screen.queryByText('品牌总部')).not.toHaveAttribute('data-fixed-subject')
    })

    it('上游联动填好值后，候选唯一仍降级为只读', () => {
      render(
        <InventorySubjectSelect
          options={HQ}
          value="ORG-HQ"
          onChange={vi.fn()}
          placeholder="请选择回库主体"
          autoSelect={false}
        />,
      )

      expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
      expect(screen.getByText('品牌总部')).toHaveAttribute('data-fixed-subject', 'ORG-HQ')
    })
  })

  describe('disabled（主体随单锁定）', () => {
    it('禁用时不自动补值，也不把空值伪装成已确定的只读值', () => {
      // 供应链采购入库选中一张 target_org_node_id 为 null 的单据时，表单会把主体清成
      // 空串（schema 里该列可空）。此时字段已 disabled 表示「随单锁定」，组件若还自动
      // 填一个唯一候选并渲染成只读，用户看到的是个「不可改的确定值」，而它并非来自单据。
      const onChange = vi.fn()
      render(
        <InventorySubjectSelect options={HQ} value="" onChange={onChange} placeholder="请选择总部" disabled />,
      )

      expect(onChange).not.toHaveBeenCalled()
      expect(screen.getByRole('combobox')).toBeDisabled()
    })

    it('随单回填的值与唯一候选一致时仍只读展示', () => {
      render(
        <InventorySubjectSelect options={HQ} value="ORG-HQ" onChange={vi.fn()} placeholder="请选择总部" disabled />,
      )

      expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
      expect(screen.getByText('品牌总部')).toHaveAttribute('data-fixed-subject', 'ORG-HQ')
    })

    it('候选多个时 disabled 照常作用于下拉', () => {
      render(
        <InventorySubjectSelect options={MARKETS} value="M1" onChange={vi.fn()} placeholder="请选择市场" disabled />,
      )
      expect(screen.getByRole('combobox')).toBeDisabled()
    })
  })
})
