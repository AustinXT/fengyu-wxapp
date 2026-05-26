"use client"

import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

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

  // digest 优先、message 兜底：
  // 生产构建会脱敏 Server Component 抛出的 error.message（只剩通用文案），
  // 但保留开发者自设的 error.digest（见 lib/permissions.ts PermissionError）。
  // 故 dev 走 message、prod 走 digest，两端都能正确区分 403/401。
  // 权限不足 → 403
  const isPermissionDenied =
    error.digest === "PERMISSION_DENIED" || !!error.message?.includes("PERMISSION_DENIED")
  // 未登录 → 401（通常被 middleware 拦截，此处为兜底）
  const isUnauthorized =
    error.digest === "UNAUTHORIZED" || !!error.message?.includes("UNAUTHORIZED")

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

  // 通用 500
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-md">
        <CardContent className="p-8 text-center space-y-4">
          <div className="text-5xl text-[#D94040]">500</div>
          <h2 className="text-xl font-semibold text-[var(--foreground)]">服务异常</h2>
          <p className="text-sm text-[#666666]">抱歉，页面加载出现问题，请稍后重试</p>
          {error.digest && (
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
