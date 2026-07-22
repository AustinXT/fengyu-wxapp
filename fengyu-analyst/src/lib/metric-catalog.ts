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
        id: "metric-02",
        label: "指标 02",
        group: "顾客经营",
        description: "预留指标位。",
        href: "/dashboard?metric=metric-02",
        status: "planned",
      },
      {
        id: "metric-03",
        label: "指标 03",
        group: "顾客经营",
        description: "预留指标位。",
        href: "/dashboard?metric=metric-03",
        status: "planned",
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
