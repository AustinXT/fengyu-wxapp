import { notFound } from "next/navigation"
import { getOnboardingApplication } from "@/actions/lakala-onboarding"
import { getSession } from "@/lib/auth"
import { hasPermission } from "@/lib/permissions"
import { OnboardingEditor } from "../_components/onboarding-page"

export const dynamic = "force-dynamic"

export default async function OnboardingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await getSession()
  if (!session || !hasPermission(session, "merchant:list")) notFound()

  const application = await getOnboardingApplication(id)
  if (!application) notFound()

  const canEdit = hasPermission(session, "merchant:update")
  return (
    <OnboardingEditor
      application={application}
      canEdit={canEdit}
      canFinalizeMerchant={canEdit}
    />
  )
}
