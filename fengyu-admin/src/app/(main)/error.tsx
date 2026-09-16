"use client"

import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { actionErrorMessage, actionErrorType } from "@/lib/action-error"

/**
 * Next 自动生成的错误编号形态：`stringHash(message+stack).toString()`（无符号 32 位十进制），
 * 15.5 起对带 `__NEXT_ERROR_CODE` 的错误会追加 `@E<码>`（lib/error-telemetry-utils.js）。
 * 只有这种形态才是「给客服定位用的编号」，其余 digest 是业务/技术文案，不得原样渲染。
 */
const NEXT_AUTO_DIGEST_RE = /^\d{1,10}(?:@[A-Za-z][\w-]*)?$/

/** 「没有可展示的业务理由」的哨兵。不可能与真实文案相等，故用它代替空串做判定。 */
const NO_BUSINESS_REASON = "__no_business_reason__"

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[ErrorBoundary]", error)
  }, [error])

  // 判类型统一走 actionErrorType（digest 优先、message 兜底）：生产构建会脱敏
  // Server Component 抛出的 error.message，但保留开发者自设的 error.digest
  // （见 lib/permissions.ts 的 PermissionError）。此前这里是同一套约定的第二份硬编码，
  // 与 lib/action-error.ts 的 OPAQUE_TOKEN_MESSAGES 各改各的会漂移（issue #133）。
  const errorType = actionErrorType(error)
  // 权限不足 → 403
  const isPermissionDenied = errorType === "PERMISSION_DENIED"
  // 未登录 → 401（通常被 middleware 拦截，此处为兜底）
  const isUnauthorized = errorType === "UNAUTHORIZED"

  if (isUnauthorized) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center space-y-4">
            <div className="text-5xl text-[#999999]">401</div>
            <h2 className="text-xl font-semibold text-[var(--foreground)]">登录已过期</h2>
            <p className="text-sm text-[#666666]">请重新登录以继续操作</p>
            <Button onClick={() => window.location.href = "/login"} className="mt-4">
              前往登录
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (isPermissionDenied) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center space-y-4">
            <div className="text-5xl text-[#D94040]">403</div>
            <h2 className="text-xl font-semibold text-[var(--foreground)]">无权访问此页面</h2>
            <p className="text-sm text-[#666666]">您的账号没有该功能的访问权限，请联系管理员</p>
            <Button variant="outline" onClick={() => window.location.href = "/dashboard"} className="mt-4">
              返回工作台
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // 通用 500。业务拦截理由（若有）优先于通用话术展示，让守护的理由能传达到人（issue #133）。
  // 用独占哨兵而非空串问「有没有可展示的业务理由」：`actionErrorMessage` 会把空白 fallback
  // 兜成「操作失败」（免得弹空白 toast），所以空串当哨兵会恒为真、把通用文案顶掉。
  const reason = actionErrorMessage(error, NO_BUSINESS_REASON)
  const hasReason = reason !== NO_BUSINESS_REASON
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-md">
        <CardContent className="p-8 text-center space-y-4">
          <div className="text-5xl text-[#D94040]">500</div>
          <h2 className="text-xl font-semibold text-[var(--foreground)]">服务异常</h2>
          <p className="text-sm text-[#666666]">
            {hasReason ? reason : "抱歉，页面加载出现问题，请稍后重试"}
          </p>
          {/* 只展示 Next 自动生成的错误编号（供客服定位）。digest 也可能是完整业务 / 技术文案
              （如 `INVALID_STATE: CLIENT_SECRET is not configured`），原样渲染会绕过
              actionErrorMessage 的全部闸门把技术细节泄漏出去（评审 round 1 指出）。 */}
          {error.digest && NEXT_AUTO_DIGEST_RE.test(error.digest) && (
            <p className="text-xs text-[#999999]">错误编号: {error.digest}</p>
          )}
          <div className="flex justify-center gap-3 mt-4">
            <Button variant="outline" onClick={() => window.location.href = "/dashboard"}>
              返回工作台
            </Button>
            <Button onClick={reset}>
              刷新重试
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
