import { describe, expect, it } from "vitest"
import { shouldGenerateAiAssistantContent } from "../assistant-response-policy"
import type { AnalystAiConfig } from "../assistant-ai-config"

const aiConfig: AnalystAiConfig = {
  provider: "minimax",
  apiKey: "test-key",
  baseURL: "https://api.minimaxi.com/v1",
  model: "MiniMax-M3",
}

describe("assistant response policy", () => {
  it("uses local response when AI is not configured", () => {
    expect(shouldGenerateAiAssistantContent({ visualizations: [] }, null)).toBe(false)
  })

  it("keeps deterministic wording even when visualizations and AI are available", () => {
    expect(
      shouldGenerateAiAssistantContent(
        {
          visualizations: [
            {
              id: "penetration-kpi",
              kind: "metrics",
              title: "科颜美 普及率",
              metrics: [
                { label: "持卡会员", value: "157 人" },
                { label: "总会员", value: "687 人" },
                { label: "普及率", value: "22.9%" },
              ],
            },
          ],
        },
        aiConfig,
      ),
    ).toBe(false)
  })

  it("does not allow AI to replace a deterministic text-only answer", () => {
    expect(shouldGenerateAiAssistantContent({ visualizations: [] }, aiConfig)).toBe(false)
  })
})
