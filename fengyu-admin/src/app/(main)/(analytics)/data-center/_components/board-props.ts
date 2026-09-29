import type { StoreDataStarts } from "@/lib/data-center/data-start"
import type { DataCenterScopeOptions } from "@/lib/data-center/types"

/** 板块组件从板块页（`[board]/page.tsx`）拿到的服务端数据（不需要的板块忽略即可） */
export interface BoardPageProps {
  scopeOptions: DataCenterScopeOptions
  /** 各门店数据起点；只给需要数据起点提示的板块取（#289），其余为 null */
  dataStarts: StoreDataStarts | null
}
