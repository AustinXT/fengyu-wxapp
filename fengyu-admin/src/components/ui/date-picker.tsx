"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { CalendarDays, ChevronDown, Clock3, X } from "lucide-react"
import { DayPicker, TZDate, type Matcher } from "@daypicker/react"
import { zhCN } from "@daypicker/react/locale"
import { cn } from "@/lib/utils"

const TIME_ZONE = "Asia/Shanghai"
const DEFAULT_START_YEAR = 1900
const DEFAULT_END_YEAR = 2100
const POPOVER_GAP = 4
const VIEWPORT_PADDING = 8

type NativeDateAttributes = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "defaultValue" | "onChange" | "min" | "max"
>

export interface DatePickerProps extends NativeDateAttributes {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  min?: string
  max?: string
  placeholder?: string
  "aria-label"?: string
}

export interface DateTimePickerProps extends NativeDateAttributes {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  min?: string
  max?: string
  placeholder?: string
  "aria-label"?: string
}

interface DateParts {
  year: number
  month: number
  day: number
}

interface DateTimeParts extends DateParts {
  hour: number
  minute: number
}

interface PopoverPosition {
  top: number
  left: number
  width: number
  placement: "top" | "bottom"
}

function pad2(value: number) {
  return String(value).padStart(2, "0")
}

function isValidDateParts(parts: DateParts) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  return (
    date.getUTCFullYear() === parts.year &&
    date.getUTCMonth() === parts.month - 1 &&
    date.getUTCDate() === parts.day
  )
}

function parseDateValue(value?: string): DateParts | undefined {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return undefined

  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  }
  return isValidDateParts(parts) ? parts : undefined
}

function parseDateTimeValue(value?: string): DateTimeParts | undefined {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/)
  if (!match) return undefined

  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  }
  if (!isValidDateParts(parts) || parts.hour > 23 || parts.minute > 59) return undefined
  return parts
}

function toZonedDate(parts?: DateParts) {
  if (!parts) return undefined
  return new TZDate(parts.year, parts.month - 1, parts.day, 12, 0, TIME_ZONE)
}

function datePartsFromDate(date: Date): DateParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  }
}

function formatDateValue(parts: DateParts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
}

function formatDateTimeValue(parts: DateTimeParts) {
  return `${formatDateValue(parts)}T${pad2(parts.hour)}:${pad2(parts.minute)}`
}

function formatDateDisplay(value?: string) {
  const parts = parseDateValue(value)
  return parts ? `${parts.year}年${parts.month}月${parts.day}日` : ""
}

function formatDateTimeDisplay(value?: string) {
  const parts = parseDateTimeValue(value)
  return parts
    ? `${parts.year}年${parts.month}月${parts.day}日 ${pad2(parts.hour)}:${pad2(parts.minute)}`
    : ""
}

function useControllableValue(
  controlledValue: string | undefined,
  defaultValue: string | undefined,
  onValueChange: ((value: string) => void) | undefined,
) {
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue ?? "")
  const value = controlledValue ?? uncontrolledValue

  const setValue = React.useCallback(
    (nextValue: string) => {
      if (controlledValue === undefined) setUncontrolledValue(nextValue)
      onValueChange?.(nextValue)
    },
    [controlledValue, onValueChange],
  )

  return [value, setValue] as const
}

function useNativeInputEvents(forwardedRef: React.ForwardedRef<HTMLInputElement>) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const setInputRef = React.useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node
      if (typeof forwardedRef === "function") forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    },
    [forwardedRef],
  )

  const dispatchValueChange = React.useCallback((nextValue: string) => {
    const input = inputRef.current
    if (!input || input.value === nextValue) return

    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set
    if (nativeValueSetter) nativeValueSetter.call(input, nextValue)
    else input.value = nextValue

    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.dispatchEvent(new Event("change", { bubbles: true }))
  }, [])

  return { inputRef: setInputRef, dispatchValueChange }
}

function buildDisabledMatchers(min?: string, max?: string): Matcher[] | undefined {
  const minDate = toZonedDate(parseDateValue(min?.slice(0, 10)))
  const maxDate = toZonedDate(parseDateValue(max?.slice(0, 10)))
  const matchers: Matcher[] = []
  if (minDate) matchers.push({ before: minDate })
  if (maxDate) matchers.push({ after: maxDate })
  return matchers.length ? matchers : undefined
}

