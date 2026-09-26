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
  // 另：工具入参点名不可见 / 歧义的门店市场时会抛 NOT_FOUND（#436），恢复时须让这类
  // 工具错误回到模型或转成拒答文案，不能冒泡成 chat route 的整体 500。
  return false
}
