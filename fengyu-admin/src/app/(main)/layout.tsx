import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { checkMustChange } from "@/actions/auth"
import { MainShell } from "@/components/layout/main-shell"

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()

  if (!session) {
    redirect("/login?expired=1")
  }

  // 首次登录强制改密
  const mustChange = await checkMustChange()
  if (mustChange) {
    redirect("/change-password")
  }

  return <MainShell session={session}>
    {process.env.DAILY_ISOLATED === "1" && <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">日报独立测试环境 · 数据库 fengyu_daily_dev · 不连接共用 dev 库</div>}
    {children}
  </MainShell>
}
