import "server-only"

import { db } from "@/db"
import { operationLogs } from "@db/operation-log"
import type { AuthSession } from "./types"
import { sanitizeDetail } from "./pii"

/**
 * 写入操作日志
 *
 * orgNodeId/orgNodeName 从 session 的主要角色 scopeId 中获取
 */
export async function logOperation(
  session: AuthSession,
  action: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
) {
  const primaryRole = session.roles[0]

  // 从角色 scope 中获取组织节点上下文
  let orgNodeId: string | null = null
  let orgNodeName: string | null = null
  if (primaryRole?.scopeId) {
    try {
      const { orgNodes } = await import("@db/org")
      const { eq } = await import("drizzle-orm")
      const [node] = await db
        .select({ id: orgNodes.id, name: orgNodes.name })
        .from(orgNodes)
        .where(eq(orgNodes.id, primaryRole.scopeId))
        .limit(1)
      if (node) {
        orgNodeId = node.id
        orgNodeName = node.name
      }
    } catch {
      // 查询失败不影响日志写入
    }
  }

  await db.insert(operationLogs).values({
    operatorEmployeeId: session.employeeId,
    operatorName: session.name,
    operatorRole: primaryRole?.role ?? null,
    orgNodeId,
    orgNodeName,
    action,
    targetType,
    targetId,
    detail: detail ? sanitizeDetail(detail) : null,
    source: "analystApi",
  })
}

/**
 * 写入 analyst 智能助手对话日志
 *
 * detail 格式：{ _v: 1, _t: 'chat', question, hasAiAnswer, errorType?, visualizationCount }
 */
export async function logAnalystChat(
  session: AuthSession,
  question: string,
  hasAiAnswer: boolean,
  visualizationCount: number,
  errorType?: string,
) {
  // 使用时间戳作为 targetId，确保唯一性
  const targetId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

  await logOperation(session, "analyst.chat", "analyst_chat", targetId, {
    _v: 1,
    _t: "chat",
    question: question.slice(0, 500), // 限制问题长度避免过长
    hasAiAnswer,
    visualizationCount,
    ...(errorType ? { errorType } : {}),
  })
}
