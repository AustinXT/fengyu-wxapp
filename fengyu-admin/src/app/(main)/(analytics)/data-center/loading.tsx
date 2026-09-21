import { BoardPageSkeleton } from "@/components/ui/page-skeleton"

/**
 * 板块切换现在是整页导航（4 个板块各占一条路径），首屏要等 getDataCenterScopeOptions 的两条查询。
 * 没有这个边界的话，点侧边栏后页面会停在旧板块上无任何反馈——改造前的页内 Tab 不存在这个问题。
 */
export default function Loading() {
  return <BoardPageSkeleton />
}
