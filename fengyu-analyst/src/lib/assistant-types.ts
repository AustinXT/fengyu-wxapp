export type AssistantMessageRole = "user" | "assistant"

export const DEFAULT_ASSISTANT_CHAT_TITLE = "新对话"

export function titleFromAssistantQuestion(question: string): string {
  const compact = question.replace(/\s+/g, " ").trim()
  return compact.length > 22 ? `${compact.slice(0, 22)}...` : compact || DEFAULT_ASSISTANT_CHAT_TITLE
}

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

export interface AssistantChatMessage {
  id: number
  role: AssistantMessageRole
  content: string
  visualizations: AssistantVisualization[]
  createdAt: string
}

export interface AssistantChatSessionSummary {
  id: number
  title: string
  messageCount: number
  createdAt: string
  updatedAt: string
}

export interface AssistantChatSessionDetail extends AssistantChatSessionSummary {
  messages: AssistantChatMessage[]
}

export interface AssistantChatTurnResponse {
  session: AssistantChatSessionSummary
  userMessage: AssistantChatMessage
  assistantMessage: AssistantChatMessage
}

export function normalizeAssistantVisualizations(input: unknown): AssistantVisualization[] {
  if (!Array.isArray(input)) return []
  return input.filter((item): item is AssistantVisualization => {
    if (!item || typeof item !== "object") return false
    const visualization = item as Partial<AssistantVisualization>
    return (
      typeof visualization.id === "string" &&
      (visualization.kind === "metrics" ||
        visualization.kind === "line" ||
        visualization.kind === "bar" ||
        visualization.kind === "funnel" ||
        visualization.kind === "table") &&
      typeof visualization.title === "string"
    )
  })
}
