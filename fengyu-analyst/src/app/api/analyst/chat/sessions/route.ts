import { NextResponse } from "next/server"
import {
  ASSISTANT_CHAT_PAGE_SIZE,
  createAssistantChatSession,
  listAssistantChatSessions,
  parseAssistantChatCursor,
} from "@/lib/assistant-chat-store"
import { getAuthorizedAssistantChatSession } from "@/lib/assistant-chat-auth"

function noStoreJson(payload: unknown, init?: ResponseInit) {
  return NextResponse.json(payload, {
    ...init,
    headers: { "Cache-Control": "no-store", ...init?.headers },
  })
}

function parseLimit(value: string | null): number | null {
  if (!value) return ASSISTANT_CHAT_PAGE_SIZE
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > ASSISTANT_CHAT_PAGE_SIZE) return null
  return parsed
}

export async function GET(request: Request) {
  const auth = await getAuthorizedAssistantChatSession()
  if (auth instanceof NextResponse) return auth

  const { searchParams } = new URL(request.url)
  const rawCursor = searchParams.get("cursor")
  const cursor = parseAssistantChatCursor(rawCursor)
  const limit = parseLimit(searchParams.get("limit"))
  if ((rawCursor && !cursor) || limit === null) {
    return noStoreJson({ error: "INVALID_PARAMS", message: "分页参数无效" }, { status: 400 })
  }

  const page = await listAssistantChatSessions(auth.employeeId, cursor, limit)
  return noStoreJson(page)
}

export async function POST() {
  const auth = await getAuthorizedAssistantChatSession()
  if (auth instanceof NextResponse) return auth

  const session = await createAssistantChatSession(auth.employeeId)
  return noStoreJson({ session }, { status: 201 })
}
