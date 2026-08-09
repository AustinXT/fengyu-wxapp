"use client"

import { useCallback, useRef, type ChangeEvent, type ComponentPropsWithoutRef } from "react"

type ResettableControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

function isResettableControl(element: Element): element is ResettableControl {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  )
}

function resetNamedControls(form: HTMLFormElement, names: string[]) {
  const controls = Array.from(form.elements).filter(isResettableControl)

  for (const name of names) {
    for (const control of controls) {
      if (control.name === name) control.value = ""
    }
  }
}

export function AutoSubmitFilterForm({
  children,
  method = "get",
  onChange,
  ...props
}: ComponentPropsWithoutRef<"form">) {
  const formRef = useRef<HTMLFormElement>(null)

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLFormElement>) => {
      onChange?.(event)
      if (event.defaultPrevented) return

      const form = formRef.current
      const target = event.target
      if (!form || !isResettableControl(target)) return

      const resetFields = target.dataset.resetFields
        ?.split(",")
        .map((field) => field.trim())
        .filter(Boolean)

      if (resetFields?.length) resetNamedControls(form, resetFields)

      form.requestSubmit()
    },
    [onChange],
  )

  return (
    <form {...props} ref={formRef} method={method} onChange={handleChange}>
      {children}
    </form>
  )
}
