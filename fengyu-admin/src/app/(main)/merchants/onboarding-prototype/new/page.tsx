import { NewOnboardingApplication } from "../onboarding-prototype"
import { getOnboardingStoreOptions } from "@/actions/lakala-onboarding"

export const dynamic = "force-dynamic"

export default async function Page() {
  const stores = await getOnboardingStoreOptions()
  return <NewOnboardingApplication stores={stores} />
}