function getCalendarBounds(min?: string, max?: string) {
  const minParts = parseDateValue(min?.slice(0, 10))
  const maxParts = parseDateValue(max?.slice(0, 10))
  const startYear = minParts?.year ?? DEFAULT_START_YEAR
  const endYear = maxParts?.year ?? DEFAULT_END_YEAR

  return {
    startMonth: new TZDate(startYear, minParts?.month ? minParts.month - 1 : 0, 1, TIME_ZONE),
    endMonth: new TZDate(endYear, maxParts?.month ? maxParts.month - 1 : 11, 1, TIME_ZONE),
  }
}

function dateTimeIsWithinBounds(value: string, min?: string, max?: string) {
  if (min && value < min) return false
  if (max && value > max) return false
  return true
}

function dateIsWithinBounds(value: string, min?: string, max?: string) {
  const minDate = min?.slice(0, 10)
  const maxDate = max?.slice(0, 10)
  if (minDate && value < minDate) return false
  if (maxDate && value > maxDate) return false
  return true
}

function clampDraftTime(parts: DateTimeParts, min?: string, max?: string) {
  let value = formatDateTimeValue(parts)
  if (min && value < min && min.startsWith(`${formatDateValue(parts)}T`)) value = min
  if (max && value > max && max.startsWith(`${formatDateValue(parts)}T`)) value = max
  return parseDateTimeValue(value) ?? parts
}

function useDatePopover(open: boolean) {
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const popoverRef = React.useRef<HTMLDivElement>(null)
  const [position, setPosition] = React.useState<PopoverPosition | null>(null)

  const updatePosition = React.useCallback(() => {
    const trigger = triggerRef.current
    const popover = popoverRef.current
    if (!trigger || !popover) return

    const triggerRect = trigger.getBoundingClientRect()
    const popoverRect = popover.getBoundingClientRect()
    const spaceBelow = window.innerHeight - triggerRect.bottom - VIEWPORT_PADDING
    const spaceAbove = triggerRect.top - VIEWPORT_PADDING
    const placeAbove = popoverRect.height > spaceBelow && spaceAbove > spaceBelow
    const top = placeAbove
      ? Math.max(VIEWPORT_PADDING, triggerRect.top - popoverRect.height - POPOVER_GAP)
      : Math.min(
          window.innerHeight - popoverRect.height - VIEWPORT_PADDING,
          triggerRect.bottom + POPOVER_GAP,
        )
    const preferredLeft = triggerRect.left
    const left = Math.min(
      Math.max(VIEWPORT_PADDING, preferredLeft),
      Math.max(VIEWPORT_PADDING, window.innerWidth - popoverRect.width - VIEWPORT_PADDING),
    )

    setPosition({ top, left, width: triggerRect.width, placement: placeAbove ? "top" : "bottom" })
  }, [])

  React.useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    updatePosition()
    const frame = requestAnimationFrame(updatePosition)
    window.addEventListener("resize", updatePosition)
    window.addEventListener("scroll", updatePosition, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("resize", updatePosition)
      window.removeEventListener("scroll", updatePosition, true)
    }
  }, [open, updatePosition])

  return { triggerRef, popoverRef, position, updatePosition }
}

interface TriggerProps {
  value: string
  displayValue: string
  placeholder: string
  open: boolean
  disabled?: boolean
  required?: boolean
  ariaLabel: string
  mode: "date" | "datetime"
  onToggle: () => void
  onClear: () => void
  triggerRef: React.RefObject<HTMLButtonElement | null>
}

