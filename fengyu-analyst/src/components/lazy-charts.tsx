"use client"

import dynamic from "next/dynamic"
import type { ComponentProps } from "react"
import type { NewCustomerBarChart as NewCustomerBarChartType, NewCustomerFunnelChart as NewCustomerFunnelChartType } from "@/components/new-customer-funnel-charts"
import type { PenetrationBarChart as PenetrationBarChartType } from "@/components/penetration-charts"
import type { RankingBarChart as RankingBarChartType, TrendChart as TrendChartType } from "@/components/repurchase-charts"

const loading = () => <div className="h-[260px] animate-pulse rounded-md bg-neutral-100" aria-label="图表加载中" />

export const NewCustomerBarChart = dynamic<ComponentProps<typeof NewCustomerBarChartType>>(
  () => import("@/components/new-customer-funnel-charts").then((module) => module.NewCustomerBarChart),
  { ssr: false, loading },
)
export const NewCustomerFunnelChart = dynamic<ComponentProps<typeof NewCustomerFunnelChartType>>(
  () => import("@/components/new-customer-funnel-charts").then((module) => module.NewCustomerFunnelChart),
  { ssr: false, loading },
)
export const PenetrationBarChart = dynamic<ComponentProps<typeof PenetrationBarChartType>>(
  () => import("@/components/penetration-charts").then((module) => module.PenetrationBarChart),
  { ssr: false, loading },
)
export const RankingBarChart = dynamic<ComponentProps<typeof RankingBarChartType>>(
  () => import("@/components/repurchase-charts").then((module) => module.RankingBarChart),
  { ssr: false, loading },
)
export const TrendChart = dynamic<ComponentProps<typeof TrendChartType>>(
  () => import("@/components/repurchase-charts").then((module) => module.TrendChart),
  { ssr: false, loading },
)
