import OnboardingList from "./onboarding-prototype"
import { listOnboardingApplications } from "@/actions/lakala-onboarding"

export const dynamic = "force-dynamic"

export default async function Page() {
  const applications = await listOnboardingApplications()
  return <OnboardingList applications={applications} />
}