function PickerTrigger({
  value,
  displayValue,
  placeholder,
  open,
  disabled,
  required,
  ariaLabel,
  mode,
  onToggle,
  onClear,
  triggerRef,
}: TriggerProps) {
  const Icon = mode === "datetime" ? Clock3 : CalendarDays

  return (
    <button
      ref={triggerRef}
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-required={required || undefined}
      onClick={onToggle}
      className={cn(
        "flex h-10 w-full items-center rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-left text-sm",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <Icon className="mr-2 size-4 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
      <span className={cn("min-w-0 flex-1 truncate", !displayValue && "text-[var(--muted-foreground)]")}>
        {displayValue || placeholder}
      </span>
      {value && !disabled && (
        <span
          role="button"
          tabIndex={-1}
          aria-label="清空日期"
          className="ml-2 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
          onClick={(event) => {
            event.stopPropagation()
            onClear()
          }}
        >
          <X className="size-3.5" aria-hidden="true" />
        </span>
      )}
      <ChevronDown
        className={cn("ml-1 size-4 shrink-0 text-[var(--muted-foreground)] transition-transform", open && "rotate-180")}
        aria-hidden="true"
      />
    </button>
  )
}

interface CalendarPanelProps {
  selected?: Date
  min?: string
  max?: string
  onSelect: (date: Date) => void
}

function CalendarPanel({ selected, min, max, onSelect }: CalendarPanelProps) {
  const bounds = React.useMemo(() => getCalendarBounds(min, max), [min, max])
  const disabled = React.useMemo(() => buildDisabledMatchers(min, max), [min, max])
  const initialMonth = selected ?? new TZDate(Date.now(), TIME_ZONE)

  return (
    <DayPicker
      mode="single"
      selected={selected}
      defaultMonth={initialMonth}
      onSelect={(date) => date && onSelect(date)}
      locale={zhCN}
      lang="zh-CN"
      timeZone={TIME_ZONE}
      noonSafe
      captionLayout="dropdown"
      navLayout="around"
      reverseYears
      showOutsideDays
      fixedWeeks
      disabled={disabled}
      startMonth={bounds.startMonth}
      endMonth={bounds.endMonth}
      formatters={{
        formatMonthDropdown: (date) => `${date.getMonth() + 1}月`,
        formatYearDropdown: (date) => `${date.getFullYear()}年`,
        formatWeekdayName: (date) => `周${"日一二三四五六"[date.getDay()]}`,
      }}
      labels={{
        labelNext: () => "下个月",
        labelPrevious: () => "上个月",
        labelMonthDropdown: () => "选择月份",
        labelYearDropdown: () => "选择年份",
      }}
    />
  )
}

interface PopoverShellProps {
  open: boolean
  ariaLabel: string
  triggerRef: React.RefObject<HTMLButtonElement | null>
  popoverRef: React.RefObject<HTMLDivElement | null>
  position: PopoverPosition | null
  onClose: () => void
  children: React.ReactNode
}

function PopoverShell({
  open,
  ariaLabel,
  triggerRef,
  popoverRef,
  position,
  onClose,
  children,
}: PopoverShellProps) {
  React.useEffect(() => {
    if (!open) return
    function handleMouseDown(event: MouseEvent) {
      const target = event.target as Node
      if (!popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) onClose()
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose()
        triggerRef.current?.focus()
      }
    }
    document.addEventListener("mousedown", handleMouseDown)
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("mousedown", handleMouseDown)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [open, onClose, popoverRef, triggerRef])

  if (!open || typeof document === "undefined") return null

  // A native modal <dialog> lives in the browser's top layer. Portaling to
  // document.body from inside one leaves the calendar underneath the dialog
  // and its backdrop regardless of z-index, so keep the popover in the same
  // top-layer subtree when a picker is used inside a dialog.
  const portalContainer = triggerRef.current?.closest("dialog[open]") ?? document.body

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={ariaLabel}
      lang="zh-CN"
      data-placement={position?.placement ?? "bottom"}
      className={cn(
        "fy-date-picker-popover fixed z-[100] min-w-[19rem] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--popover)] p-3 text-[var(--popover-foreground)] shadow-lg",
        !position && "pointer-events-none invisible",
      )}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        minWidth: Math.max(position?.width ?? 0, 304),
      }}
    >
      {children}
    </div>,
    portalContainer,
  )
}

