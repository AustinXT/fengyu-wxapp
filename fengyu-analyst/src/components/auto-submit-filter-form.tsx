"use client"

import { useCallback, useRef, useTransition, type ChangeEvent, type ComponentPropsWithoutRef, type SubmitEvent } from "react"
import { usePathname, useRouter } from "next/navigation"
import { buildFormNavigationHref } from "@/lib/form-navigation"

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
  onSubmit,
  action,
  ...props
}: ComponentPropsWithoutRef<"form">) {
  const formRef = useRef<HTMLFormElement>(null)
  const router = useRouter()
  const pathname = usePathname()
  const [pending, startTransition] = useTransition()

  const handleSubmit = useCallback((event: SubmitEvent<HTMLFormElement>) => {
    onSubmit?.(event)
    if (event.defaultPrevented || method.toLowerCase() !== "get") return
    event.preventDefault()
    const form = event.currentTarget
    const targetPath = typeof action === "string" ? action : pathname
    const href = buildFormNavigationHref(targetPath, new FormData(form).entries())
    startTransition(() => router.replace(href))
  }, [action, method, onSubmit, pathname, router])

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
    <form {...props} ref={formRef} action={action} method={method} onChange={handleChange} onSubmit={handleSubmit} aria-busy={pending} className={`${props.className ?? ""} ${pending ? "pointer-events-none opacity-60" : ""}`}>
      {children}
    </form>
  )
}
