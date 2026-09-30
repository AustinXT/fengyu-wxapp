'use client'

import { useId, useState, type ChangeEvent, type ComponentProps, type FocusEvent, type InvalidEvent } from 'react'
import { Input } from '@/components/ui/input'

type Props = ComponentProps<typeof Input>

function errorFor(input: HTMLInputElement): string {
  if (!input.value && !input.validity.badInput) return ''
  if (input.validity.badInput) return '请输入有效数字'
  const value = Number(input.value)
  if (!Number.isFinite(value)) return '请输入有效数字'
  if (input.min && value < Number(input.min)) return `不能小于 ${input.min}`
  if (input.max && value > Number(input.max)) return `不能大于 ${input.max}`
  if (input.step && input.step !== 'any') {
    const quotient = (value - Number(input.min || 0)) / Number(input.step)
    if (!Number.isFinite(quotient) || Math.abs(quotient - Math.round(quotient)) > 1e-7) {
      return `请按 ${input.step} 的步长输入`
    }
  }
  return ''
}

/** 库存数值字段：保留浏览器值域约束，失焦和提交时给出可见中文反馈。 */
export function InventoryNumberInput({ onBlur, onChange, onInvalid, 'aria-describedby': describedBy, ...props }: Props) {
  const [error, setError] = useState('')
  const [touched, setTouched] = useState(false)
  const errorId = useId()

  function handleBlur(event: FocusEvent<HTMLInputElement>) {
    setTouched(true)
    setError(errorFor(event.currentTarget))
    onBlur?.(event)
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    if (touched) setError(errorFor(event.currentTarget))
    onChange?.(event)
  }

  function handleInvalid(event: InvalidEvent<HTMLInputElement>) {
    event.preventDefault()
    setTouched(true)
    setError(errorFor(event.currentTarget) || '请输入有效数字')
    onInvalid?.(event)
  }

  return (
    <span className="block">
      <Input
        {...props}
        type="number"
        onBlur={handleBlur}
        onChange={handleChange}
        onInvalid={handleInvalid}
        aria-invalid={Boolean(error)}
        aria-describedby={[describedBy, error ? errorId : null].filter(Boolean).join(' ') || undefined}
      />
      {error && <span id={errorId} role="alert" className="mt-1 block text-xs text-[var(--destructive)]">{error}</span>}
    </span>
  )
}
