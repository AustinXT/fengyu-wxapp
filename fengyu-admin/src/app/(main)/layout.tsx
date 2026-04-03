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

  return <MainShell session={session}>{children}</MainShell>
}