export const DatePicker = React.forwardRef<HTMLInputElement, DatePickerProps>(
  (
    {
      value: controlledValue,
      defaultValue,
      onValueChange,
      name,
      min,
      max,
      placeholder = "请选择日期",
      disabled,
      required,
      className,
      id,
      "aria-label": ariaLabel = "选择日期",
      ...hiddenInputProps
    },
    ref,
  ) => {
    const [value, setValue] = useControllableValue(controlledValue, defaultValue, onValueChange)
    const { inputRef, dispatchValueChange } = useNativeInputEvents(ref)
    const [open, setOpen] = React.useState(false)
    const { triggerRef, popoverRef, position } = useDatePopover(open)
    const selected = toZonedDate(parseDateValue(value))
    const today = new TZDate(Date.now(), TIME_ZONE)
    const todayValue = formatDateValue(datePartsFromDate(today))
    const todayIsAllowed = dateIsWithinBounds(todayValue, min, max)

    const close = React.useCallback(() => setOpen(false), [])
    const commitValue = React.useCallback(
      (nextValue: string) => {
        setValue(nextValue)
        dispatchValueChange(nextValue)
      },
      [dispatchValueChange, setValue],
    )
    const selectDate = React.useCallback(
      (date: Date) => {
        const nextValue = formatDateValue(datePartsFromDate(date))
        if (!dateIsWithinBounds(nextValue, min, max)) return
        commitValue(nextValue)
        setOpen(false)
      },
      [commitValue, max, min],
    )

    return (
      <div className={cn("relative w-full", className)}>
        <PickerTrigger
          value={value}
          displayValue={formatDateDisplay(value)}
          placeholder={placeholder}
          open={open}
          disabled={disabled}
          required={required}
          ariaLabel={ariaLabel}
          mode="date"
          onToggle={() => setOpen((current) => !current)}
          onClear={() => {
            commitValue("")
            setOpen(false)
          }}
          triggerRef={triggerRef}
        />
        <input
          {...hiddenInputProps}
          ref={inputRef}
          id={id}
          name={name}
          type="hidden"
          value={value}
          disabled={disabled}
          data-date-picker-value="date"
        />
        <PopoverShell
          open={open}
          ariaLabel="选择日期"
          triggerRef={triggerRef}
          popoverRef={popoverRef}
          position={position}
          onClose={close}
        >
          <CalendarPanel selected={selected} min={min} max={max} onSelect={selectDate} />
          <div className="mt-2 flex items-center justify-between border-t border-[var(--border)] pt-2">
            <button
              type="button"
              disabled={!todayIsAllowed}
              className="rounded px-2 py-1 text-sm text-[var(--primary)] hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => selectDate(today)}
            >
              今天
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 text-sm text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
              onClick={() => {
                commitValue("")
                setOpen(false)
              }}
            >
              清空
            </button>
          </div>
        </PopoverShell>
      </div>
    )
  },
)
DatePicker.displayName = "DatePicker"

function currentBeijingDateTime(): DateTimeParts {
  const now = new TZDate(Date.now(), TIME_ZONE)
  return {
    ...datePartsFromDate(now),
    hour: now.getHours(),
    minute: now.getMinutes(),
  }
}

