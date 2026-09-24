import { notFound } from "next/navigation"
import { listOnboardingApplications } from "@/actions/lakala-onboarding"
import { getSession } from "@/lib/auth"
import { hasPermission } from "@/lib/permissions"
import { OnboardingList } from "./_components/onboarding-page"

export const dynamic = "force-dynamic"

export default async function OnboardingPage() {
  const session = await getSession()
  if (!session || !hasPermission(session, "merchant:list")) notFound()

  const applications = await listOnboardingApplications()
  return (
    <OnboardingList
      applications={applications}
      canCreate={hasPermission(session, "merchant:create")}
    />
  )
}
