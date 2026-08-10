import { describe, expect, it } from "vitest"
import {
  MINIMAX_DEFAULT_BASE_URL,
  MINIMAX_DEFAULT_MODEL,
  normalizeOpenAiSdkEnvironment,
  resolveAiConfig,
} from "../assistant-ai-config"

describe("assistant ai config", () => {
  it("uses Minimax defaults when optional env values are blank", () => {
    expect(
      resolveAiConfig({
        MINIMAX_API_KEY: " minimax-key ",
        MINIMAX_BASE_URL: "",
        MINIMAX_MODEL: " ",
        OPENAI_MODEL: "",
      }),
    ).toEqual({
      provider: "minimax",
      apiKey: "minimax-key",
      baseURL: MINIMAX_DEFAULT_BASE_URL,
      model: MINIMAX_DEFAULT_MODEL,
    })
  })

  it("treats blank OpenAI values as missing config", () => {
    expect(
      resolveAiConfig({
        OPENAI_API_KEY: " openai-key ",
        OPENAI_BASE_URL: " ",
        OPENAI_MODEL: "",
      }),
    ).toEqual({
      provider: "openai",
      apiKey: "openai-key",
      baseURL: undefined,
      model: "gpt-4o-mini",
    })
  })

  it("removes blank OPENAI_BASE_URL before loading the AI SDK OpenAI provider", () => {
    const env = { OPENAI_BASE_URL: "" }
    normalizeOpenAiSdkEnvironment(env)
    expect(env).not.toHaveProperty("OPENAI_BASE_URL")
  })
})
