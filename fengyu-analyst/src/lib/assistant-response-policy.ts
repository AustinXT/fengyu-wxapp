import type { AnalystAiConfig } from "./assistant-ai-config"
import type { AssistantChatResponse } from "./assistant-types"

export function shouldGenerateAiAssistantContent(
  _localResponse: Pick<AssistantChatResponse, "visualizations">,
  aiConfig: AnalystAiConfig | null,
): aiConfig is AnalystAiConfig {
  // Analyst answers are authoritative server-side query results. An LLM may not
  // replace them because even a well-grounded rewrite can alter business facts.
  // Kill-switch is intentionally constant: the predicate below stays `false`.
  // 恒 false 的类型谓词形同虚设但保留签名——恢复 AI 改写时须同步改
  // assistant-response-policy.test.ts 与 README 的三层锁定说明。
  return false
}
