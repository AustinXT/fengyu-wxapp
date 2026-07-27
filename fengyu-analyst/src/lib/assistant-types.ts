export type AssistantMessageRole = "user" | "assistant"

export interface AssistantChartRow {
  [key: string]: string | number | null
}

export interface AssistantTableColumn {
  key: string
  label: string
  align?: "left" | "right"
}

export interface AssistantMetricValue {
  label: string
  value: string
  helper?: string
}

export type AssistantVisualizationKind = "metrics" | "line" | "bar" | "funnel" | "table"

export interface AssistantVisualization {
  id: string
  kind: AssistantVisualizationKind
  title: string
  labelKey?: string
  valueKey?: string
  valueFormat?: "rate" | "number" | "text"
  rows?: AssistantChartRow[]
  columns?: AssistantTableColumn[]
  metrics?: AssistantMetricValue[]
}

export interface AssistantChatResponse {
  content: string
  visualizations: AssistantVisualization[]
}
