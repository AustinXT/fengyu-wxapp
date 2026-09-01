import type { AnalystAiConfig } from "./assistant-ai-config"
import type { AssistantChatResponse } from "./assistant-types"

export function shouldGenerateAiAssistantContent(
  _localResponse: Pick<AssistantChatResponse, "visualizations">,
  aiConfig: AnalystAiConfig | null,
): aiConfig is AnalystAiConfig {
  // Analyst answers are authoritative server-side query results. An LLM may not
  // replace them because even a well-grounded rewrite can alter business facts.
  return false
}
