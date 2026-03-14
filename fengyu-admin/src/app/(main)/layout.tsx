import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { MainShell } from "@/components/layout/main-shell"

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()

  if (!session) {
    redirect("/login")
  }

  return <MainShell session={session}>{children}</MainShell>
}
