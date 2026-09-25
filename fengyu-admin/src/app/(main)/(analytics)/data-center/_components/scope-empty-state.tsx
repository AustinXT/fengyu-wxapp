import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import type { ScopeOptionInactiveStore } from "@/lib/data-center/types"

/**
 * 数据中心「不取数」空态：板块页与经营明细报表页（ReportLayout）共用（#293）。
 *
 * - 选中已停用门店 → 明确告知已停用。取数 SQL 会滤掉停用门店的全部数据，照常取数只会满屏 0，
 *   与「在营门店本期无业绩」分不开；在营门店无业绩不走这里，照常显示 0。
 *   出口用链接而不是「请在上方切换」：只有一家在营门店的账号范围下拉是锁定的，板块页也没有「重置」。
 * - 否则 → 非总部账号没有可查看的门店。
 */
export function ScopeEmptyState({
  inactiveStore,
  defaultScopeHref,
}: {
  inactiveStore: ScopeOptionInactiveStore | null
  defaultScopeHref: string | null
}) {
  return (
    <Card>
      <CardContent className="p-8 text-center text-sm text-[var(--muted-foreground)]" data-testid="scope-empty-state">
        {inactiveStore ? (
          <>
            <p className="font-medium text-[var(--foreground)]">「{inactiveStore.storeName}」已停用，无可展示数据</p>
            <p className="mt-2">
              {defaultScopeHref ? (
                <Link href={defaultScopeHref} className="text-[var(--primary)] hover:underline">
                  回到默认范围
                </Link>
              ) : (
                "当前账号没有其它在营门店可查看"
              )}
            </p>
          </>
        ) : (
          "当前账号暂无可查看的数据范围"
        )}
      </CardContent>
    </Card>
  )
}
