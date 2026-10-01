import { unstable_rethrow } from "next/navigation"
import { getDataStartDates } from "@/actions/data-center/shared"
import type { StoreDataStarts } from "@/lib/data-center/data-start"

/**
 * 服务端取各门店数据起点（#367 报表页 / #289 客量板共用）。
 *
 * 数据起点只是辅助提示：取数失败时降级为不提示，不能把整个页面变成错误页。
 * 页面的权限闸门由各自的 scope 数据源承担（它先于或同时 reject），这里吞掉的不会是页面级的 403。
 */
export function loadDataStartsSafely(): Promise<StoreDataStarts> {
  return getDataStartDates().catch((error: unknown): StoreDataStarts => {
    unstable_rethrow(error) // 会话过期的登录跳转等 Next 控制流错误照常上抛
    console.error("[data-center] 数据起点取数失败，本次不显示提示", error)
    return {}
  })
}
