import { redirect } from "next/navigation"
import { parseTab } from "@/lib/data-center/params"

export const dynamic = "force-dynamic"

/**
 * 数据中心裸路径：4 个板块已提升为侧边栏二级菜单（各自独立路径），本页只做跳转。
 * 仍读 `?tab=` 是为了兜住旧深链/书签（`/data-center?tab=customer` → `/data-center/customer`）；
 * 无 tab 或非法 tab 落到销售。其余 query（scope/preset/cmp…）原样带走。
 *
 * 权限闸门在板块页（getDataCenterScopeOptions），此处不重复查库。
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const query = await searchParams
  const board = parseTab(query.tab)
  const next = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v == null || k === "tab") continue
    next.set(k, v)
  }
  const qs = next.toString()
  redirect(`/data-center/${board}${qs ? `?${qs}` : ""}`)
}
