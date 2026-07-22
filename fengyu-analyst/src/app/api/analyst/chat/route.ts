import { NextResponse } from "next/server"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText, stepCountIs, type ModelMessage } from "ai"
import {
  answerQuestionWithVisualizations,
  createAssistantSystemPrompt,
  createRepurchaseTools,
} from "@/lib/assistant-answer"
import { getSession } from "@/lib/auth"
import { hasPermission } from "@/lib/permissions"

const CHAT_ACTION = process.env.ANALYST_CHAT_ACTION || process.env.ANALYST_VIEW_ACTION || "data_center:dashboard"
const MINIMAX_DEFAULT_BASE_URL = "https://api.minimaxi.com/v1"
const MINIMAX_DEFAULT_MODEL = "MiniMax-M3"

interface IncomingMessage {
  role: "user" | "assistant"
  content: string
}

function normalizeMessages(input: unknown): IncomingMessage[] {
  if (!Array.isArray(input)) return []
  return input
    .map((message) => {
      const role = (message as { role?: unknown }).role
      const content = (message as { content?: unknown }).content
      if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null
      return { role, content: content.trim() }
    })
    .filter((message): message is IncomingMessage => Boolean(message?.content))
    .slice(-8)
}

function toModelMessages(messages: IncomingMessage[]): ModelMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }))
}

function resolveAiConfig():
  | { provider: "minimax" | "openai"; apiKey: string; baseURL: string | undefined; model: string }
  | null {
  if (process.env.MINIMAX_API_KEY) {
    return {
      provider: "minimax",
      apiKey: process.env.MINIMAX_API_KEY,
      baseURL: process.env.MINIMAX_BASE_URL || MINIMAX_DEFAULT_BASE_URL,
      model: process.env.MINIMAX_MODEL || process.env.OPENAI_MODEL || MINIMAX_DEFAULT_MODEL,
    }
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    }
  }

  return null
}

const minimaxFetch: typeof fetch = async (input, init) => {
  if (typeof init?.body !== "string") return fetch(input, init)

  try {
    const body = JSON.parse(init.body) as Record<string, unknown>
    return fetch(input, {
      ...init,
      body: JSON.stringify({
        ...body,
        thinking: body.thinking ?? { type: "disabled" },
      }),
    })
  } catch {
    return fetch(input, init)
  }
}

export async function POST(request: Request) {
  const session = await getSession()

  if (!session) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 })
  }

  if (!hasPermission(session, CHAT_ACTION)) {
    return NextResponse.json({ error: "PERMISSION_DENIED" }, { status: 403 })
  }

  const body = (await request.json().catch(() => null)) as { messages?: unknown } | null
  const messages = normalizeMessages(body?.messages)
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user")

  if (!lastUserMessage) {
    return NextResponse.json({ error: "INVALID_PARAMS", message: "缺少用户问题" }, { status: 400 })
  }

  const aiConfig = resolveAiConfig()
  const localResponse = await answerQuestionWithVisualizations(session, lastUserMessage.content)

  if (!aiConfig) {
    return NextResponse.json(localResponse, {
      headers: { "Cache-Control": "no-store" },
    })
  }

  const openai = createOpenAI({
    apiKey: aiConfig.apiKey,
    baseURL: aiConfig.baseURL,
    name: aiConfig.provider,
    fetch: aiConfig.provider === "minimax" ? minimaxFetch : undefined,
  })

  try {
    const result = await generateText({
      model: openai(aiConfig.model),
      system: createAssistantSystemPrompt(),
      messages: toModelMessages(messages),
      tools: createRepurchaseTools(session),
      stopWhen: stepCountIs(4),
      temperature: 0.2,
    })

    return NextResponse.json(
      {
        ...localResponse,
        content: result.text.trim() || localResponse.content,
      },
      {
        headers: { "Cache-Control": "no-store" },
      },
    )
  } catch (error) {
    console.error("[analyst.chat] ai provider failed, using local answer", error)
    return NextResponse.json(localResponse, {
      headers: { "Cache-Control": "no-store" },
    })
  }
}
