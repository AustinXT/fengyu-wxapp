import { NextResponse } from "next/server"
import { generateText, type ModelMessage } from "ai"
import { z } from "zod"
import {
  answerQuestionWithVisualizations,
  buildAssistantDataContext,
  createAssistantSystemPrompt,
  normalizeAssistantResponseForDisplay,
  type AssistantDataContext,
} from "@/lib/assistant-answer"
import {
  normalizeOpenAiSdkEnvironment,
  resolveAiConfig,
  type AnalystAiConfig,
} from "@/lib/assistant-ai-config"
import { getAuthorizedAssistantChatSession } from "@/lib/assistant-chat-auth"
import {
  AssistantChatSessionNotFoundError,
  getRecentAssistantChatMessages,
  persistAssistantChatTurn,
} from "@/lib/assistant-chat-store"
import { logAnalystChat } from "@/lib/operation-log"

const chatTurnSchema = z.object({
  sessionId: z.number().int().positive(),
  content: z.string().trim().min(1).max(4000),
})

interface IncomingMessage {
  role: "user" | "assistant"
  content: string
}

function noStoreJson(payload: unknown, init?: ResponseInit) {
  return NextResponse.json(payload, {
    ...init,
    headers: { "Cache-Control": "no-store", ...init?.headers },
  })
}

function toModelMessages(messages: IncomingMessage[], dataContext: AssistantDataContext): ModelMessage[] {
  const history = messages.slice(0, -1).map((message) => ({
    role: message.role,
    content: message.content,
  }))
  return [
    ...history,
    {
      role: "user",
      content: `用户问题：${dataContext.question}

以下是服务端数据查询工具函数返回的结果，已经按当前用户权限范围过滤。你必须只基于这些结果回答，不要编造数字、名单或排名。

\`\`\`json
${dataContext.toolResult}
\`\`\`

请输出最终结论。若下方会渲染表格或图表，不要在正文重复完整表格；只总结关键发现、对口径差异做简短说明，并指出可查看下方明细。`,
    } satisfies ModelMessage,
  ]
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

async function generateAiContent(
  aiConfig: AnalystAiConfig,
  messages: IncomingMessage[],
  dataContext: AssistantDataContext,
) {
  normalizeOpenAiSdkEnvironment()
  const { createOpenAI } = await import("@ai-sdk/openai")

  const openai = createOpenAI({
    apiKey: aiConfig.apiKey,
    baseURL: aiConfig.baseURL,
    name: aiConfig.provider,
    fetch: aiConfig.provider === "minimax" ? minimaxFetch : undefined,
  })
  const model = aiConfig.provider === "minimax" || aiConfig.baseURL
    ? openai.chat(aiConfig.model)
    : openai(aiConfig.model)

  const result = await generateText({
    model,
    system: `${createAssistantSystemPrompt()}

额外要求：
- 你收到的 JSON 是数据查询工具函数的输出，优先使用其中 deterministicAnswer 和 visualizations 的数值。
- 当 visualizations 里已有 table 时，不要在正文重复完整表格或完整明细表。
- 多指标问题要先回答用户真正问的判断，再说明各指标的关键数字和口径差异。
- 如果某个筛选只适用于其中一个指标，必须明确指出，避免暗示所有指标都套用了同一筛选。`,
    messages: toModelMessages(messages, dataContext),
    temperature: 0.2,
  })

  return result.text.trim()
}

export async function POST(request: Request) {
  const auth = await getAuthorizedAssistantChatSession()
  if (auth instanceof NextResponse) return auth

  const parsed = chatTurnSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return noStoreJson({ error: "INVALID_PARAMS", message: "会话或问题内容无效" }, { status: 400 })
  }

  const { sessionId, content: question } = parsed.data
  // Preserve the old eight-message context budget while deriving all history from the owned server record.
  const history = await getRecentAssistantChatMessages(auth.employeeId, sessionId, 7)
  if (!history) {
    return noStoreJson({ error: "NOT_FOUND", message: "聊天会话不存在" }, { status: 404 })
  }
  const messages: IncomingMessage[] = [...history, { role: "user", content: question }]

  let localResponse
  try {
    localResponse = normalizeAssistantResponseForDisplay(
      await answerQuestionWithVisualizations(auth, question),
    )
  } catch (error) {
    console.error("[analyst.chat] local answer failed", error)
    return noStoreJson({ error: "ANSWER_FAILED", message: "生成回答失败，请稍后重试" }, { status: 500 })
  }

  const aiConfig = resolveAiConfig()
  let response = localResponse
  let hasAiAnswer = false
  let errorType: string | undefined

  if (aiConfig) {
    try {
      const aiContent = await generateAiContent(aiConfig, messages, buildAssistantDataContext(question, localResponse))
      response = normalizeAssistantResponseForDisplay({
        ...localResponse,
        content: aiContent || localResponse.content,
      })
      hasAiAnswer = true
    } catch (error) {
      console.error("[analyst.chat] ai provider failed, using local answer", error)
      errorType = "ai_provider_failed"
    }
  }

  let turn
  try {
    // The transaction writes the question and final answer together, so a failed request never leaves a half-turn.
    turn = await persistAssistantChatTurn({
      ownerEmployeeId: auth.employeeId,
      sessionId,
      question,
      response,
    })
  } catch (error) {
    if (error instanceof AssistantChatSessionNotFoundError) {
      return noStoreJson({ error: "NOT_FOUND", message: "聊天会话不存在" }, { status: 404 })
    }
    throw error
  }

  await logAnalystChat(
    auth,
    question,
    hasAiAnswer,
    response.visualizations.length,
    errorType,
  ).catch((error) => console.error("[analyst.chat] log failed", error))

  return noStoreJson(turn)
}