export const DateTimePicker = React.forwardRef<HTMLInputElement, DateTimePickerProps>(
  (
    {
      value: controlledValue,
      defaultValue,
      onValueChange,
      name,
      min,
      max,
      placeholder = "请选择日期和时间",
      disabled,
      required,
      className,
      id,
      "aria-label": ariaLabel = "选择日期和时间",
      ...hiddenInputProps
    },
    ref,
  ) => {
    const [value, setValue] = useControllableValue(controlledValue, defaultValue, onValueChange)
    const { inputRef, dispatchValueChange } = useNativeInputEvents(ref)
    const [open, setOpen] = React.useState(false)
    const initialParts = parseDateTimeValue(value) ?? currentBeijingDateTime()
    const [draft, setDraft] = React.useState<DateTimeParts>(initialParts)
    const { triggerRef, popoverRef, position } = useDatePopover(open)
    const selected = toZonedDate(draft)

    const close = React.useCallback(() => setOpen(false), [])
    const commitValue = React.useCallback(
      (nextValue: string) => {
        setValue(nextValue)
        dispatchValueChange(nextValue)
      },
      [dispatchValueChange, setValue],
    )
    const openPicker = React.useCallback(() => {
      setDraft(parseDateTimeValue(value) ?? currentBeijingDateTime())
      setOpen(true)
    }, [value])

    const setDraftDate = React.useCallback(
      (date: Date) => {
        setDraft((current) => clampDraftTime({ ...current, ...datePartsFromDate(date) }, min, max))
      },
      [max, min],
    )

    const confirm = React.useCallback(() => {
      const nextValue = formatDateTimeValue(draft)
      if (!dateTimeIsWithinBounds(nextValue, min, max)) return
      commitValue(nextValue)
      setOpen(false)
    }, [commitValue, draft, max, min])

    const draftValue = formatDateTimeValue(draft)
    const draftIsValid = dateTimeIsWithinBounds(draftValue, min, max)

    return (
      <div className={cn("relative w-full", className)}>
        <PickerTrigger
          value={value}
          displayValue={formatDateTimeDisplay(value)}
          placeholder={placeholder}
          open={open}
          disabled={disabled}
          required={required}
          ariaLabel={ariaLabel}
          mode="datetime"
          onToggle={() => (open ? close() : openPicker())}
          onClear={() => {
            commitValue("")
            setOpen(false)
          }}
          triggerRef={triggerRef}
        />
        <input
          {...hiddenInputProps}
          ref={inputRef}
          id={id}
          name={name}
          type="hidden"
          value={value}
          disabled={disabled}
          data-date-picker-value="datetime"
        />
        <PopoverShell
          open={open}
          ariaLabel="选择日期和时间"
          triggerRef={triggerRef}
          popoverRef={popoverRef}
          position={position}
          onClose={close}
        >
          <CalendarPanel selected={selected} min={min} max={max} onSelect={setDraftDate} />
          <div className="mt-2 flex items-center gap-2 border-t border-[var(--border)] pt-3">
            <Clock3 className="size-4 text-[var(--muted-foreground)]" aria-hidden="true" />
            <label className="text-sm" htmlFor={`${id ?? name ?? "datetime"}-hour`}>
              时
            </label>
            <select
              id={`${id ?? name ?? "datetime"}-hour`}
              aria-label="小时"
              value={pad2(draft.hour)}
              onChange={(event) =>
                setDraft((current) => clampDraftTime({ ...current, hour: Number(event.target.value) }, min, max))
              }
              className="h-9 rounded-[var(--radius)] border border-[var(--input)] bg-[var(--background)] px-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={pad2(hour)}>
                  {pad2(hour)}
                </option>
              ))}
            </select>
            <span aria-hidden="true">:</span>
            <label className="text-sm" htmlFor={`${id ?? name ?? "datetime"}-minute`}>
              分
            </label>
            <select
              id={`${id ?? name ?? "datetime"}-minute`}
              aria-label="分钟"
              value={pad2(draft.minute)}
              onChange={(event) =>
                setDraft((current) => clampDraftTime({ ...current, minute: Number(event.target.value) }, min, max))
              }
              className="h-9 rounded-[var(--radius)] border border-[var(--input)] bg-[var(--background)] px-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
            >
              {Array.from({ length: 60 }, (_, minute) => (
                <option key={minute} value={pad2(minute)}>
                  {pad2(minute)}
                </option>
              ))}
            </select>
          </div>
          {!draftIsValid && (
            <p className="mt-2 text-xs text-[var(--destructive)]" role="alert">
              请选择允许范围内的日期和时间
            </p>
          )}
          <div className="mt-3 flex items-center justify-between border-t border-[var(--border)] pt-2">
            <button
              type="button"
              className="rounded px-2 py-1 text-sm text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
              onClick={() => {
                commitValue("")
                setOpen(false)
              }}
            >
              清空
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded px-3 py-1.5 text-sm text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                onClick={close}
              >
                取消
              </button>
              <button
                type="button"
                disabled={!draftIsValid}
                className="rounded bg-[var(--primary)] px-3 py-1.5 text-sm text-[var(--primary-foreground)] hover:bg-[var(--primary)]/90 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={confirm}
              >
                确定
              </button>
            </div>
          </div>
        </PopoverShell>
      </div>
    )
  },
)
DateTimePicker.displayName = "DateTimePicker"
