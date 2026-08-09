import { NextResponse } from "next/server"
import { z } from "zod"
import { getAuthorizedAssistantChatSession } from "@/lib/assistant-chat-auth"
import {
  deleteAssistantChatSession,
  getAssistantChatSession,
  renameAssistantChatSession,
} from "@/lib/assistant-chat-store"

const renameSchema = z.object({ title: z.string().trim().min(1).max(100) })

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

function noStoreJson(payload: unknown, init?: ResponseInit) {
  return NextResponse.json(payload, {
    ...init,
    headers: { "Cache-Control": "no-store", ...init?.headers },
  })
}

async function parseSessionId(context: RouteContext): Promise<number | null> {
  const { sessionId } = await context.params
  const parsed = Number(sessionId)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export async function GET(_request: Request, context: RouteContext) {
  const auth = await getAuthorizedAssistantChatSession()
  if (auth instanceof NextResponse) return auth

  const sessionId = await parseSessionId(context)
  if (!sessionId) return noStoreJson({ error: "INVALID_PARAMS", message: "会话 ID 无效" }, { status: 400 })

  const session = await getAssistantChatSession(auth.employeeId, sessionId)
  if (!session) return noStoreJson({ error: "NOT_FOUND", message: "聊天会话不存在" }, { status: 404 })
  return noStoreJson({ session })
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getAuthorizedAssistantChatSession()
  if (auth instanceof NextResponse) return auth

  const sessionId = await parseSessionId(context)
  if (!sessionId) return noStoreJson({ error: "INVALID_PARAMS", message: "会话 ID 无效" }, { status: 400 })

  const parsed = renameSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return noStoreJson({ error: "INVALID_PARAMS", message: "会话标题无效" }, { status: 400 })
  }

  const session = await renameAssistantChatSession(auth.employeeId, sessionId, parsed.data.title)
  if (!session) return noStoreJson({ error: "NOT_FOUND", message: "聊天会话不存在" }, { status: 404 })
  return noStoreJson({ session })
}

export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await getAuthorizedAssistantChatSession()
  if (auth instanceof NextResponse) return auth

  const sessionId = await parseSessionId(context)
  if (!sessionId) return noStoreJson({ error: "INVALID_PARAMS", message: "会话 ID 无效" }, { status: 400 })

  const deleted = await deleteAssistantChatSession(auth.employeeId, sessionId)
  if (!deleted) return noStoreJson({ error: "NOT_FOUND", message: "聊天会话不存在" }, { status: 404 })
  return noStoreJson({ success: true })
}
