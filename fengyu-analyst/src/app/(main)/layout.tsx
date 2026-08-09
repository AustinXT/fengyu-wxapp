import { redirect } from "next/navigation"
import { AnalystShell } from "@/components/layout/analyst-shell"
import { getSession } from "@/lib/auth"
import { hasPermission } from "@/lib/permissions"

const VIEW_ACTION = process.env.ANALYST_VIEW_ACTION || "data_center:dashboard"

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()

  if (!session) {
    const loginUrl = new URL(process.env.ADMIN_LOGIN_URL || "http://localhost:3000/login")
    loginUrl.searchParams.set("returnTo", process.env.NEXT_PUBLIC_ANALYST_ORIGIN || "http://localhost:3100")
    redirect(loginUrl.toString())
  }

  if (!hasPermission(session, VIEW_ACTION)) {
    redirect("/forbidden")
  }

  return <AnalystShell session={session}>{children}</AnalystShell>
}
