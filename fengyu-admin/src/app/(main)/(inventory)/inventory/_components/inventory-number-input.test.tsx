import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { InventoryNumberInput } from './inventory-number-input'

describe('库存数值输入', () => {
  it('失焦显示中文边界错误，修正后清除，非法值不能通过表单校验', () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    const { container } = render(
      <form onSubmit={onSubmit}>
        <label>数量<InventoryNumberInput min="0.01" max="10" step="0.01" defaultValue="1" /></label>
        <button type="submit">提交</button>
      </form>,
    )
    const input = screen.getByRole('spinbutton') as HTMLInputElement
    fireEvent.change(input, { target: { value: '-1' } })
    fireEvent.blur(input)
    expect(screen.getByRole('alert').textContent).toBe('不能小于 0.01')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    act(() => { expect(container.querySelector('form')?.checkValidity()).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '11' } })
    fireEvent.blur(input)
    expect(screen.getByRole('alert').textContent).toBe('不能大于 10')

    fireEvent.change(input, { target: { value: '1.005' } })
    fireEvent.blur(input)
    expect(screen.getByRole('alert').textContent).toBe('请按 0.01 的步长输入')

    fireEvent.change(input, { target: { value: '0.01' } })
    fireEvent.blur(input)
    expect(input.value).toBe('0.01')
    expect(input.validity.stepMismatch).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(input.getAttribute('aria-invalid')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('大数值的合法两位小数不会被浮点误差误报为步长错误', () => {
    render(<InventoryNumberInput min="0" max="9999999999.99" step="0.01" defaultValue="100000000.01" />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement
    fireEvent.blur(input)
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(input, { target: { value: '9999999999.98' } })
    fireEvent.blur(input)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('草稿回填替换受控值后清除旧错误', () => {
    const { rerender } = render(<InventoryNumberInput min="0" max="10" step="0.01" value="-1" readOnly />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement
    fireEvent.blur(input)
    expect(screen.getByRole('alert')).toHaveTextContent('不能小于')
    rerender(<InventoryNumberInput min="0" max="10" step="0.01" value="1.01" readOnly />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
