"use client"

import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import type { ComponentProps } from "react"
import { useCallback, useMemo } from "react"
import { buildCurrentPath, resolveReturnTo, withReturnTo } from "@/lib/return-context"

type ContextLinkProps = Omit<ComponentProps<typeof Link>, "href"> & { href: string }

export function PreserveListContextLink({ href, ...props }: ContextLinkProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const target = withReturnTo(href, buildCurrentPath(pathname, searchParams))
  return <Link href={target} {...props} />
}

export function useReturnContext(fallback: string) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const rawReturnTo = searchParams.get("returnTo")
  const returnHref = useMemo(
    () => resolveReturnTo(rawReturnTo, fallback),
    [fallback, rawReturnTo],
  )
  const forwardHref = useCallback(
    (href: string) => withReturnTo(href, returnHref),
    [returnHref],
  )
  const goToReturn = useCallback(
    (replace = false) => {
      if (replace) router.replace(returnHref)
      else router.push(returnHref)
    },
    [returnHref, router],
  )

  return { returnHref, forwardHref, goToReturn }
}

export function ReturnContextLink({ href: fallback, ...props }: ContextLinkProps) {
  const { returnHref } = useReturnContext(fallback)
  return <Link href={returnHref} {...props} />
}
