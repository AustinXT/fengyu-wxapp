import "server-only"

import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm"
import { db } from "@/db"
import { analystChatMessages, analystChatSessions } from "@db/analyst-chat"
import {
  DEFAULT_ASSISTANT_CHAT_TITLE,
  normalizeAssistantVisualizations,
  titleFromAssistantQuestion,
  type AssistantChatMessage,
  type AssistantChatResponse,
  type AssistantChatSessionDetail,
  type AssistantChatSessionSummary,
  type AssistantChatTurnResponse,
  type AssistantMessageRole,
} from "@/lib/assistant-types"

export const ASSISTANT_CHAT_PAGE_SIZE = 30

export class AssistantChatSessionNotFoundError extends Error {
  constructor() {
    super("聊天会话不存在")
    this.name = "AssistantChatSessionNotFoundError"
  }
}

interface SessionCursor {
  updatedAt: Date
  id: number
}

interface StoredSession {
  id: number
  title: string
  createdAt: Date
  updatedAt: Date
}

interface StoredMessage {
  id: number
  role: string
  content: string
  visualizations: unknown
  createdAt: Date
}

function toIso(value: Date): string {
  return value.toISOString()
}

function toMessage(message: StoredMessage): AssistantChatMessage {
  return {
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    content: message.content,
    visualizations: normalizeAssistantVisualizations(message.visualizations),
    createdAt: toIso(message.createdAt),
  }
}

function toSessionSummary(session: StoredSession, messageCount: number): AssistantChatSessionSummary {
  return {
    id: session.id,
    title: session.title,
    messageCount,
    createdAt: toIso(session.createdAt),
    updatedAt: toIso(session.updatedAt),
  }
}

function encodeCursor(session: StoredSession): string {
  return `${session.updatedAt.getTime()}:${session.id}`
}

export function parseAssistantChatCursor(cursor: string | null): SessionCursor | null {
  if (!cursor) return null
  const [timestampText, idText] = cursor.split(":", 2)
  const timestamp = Number(timestampText)
  const id = Number(idText)
  if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(id) || id < 1) return null
  const updatedAt = new Date(timestamp)
  if (Number.isNaN(updatedAt.getTime())) return null
  return { updatedAt, id }
}

export async function listAssistantChatSessions(
  ownerEmployeeId: string,
  cursor: SessionCursor | null,
  limit = ASSISTANT_CHAT_PAGE_SIZE,
): Promise<{ sessions: AssistantChatSessionSummary[]; nextCursor: string | null }> {
  const conditions = [eq(analystChatSessions.ownerEmployeeId, ownerEmployeeId)]
  if (cursor) {
    conditions.push(
      or(
        lt(analystChatSessions.updatedAt, cursor.updatedAt),
        and(
          eq(analystChatSessions.updatedAt, cursor.updatedAt),
          lt(analystChatSessions.id, cursor.id),
        ),
      )!,
    )
  }

  const rows = await db
    .select({
      id: analystChatSessions.id,
      title: analystChatSessions.title,
      createdAt: analystChatSessions.createdAt,
      updatedAt: analystChatSessions.updatedAt,
      messageCount: sql<number>`cast(count(${analystChatMessages.id}) as int)`,
    })
    .from(analystChatSessions)
    .leftJoin(analystChatMessages, eq(analystChatMessages.sessionId, analystChatSessions.id))
    .where(and(...conditions))
    .groupBy(analystChatSessions.id)
    .orderBy(desc(analystChatSessions.updatedAt), desc(analystChatSessions.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page.at(-1)

  return {
    sessions: page.map((session) =>
      toSessionSummary(session, Number.isFinite(session.messageCount) ? session.messageCount : 0),
    ),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  }
}

export async function createAssistantChatSession(ownerEmployeeId: string): Promise<AssistantChatSessionSummary> {
  const now = new Date()
  const [session] = await db
    .insert(analystChatSessions)
    .values({
      ownerEmployeeId,
      title: DEFAULT_ASSISTANT_CHAT_TITLE,
      createdAt: now,
      updatedAt: now,
    })
    .returning({
      id: analystChatSessions.id,
      title: analystChatSessions.title,
      createdAt: analystChatSessions.createdAt,
      updatedAt: analystChatSessions.updatedAt,
    })

  if (!session) throw new Error("创建聊天会话失败")
  return toSessionSummary(session, 0)
}

export async function getAssistantChatSession(
  ownerEmployeeId: string,
  sessionId: number,
): Promise<AssistantChatSessionDetail | null> {
  const [session] = await db
    .select({
      id: analystChatSessions.id,
      title: analystChatSessions.title,
      createdAt: analystChatSessions.createdAt,
      updatedAt: analystChatSessions.updatedAt,
    })
    .from(analystChatSessions)
    .where(and(eq(analystChatSessions.id, sessionId), eq(analystChatSessions.ownerEmployeeId, ownerEmployeeId)))
    .limit(1)

  if (!session) return null

  const messageRows = await db
    .select({
      id: analystChatMessages.id,
      role: analystChatMessages.role,
      content: analystChatMessages.content,
      visualizations: analystChatMessages.visualizations,
      createdAt: analystChatMessages.createdAt,
    })
    .from(analystChatMessages)
    .where(eq(analystChatMessages.sessionId, session.id))
    .orderBy(asc(analystChatMessages.id))

  return {
    ...toSessionSummary(session, messageRows.length),
    messages: messageRows.map(toMessage),
  }
}

export async function getRecentAssistantChatMessages(
  ownerEmployeeId: string,
  sessionId: number,
  limit: number,
): Promise<Array<Pick<AssistantChatMessage, "role" | "content">> | null> {
  const [session] = await db
    .select({ id: analystChatSessions.id })
    .from(analystChatSessions)
    .where(and(eq(analystChatSessions.id, sessionId), eq(analystChatSessions.ownerEmployeeId, ownerEmployeeId)))
    .limit(1)
  if (!session) return null

  const rows = await db
    .select({ role: analystChatMessages.role, content: analystChatMessages.content })
    .from(analystChatMessages)
    .where(eq(analystChatMessages.sessionId, session.id))
    .orderBy(desc(analystChatMessages.id))
    .limit(limit)

  return rows.reverse().map((message) => ({
    role: (message.role === "user" ? "user" : "assistant") as AssistantMessageRole,
    content: message.content,
  }))
}

export async function renameAssistantChatSession(
  ownerEmployeeId: string,
  sessionId: number,
  title: string,
): Promise<AssistantChatSessionSummary | null> {
  const [session] = await db
    .update(analystChatSessions)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(analystChatSessions.id, sessionId), eq(analystChatSessions.ownerEmployeeId, ownerEmployeeId)))
    .returning({
      id: analystChatSessions.id,
      title: analystChatSessions.title,
      createdAt: analystChatSessions.createdAt,
      updatedAt: analystChatSessions.updatedAt,
    })

  return session ? toSessionSummary(session, await countAssistantChatMessages(session.id)) : null
}

