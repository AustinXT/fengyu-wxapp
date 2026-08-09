import type { AnalystAiConfig } from "./assistant-ai-config"
import type { AssistantChatResponse } from "./assistant-types"

export function shouldGenerateAiAssistantContent(
  _localResponse: Pick<AssistantChatResponse, "visualizations">,
  aiConfig: AnalystAiConfig | null,
): aiConfig is AnalystAiConfig {
  return Boolean(aiConfig)
}
