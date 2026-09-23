"use client"

import { useEffect } from "react"
import { AnalystErrorState } from "@/components/analyst-error-state"

/**
 * 段级错误边界：兜住三个看板（新客漏斗 / 复购率 / 普及率）的数据加载失败。
 *
 * 它们都是 async server component，直接 `await getXxxDashboard(...)`；
 * 在此之前全仓**没有任何 error 边界**，一抛错就落 Next 内建的
 * 「Application error」——无上下文、无重试、也不说发生了什么（#316）。
 *
 * ## 为什么是段级而不是只放一个全局的
 *
 * 放在 `(main)/` 下，`AnalystShell` 仍然渲染，用户能直接切到别的看板，不是整站卡死。
 * 代价是它**捕获不到 `(main)/layout.tsx` 自身**的错误——那由 `app/error.tsx` 兜，
 * 两者缺一不可，理由见那个文件的注释。
 */
export default function MainError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // 这是 client 侧日志，服务端那条由 Next 自己打（含完整 stack，digest 对得上）。
    // 检索标记与 `metric-delta.ts` 的 `[metric-delta]` 同属一类：命中即代表有 bug 要查。
    console.error("[analyst-error]", error)
  }, [error])

  return <AnalystErrorState digest={error.digest} reset={reset} layout="section" />
}
