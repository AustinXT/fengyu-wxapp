export type MetricStatus = "available" | "planned"

export interface AnalystMetric {
  id: string
  label: string
  group: string
  description: string
  href: string
  status: MetricStatus
}

export interface AnalystMetricGroup {
  id: string
  label: string
  metrics: AnalystMetric[]
}

export const metricGroups: AnalystMetricGroup[] = [
  {
    id: "customer",
    label: "顾客经营",
    metrics: [
      {
        id: "repurchase",
        label: "复购率",
        group: "顾客经营",
        description: "进入人数、复购人数、复购率和组织/品项对比。",
        href: "/dashboard?metric=repurchase",
        status: "available",
      },
      {
        id: "penetration",
        label: "普及率",
        group: "顾客经营",
        description: "持有未用完疗程卡的会员数、总会员数和品项/组织普及率。",
        href: "/dashboard?metric=penetration",
        status: "available",
      },
      {
        id: "new-customer-funnel",
        label: "新客漏斗",
        group: "顾客经营",
        description: "新客来源、T+90 到店、会员成交和年度贡献。",
        href: "/dashboard?metric=new-customer-funnel",
        status: "available",
      },
    ],
  },
  {
    id: "sales",
    label: "销售经营",
    metrics: [
      {
        id: "metric-04",
        label: "指标 04",
        group: "销售经营",
        description: "预留指标位。",
        href: "/dashboard?metric=metric-04",
        status: "planned",
      },
      {
        id: "metric-05",
        label: "指标 05",
        group: "销售经营",
        description: "预留指标位。",
        href: "/dashboard?metric=metric-05",
        status: "planned",
      },
      {
        id: "metric-06",
        label: "指标 06",
        group: "销售经营",
        description: "预留指标位。",
        href: "/dashboard?metric=metric-06",
        status: "planned",
      },
    ],
  },
  {
    id: "service",
    label: "服务经营",
    metrics: [
      {
        id: "metric-07",
        label: "指标 07",
        group: "服务经营",
        description: "预留指标位。",
        href: "/dashboard?metric=metric-07",
        status: "planned",
      },
      {
        id: "metric-08",
        label: "指标 08",
        group: "服务经营",
        description: "预留指标位。",
        href: "/dashboard?metric=metric-08",
        status: "planned",
      },
    ],
  },
  {
    id: "organization",
    label: "组织效率",
    metrics: [
      {
        id: "metric-09",
        label: "指标 09",
        group: "组织效率",
        description: "预留指标位。",
        href: "/dashboard?metric=metric-09",
        status: "planned",
      },
      {
        id: "metric-10",
        label: "指标 10",
        group: "组织效率",
        description: "预留指标位。",
        href: "/dashboard?metric=metric-10",
        status: "planned",
      },
    ],
  },
]

export const allMetrics = metricGroups.flatMap((group) => group.metrics)

export function getMetric(metricId: string | undefined): AnalystMetric {
  return allMetrics.find((metric) => metric.id === metricId) ?? allMetrics[0]
}
