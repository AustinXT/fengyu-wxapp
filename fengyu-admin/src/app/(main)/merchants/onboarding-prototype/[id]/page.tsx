import { notFound } from "next/navigation"
import { getOnboardingApplication } from "@/actions/lakala-onboarding"
import { OnboardingEditor } from "../onboarding-prototype"

export const dynamic = "force-dynamic"

type Params = { params: Promise<{ id: string }> }

export default async function Page({ params }: Params) {
  const { id } = await params
  const application = await getOnboardingApplication(id)
  if (!application) notFound()
  return <OnboardingEditor application={application} />
}
