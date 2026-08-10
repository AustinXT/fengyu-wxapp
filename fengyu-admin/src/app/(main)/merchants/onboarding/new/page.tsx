import { notFound } from "next/navigation"
import { getOnboardingStoreOptions } from "@/actions/lakala-onboarding"
import { getSession } from "@/lib/auth"
import { hasPermission } from "@/lib/permissions"
import { NewOnboardingApplication } from "../_components/onboarding-page"

export const dynamic = "force-dynamic"

export default async function NewOnboardingPage() {
  const session = await getSession()
  if (!session || !hasPermission(session, "merchant:create")) notFound()

  const stores = await getOnboardingStoreOptions()
  return <NewOnboardingApplication stores={stores} />
}
