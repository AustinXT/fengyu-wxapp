import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Input } from './input'

describe('Input · 数字输入的滚轮防护（#135）', () => {
  it('type=number 聚焦后滚轮会失焦，避免静默改值', () => {
    // 浏览器对聚焦中的 input[type=number] 会按 step 增减数值。库存的办理台与
    // 各弹窗都是需要滚动的长表单，用户点进「数量 / 单价」之后滚页面就会静默改掉
    // 金额，且 positiveNumber() 之类的业务校验照样放行 —— 错值直接进台账。
    render(<Input type="number" aria-label="数量" defaultValue="10" />)
    const input = screen.getByLabelText('数量')
    input.focus()
    expect(document.activeElement).toBe(input)

    fireEvent.wheel(input)
    expect(document.activeElement).not.toBe(input)
  })

  it('type=text 不受影响（滚轮不会让它失焦）', () => {
    render(<Input aria-label="备注" defaultValue="abc" />)
    const input = screen.getByLabelText('备注')
    input.focus()

    fireEvent.wheel(input)
    expect(document.activeElement).toBe(input)
  })

  it('调用方自己传的 onWheel 仍会被执行', () => {
    const onWheel = vi.fn()
    render(<Input type="number" aria-label="数量" onWheel={onWheel} />)
    fireEvent.wheel(screen.getByLabelText('数量'))
    expect(onWheel).toHaveBeenCalledTimes(1)
  })
})
