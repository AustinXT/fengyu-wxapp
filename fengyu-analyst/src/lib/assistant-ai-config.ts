export const MINIMAX_DEFAULT_BASE_URL = "https://api.minimaxi.com/v1"
export const MINIMAX_DEFAULT_MODEL = "MiniMax-M3"

export interface AnalystAiConfig {
  provider: "minimax" | "openai"
  apiKey: string
  baseURL: string | undefined
  model: string
}

type EnvLike = Record<string, string | undefined>

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function normalizeOpenAiSdkEnvironment(env: EnvLike = process.env): void {
  if (env.OPENAI_BASE_URL !== undefined && !optionalEnv(env.OPENAI_BASE_URL)) {
    delete env.OPENAI_BASE_URL
  }
}

export function resolveAiConfig(env: EnvLike = process.env): AnalystAiConfig | null {
  const minimaxApiKey = optionalEnv(env.MINIMAX_API_KEY)
  if (minimaxApiKey) {
    return {
      provider: "minimax",
      apiKey: minimaxApiKey,
      baseURL: optionalEnv(env.MINIMAX_BASE_URL) ?? MINIMAX_DEFAULT_BASE_URL,
      model: optionalEnv(env.MINIMAX_MODEL) ?? optionalEnv(env.OPENAI_MODEL) ?? MINIMAX_DEFAULT_MODEL,
    }
  }

  const openaiApiKey = optionalEnv(env.OPENAI_API_KEY)
  if (openaiApiKey) {
    return {
      provider: "openai",
      apiKey: openaiApiKey,
      baseURL: optionalEnv(env.OPENAI_BASE_URL),
      model: optionalEnv(env.OPENAI_MODEL) ?? "gpt-4o-mini",
    }
  }

  return null
}
