/**
 * 新建拉卡拉商户入网申请（plan §4）
 * 仅必填 merchantName，createDraft action 自动分配 out_org_code。
 * 权限：lakala:onboarding:create（action 内 withPermission 闸门）
 */
import NewLakalaMerchantForm from "./_form"

export const dynamic = "force-dynamic"

export default function Page() {
  return <NewLakalaMerchantForm />
}
