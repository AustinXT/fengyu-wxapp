import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-md">
        <CardContent className="p-8 text-center space-y-4">
          <div className="text-5xl text-[#999999]">404</div>
          <h2 className="text-xl font-semibold text-[var(--foreground)]">页面不存在</h2>
          <p className="text-sm text-[#666666]">您访问的页面不存在或已被移除</p>
          <Link href="/dashboard">
            <Button variant="outline" className="mt-4">
              返回工作台
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