export async function deleteAssistantChatSession(ownerEmployeeId: string, sessionId: number): Promise<boolean> {
  const rows = await db
    .delete(analystChatSessions)
    .where(and(eq(analystChatSessions.id, sessionId), eq(analystChatSessions.ownerEmployeeId, ownerEmployeeId)))
    .returning({ id: analystChatSessions.id })
  return rows.length > 0
}

async function countAssistantChatMessages(sessionId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`cast(count(${analystChatMessages.id}) as int)` })
    .from(analystChatMessages)
    .where(eq(analystChatMessages.sessionId, sessionId))
  return row?.count ?? 0
}

export async function persistAssistantChatTurn({
  ownerEmployeeId,
  sessionId,
  question,
  response,
  expectedMessageCount,
}: {
  ownerEmployeeId: string
  sessionId: number
  question: string
  response: AssistantChatResponse
  expectedMessageCount?: number
}): Promise<AssistantChatTurnResponse> {
  const now = new Date()
  const generatedTitle = titleFromAssistantQuestion(question)

  return db.transaction(async (tx) => {
    // Updating the owner-scoped parent first locks it for the rest of the turn and rejects deleted sessions.
    const [session] = await tx
      .update(analystChatSessions)
      .set({
        title: sql`case when ${analystChatSessions.title} = ${DEFAULT_ASSISTANT_CHAT_TITLE} then ${generatedTitle} else ${analystChatSessions.title} end`,
        updatedAt: now,
      })
      .where(and(eq(analystChatSessions.id, sessionId), eq(analystChatSessions.ownerEmployeeId, ownerEmployeeId)))
      .returning({
        id: analystChatSessions.id,
        title: analystChatSessions.title,
        createdAt: analystChatSessions.createdAt,
        updatedAt: analystChatSessions.updatedAt,
      })

    if (!session) throw new AssistantChatSessionNotFoundError()

    // Guard against TOCTOU: verify no concurrent turn was inserted since the caller read history.
    if (expectedMessageCount !== undefined) {
      const [countBefore] = await tx
        .select({ count: sql<number>`cast(count(${analystChatMessages.id}) as int)` })
        .from(analystChatMessages)
        .where(eq(analystChatMessages.sessionId, session.id))
      if ((countBefore?.count ?? 0) !== expectedMessageCount) {
        throw new Error('CONFLICT: CHAT_SESSION_STALE: 会话状态已变更，请重试')
      }
    }

    const [userMessage] = await tx
      .insert(analystChatMessages)
      .values({ sessionId, role: "user", content: question, visualizations: null, createdAt: now })
      .returning({
        id: analystChatMessages.id,
        role: analystChatMessages.role,
        content: analystChatMessages.content,
        visualizations: analystChatMessages.visualizations,
        createdAt: analystChatMessages.createdAt,
      })
    const [assistantMessage] = await tx
      .insert(analystChatMessages)
      .values({
        sessionId,
        role: "assistant",
        content: response.content,
        visualizations: response.visualizations,
        createdAt: now,
      })
      .returning({
        id: analystChatMessages.id,
        role: analystChatMessages.role,
        content: analystChatMessages.content,
        visualizations: analystChatMessages.visualizations,
        createdAt: analystChatMessages.createdAt,
      })
    const [count] = await tx
      .select({ count: sql<number>`cast(count(${analystChatMessages.id}) as int)` })
      .from(analystChatMessages)
      .where(eq(analystChatMessages.sessionId, session.id))

    if (!userMessage || !assistantMessage) throw new Error("保存聊天消息失败")

    return {
      session: toSessionSummary(session, count?.count ?? 0),
      userMessage: toMessage(userMessage),
      assistantMessage: toMessage(assistantMessage),
    }
  })
}
