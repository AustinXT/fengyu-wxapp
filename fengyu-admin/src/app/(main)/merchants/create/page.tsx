import { notFound } from "next/navigation"
import { getSession } from "@/lib/auth"
import { hasPermission } from "@/lib/permissions"
import MerchantForm from "../_components/merchant-form"

export const dynamic = "force-dynamic"

export default async function Page() {
  // SSR 闸门：表单无 SSR 数据查询，故显式校验 merchant:create（防非授权用户直达空表单）
  const session = await getSession()
  if (!session || !hasPermission(session, "merchant:create")) notFound()
  return <MerchantForm />
}
