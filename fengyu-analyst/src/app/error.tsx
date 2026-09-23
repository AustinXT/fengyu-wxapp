"use client"

import { useEffect } from "react"
import { AnalystErrorState } from "@/components/analyst-error-state"

/**
 * 根段错误边界：兜住 `(main)/layout.tsx` **自身**抛出的错误。
 *
 * ## 为什么光有 `(main)/error.tsx` 不够
 *
 * Next App Router 的规则是「`error.tsx` 捕获同级 layout **之下**的错误，但不捕获同级 layout 自身」。
 * 而 `(main)/layout.tsx` 第一件事就是 `await getSession()`，那个函数会**查两次库**
 * （`staff_wechat_users` + `permission_roles`，见 `lib/auth.ts`）。
 *
 * 所以 DB 一挂，`(main)/layout.tsx` 先抛，`(main)/error.tsx` 根本没机会渲染——
 * #316 验收标准里「把连接串改错重启 dev，三个看板都应落到新错误页」这条，
 * **只加段级边界是过不了的**。这一层就是为它补的。
 *
 * ## 为什么不再补 `global-error.tsx`
 *
 * 那一层只兜 root layout（`app/layout.tsx`）自身。而它是纯静态的：无 `async`、无数据访问，
 * 只渲染 `<html><body>` 与 `<Toaster />`。抛错概率极低，而代价是要自带 `<html><body>`
 * 并完全脱离站点样式。#316 原文也写的是「视情况再补」——据此不补。
 * 将来 root layout 真要加数据依赖（如全局配置、主题），再补也不迟。
 *
 * ## ⚠️ 这一层会不会把 `redirect()` 一起吞掉
 *
 * `(main)/layout.tsx` 未登录时 `redirect(登录页)`、无权限时 `redirect("/forbidden")`，
 * 而 `redirect()` 的实现就是**抛一个特殊错误**。若被本边界当普通错误接住，
 * 未登录用户会看到「数据加载失败」而不是跳转登录——那是比原问题更糟的回归。
 *
 * Next 在框架层用 `isRedirectError` 把 `NEXT_REDIRECT` 与 `NEXT_NOT_FOUND` 摘出去，
 * 不交给 error boundary。**这条已实测确认**（见 PR 的实效验证记录），不是推断；
 * 升级 Next 大版本后建议重验一次。
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[analyst-error][root]", error)
  }, [error])

  return <AnalystErrorState digest={error.digest} reset={reset} layout="page" />
}
